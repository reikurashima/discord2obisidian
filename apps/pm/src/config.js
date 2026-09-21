import 'dotenv/config';

// ---- Validate required env vars ----
// 足りないまま起動すると「コンテナは生きているのに何も動かない」状態になるので、
// 起動時に落とす（既存Botと同じ方針）。
const required = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'OWNER_USER_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.GUILD_ID,
  },

  // AIに指示できるのはこの1人だけ。ロールでは判定しない（ロールは付け外しできてしまうため）
  ownerUserId: process.env.OWNER_USER_ID,

  // タスクの .md 置き場。マイポータル（別プロセス）が同じ場所を読み書きする
  stateDir: (process.env.STATE_DIR || '/data').replace(/[/\\]+$/, '') || '/data',

  reminders: {
    // 1分ごとに判定する（cron依存を足さないための素朴なティック）
    tickIntervalMs: 60 * 1000,

    // 停止していた間に過ぎてしまった「期限ちょうど」の通知を、
    // 再起動後どこまで遡って送るか。これを過ぎたものは送らずに送信済み扱いにする。
    // （期限を過ぎた未完了タスクはポータル側で赤字表示するので、Discordでは追撃しない）
    dueCatchUpWindowMs: 60 * 60 * 1000,
  },
};
