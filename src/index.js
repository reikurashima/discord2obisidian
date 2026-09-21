import { discordClient } from './discord/client.js';
import { handleMessage } from './discord/messageHandler.js';
import { flushWrites } from './storage/index.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

discordClient.once('ready', () => {
  logger.info(`Bot logged in as ${discordClient.user.tag}`);
  logger.info(`Storage mode: ${config.storage.mode}`);
  logger.info(`Note channel: ${config.discord.channelId}`);
  logger.info(`Daily channel: ${config.discord.dailyChannelId}`);
  logger.info(`Canvas channel: ${config.discord.canvasChannelId || 'not configured'}`);

  if (config.storage.mode === 'dropbox') {
    logger.info(`Dropbox folder: ${config.dropbox.folderPath}`);
  } else {
    logger.info(`Local vault: ${config.storage.localVaultPath}`);
  }
});

discordClient.on('messageCreate', handleMessage);

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
// 書き込み途中のまま強制終了されていた
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

let shuttingDown = false;

/**
 * 進行中の書き込みを待ってから終了する。
 * 書きかけのノートを取りこぼさないためだが、Dockerの猶予（既定10秒）内に収まるよう
 * 上限も設けて必ず抜ける。
 */
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Shutting down...');

  try {
    await Promise.race([
      flushWrites(),
      new Promise((resolve) => setTimeout(resolve, 8000)),
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
  // ログインに失敗したまま生き残ると、コンテナだけ「起動中」で何も保存されない
  logger.error('Failed to log in to Discord, exiting', error);
  process.exit(1);
});
