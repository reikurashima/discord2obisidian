import 'dotenv/config';

// ---- Validate required env vars ----
// 起動してから「IDが空でした」と気づくと、Botは生きているのに何も起きない状態になる。
// 既存Botと同じく、足りなければ起動時点で落とす。
const required = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'POMODORO_VC_ID',
  'ANNOUNCE_CHANNEL_ID',
  'OWNER_USER_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

/**
 * 分を表す環境変数を読む。
 * 0や負数・NaNを許すとタイマーが即発火して無限ループになるため、下限1分で弾く。
 */
function readMinutes(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Invalid ${key}: "${raw}" (1以上の数値を指定してください)`);
  }
  return value;
}

export const config = {
  // --- Discord ---
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.GUILD_ID,
    pomodoroVcId: process.env.POMODORO_VC_ID,
    announceChannelId: process.env.ANNOUNCE_CHANNEL_ID,
    ownerUserId: process.env.OWNER_USER_ID,
  },

  // --- Pomodoro ---
  pomodoro: {
    workMinutes: readMinutes('WORK_MINUTES', 25),
    breakMinutes: readMinutes('BREAK_MINUTES', 5),
    // VC名フォールバック用のラベル。改名はレート制限が厳しいので短く保つ
    workChannelName: process.env.WORK_CHANNEL_NAME || '🍅作業中',
    breakChannelName: process.env.BREAK_CHANNEL_NAME || '☕休憩中',
  },

  // --- State ---
  state: {
    // ミュートした人の記録置き場。コンテナ再作成をまたいで残す必要があるので
    // 名前付きボリュームをマウントすること（docker-compose.yaml 参照）
    dir: process.env.STATE_DIR || '/data',
  },
};
