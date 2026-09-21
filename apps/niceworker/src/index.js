import path from 'path';
import { config } from './config.js';
import { discordClient } from './discord/client.js';
import { DiscordGateway } from './discord/gateway.js';
import { registerCommands } from './discord/commands.js';
import { createInteractionHandler } from './discord/interactionHandler.js';
import { MuteRegistry } from './pomodoro/muteRegistry.js';
import { PhaseDisplay } from './pomodoro/display.js';
import { PomodoroManager } from './pomodoro/manager.js';
import { CallScheduler } from './call/scheduler.js';
import { logger } from './utils/logger.js';

const gateway = new DiscordGateway(discordClient, {
  guildId: config.discord.guildId,
  announceChannelId: config.discord.announceChannelId,
});

const registry = new MuteRegistry(
  path.join(config.state.dir, 'muted-members.json'),
  logger,
);

const display = new PhaseDisplay({
  gateway,
  vcChannelId: config.discord.pomodoroVcId,
  logger,
});

const pomodoro = new PomodoroManager({
  gateway,
  registry,
  display,
  logger,
  vcChannelId: config.discord.pomodoroVcId,
  workMs: config.pomodoro.workMinutes * 60 * 1000,
  breakMs: config.pomodoro.breakMinutes * 60 * 1000,
});

const callScheduler = new CallScheduler({ gateway, logger });

discordClient.once('ready', async () => {
  logger.info(`Bot logged in as ${discordClient.user.tag}`);
  logger.info(`Guild: ${config.discord.guildId}`);
  logger.info(`Pomodoro VC: ${config.discord.pomodoroVcId}`);
  logger.info(`Announce channel: ${config.discord.announceChannelId}`);
  logger.info(`Owner: ${config.discord.ownerUserId}`);
  logger.info(`Cycle: work ${config.pomodoro.workMinutes}min / break ${config.pomodoro.breakMinutes}min`);
  logger.info(`State dir: ${config.state.dir}`);
  logger.info(`Local time: ${new Date().toString()}`);

  // ⚠ 通常動作より先に、前回の取り残しを解除する
  await pomodoro.recoverOnStartup();

  // 前回のプロセスが残したVCステータス（「🍅 作業中 〜01:39」等）を消す。
  // VCが空ならDiscord側が勝手に消すこともあるが、明示的に消すほうが確実。
  // 失敗しても起動は止めない（表示だけの話なので）
  await display.clearStatus();

  await registerCommands({
    token: config.discord.token,
    clientId: discordClient.user.id,
    guildId: config.discord.guildId,
  });
});

discordClient.on('voiceStateUpdate', (oldState, newState) => {
  pomodoro.handleVoiceStateUpdate({
    userId: newState.id ?? oldState.id,
    oldChannelId: oldState.channelId ?? null,
    newChannelId: newState.channelId ?? null,
    isBot: (newState.member ?? oldState.member)?.user?.bot ?? false,
  });
});

discordClient.on('interactionCreate', createInteractionHandler({
  pomodoro,
  callScheduler,
  gateway,
  ownerUserId: config.discord.ownerUserId,
}));

discordClient.on('error', (error) => {
  logger.error('Discord client error', error);
});

// セッションが無効になると再接続されない。生きたまま黙るくらいなら落として
// restart: unless-stopped に任せる（Discordに繋がっていないのに「起動中」が一番困る）
discordClient.on('invalidated', () => {
  logger.error('Discord session invalidated, exiting to let Docker restart the container');
  shutdown(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception, exiting', error);
  shutdown(1);
});

// Docker が送るのは SIGTERM。SIGINT しか見ていないと docker stop で
// ミュートしたまま強制終了されてしまう
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

let shuttingDown = false;

/**
 * 終了する前に、必ず全員のミュートを解除する。
 * Dockerの猶予（既定10秒）を超えるとSIGKILLされるので、上限を設けて必ず抜ける。
 * 万一間に合わなくても台帳が残っているので、次回起動で解除される。
 */
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Shutting down...');
  // cancel() の中で対象VCのステータスも空に戻る（settled() で流し切るまで待つ）
  callScheduler.cancel({ silent: true });

  try {
    await Promise.race([
      pomodoro.shutdownUnmuteAll(),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  } catch (error) {
    logger.error('Error while unmuting on shutdown', error);
  }

  // 表示の後始末。ミュート解除より優先度は低いので必ず後ろで、かつ短めの上限をつける
  // （Dockerの猶予10秒を使い切ってSIGKILLされると、そもそも何も終わらない）
  try {
    await Promise.race([
      Promise.all([display.clearStatus(), callScheduler.settled()]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (error) {
    logger.error('Error while clearing voice status on shutdown', error);
  }

  try {
    await discordClient.destroy();
  } catch (error) {
    logger.error('Error while destroying Discord client', error);
  }

  process.exit(exitCode);
}

discordClient.login(config.discord.token).catch((error) => {
  // ログインに失敗したまま生き残ると、コンテナだけ「起動中」で何も動かない
  logger.error('Failed to log in to Discord, exiting', error);
  process.exit(1);
});
