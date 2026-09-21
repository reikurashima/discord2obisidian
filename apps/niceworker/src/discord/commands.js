import { SlashCommandBuilder, ChannelType, REST, Routes } from 'discord.js';
import { logger } from '../utils/logger.js';

// ギルドコマンドとして登録する（グローバルは反映に最大1時間かかるため）。
// 友人用の単一サーバー運用なのでこれで十分。
export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('call')
    .setDescription('通話の終了予約')
    .addSubcommand((sub) => sub
      .setName('end-at')
      .setDescription('指定時刻に通話を終了します（オーナー専用）')
      .addStringOption((opt) => opt
        .setName('time')
        .setDescription('終了時刻。例: 23:00 / +90m')
        .setRequired(true))
      .addChannelOption((opt) => opt
        .setName('channel')
        .setDescription('対象のVC（省略時は自分が今いるVC）')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('cancel')
      .setDescription('終了予約を取り消します（オーナー専用）')),

  new SlashCommandBuilder()
    .setName('pomo')
    .setDescription('ポモドーロ')
    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('今のフェーズと残り時間を表示します')),
].map((builder) => builder.toJSON());

/**
 * 起動のたびに上書き登録する。差分を気にしなくてよく、定義変更の反映漏れも起きない。
 * 失敗しても既存のコマンドは生きているので、Bot本体は止めない。
 */
export async function registerCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandDefinitions });
    logger.info(`Registered ${commandDefinitions.length} slash commands to guild ${guildId}`);
  } catch (error) {
    logger.error('スラッシュコマンドの登録に失敗しました（既存の登録があれば動作は継続します）', error);
  }
}
