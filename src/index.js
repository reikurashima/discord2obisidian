import { discordClient } from './discord/client.js';
import { handleMessage } from './discord/messageHandler.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

discordClient.once('ready', () => {
  logger.info(`Bot logged in as ${discordClient.user.tag}`);
  logger.info(`Storage mode: ${config.storage.mode}`);
  logger.info(`Note channel: ${config.discord.channelId}`);
  logger.info(`Daily channel: ${config.discord.dailyChannelId}`);

  if (config.discord.aiClipChannelId) {
    logger.info(`AI Clip channel: ${config.discord.aiClipChannelId}`);
  } else {
    logger.info('AI Clip channel: not configured');
  }

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

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', error);
});

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  discordClient.destroy();
  process.exit(0);
});

discordClient.login(config.discord.token);
