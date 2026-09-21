import { Client, GatewayIntentBits } from 'discord.js';

// ⚠ Intents は Guilds だけ。
//    MessageContent も GuildMessages も要らない（= Developer Portal の特権Intentも不要）。
//    このBotは messageCreate を購読しない設計なので、
//    「他人の発言がコードの実行を引き起こす」経路がそもそも存在しない。
//    スラッシュコマンド（interactionCreate）は Intent 無しで届く。
export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds],
});
