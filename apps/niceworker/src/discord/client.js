import { Client, GatewayIntentBits, Partials } from 'discord.js';

// GuildVoiceStates が無いと voiceStateUpdate が一切飛んでこない（＝ポモドーロが永遠に始まらない）。
// Discord Developer Portal 側でも同名のIntentを有効にする必要がある。
// MessageContent は使わないので要求しない（特権Intentは必要最小限に）。
export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
  // 起動直後にVCへ居る人を取りこぼさないため、メンバーのキャッシュを部分的に許可する
  partials: [Partials.GuildMember],
});
