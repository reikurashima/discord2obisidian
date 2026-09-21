import { discordClient } from './discord/client.js';
import { handleInteraction } from './discord/interactions.js';
import { registerCommands } from './discord/register.js';
import { startReminderLoop, stopReminderLoop } from './reminders/tick.js';
import { ensureStateDirs } from './storage/paths.js';
import { flushWrites } from './storage/writeQueue.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

discordClient.once('ready', async () => {
  logger.info(`PM bot logged in as ${discordClient.user.tag}`);
  logger.info(`Guild: ${config.discord.guildId}`);
  logger.info(`Owner: ${config.ownerUserId}`);
  logger.info(`State dir: ${config.stateDir}`);

  try {
    await ensureStateDirs();
    await registerCommands(discordClient.user.id);
  } catch (error) {
    // コマンドが登録できていないBotは何もできない。生きたまま黙るより落とす
    logger.error('Failed to initialize, exiting', error);
    shutdown(1);
    return;
  }

  startReminderLoop(discordClient);
});

// ⚠ messageCreate は購読しない。
//    他人の発言がこのBotのコードを一切走らせない構造にするため（要件）。
//    過去ログが必要になったら、そのときだけ REST で取りに行く。
discordClient.on('interactionCreate', (interaction) => handleInteraction(discordClient, interaction));

discordClient.on('error', (error) => {
  logger.error('Discord client error', error);
});

// セッションが無効になると再接続されない。生きたまま黙るくらいなら落として
// restart: unless-stopped に任せる
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
// 書き込み途中のまま強制終了される
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

let shuttingDown = false;

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Shutting down...');
  stopReminderLoop();

  try {
    // 書き込みは必ず一時ファイル→rename なので壊れたファイルは残らないが、
    // reminders_sent の書き込みだけは取りこぼすと二重送信になるので待つ。
    // Dockerの猶予（既定10秒）内に必ず抜けるよう上限も設ける
    await Promise.race([
      flushWrites(),
      new Promise((resolve) => { setTimeout(resolve, 8000); }),
    ]);
  } catch (error) {
    logger.error('Error while flushing pending writes', error);
  }

  try {
    await discordClient.destroy();
  } catch (error) {
    logger.error('Error while destroying Discord client', error);
  }

  process.exit(exitCode);
}

discordClient.login(config.discord.token).catch((error) => {
  logger.error('Failed to log in to Discord, exiting', error);
  process.exit(1);
});
