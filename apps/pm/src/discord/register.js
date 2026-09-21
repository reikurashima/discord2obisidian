import { REST, Routes } from 'discord.js';
import { commandDefs } from './commandDefs.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * ギルドコマンドとして登録する（グローバルだと反映に最大1時間かかる）。
 * PUT なので「定義の全量置き換え」= 消したコマンドは自動で消える。
 */
export async function registerCommands(applicationId) {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  await rest.put(
    Routes.applicationGuildCommands(applicationId, config.discord.guildId),
    { body: commandDefs },
  );

  logger.info(`[Commands] Registered ${commandDefs.length} guild commands: ${commandDefs.map((c) => `/${c.name}`).join(' ')}`);
}
