import 'dotenv/config';

// ---- Validate required env vars ----
const alwaysRequired = [
  'DISCORD_TOKEN',
  'DISCORD_CHANNEL_ID',
  'DISCORD_DAILY_CHANNEL_ID',
  'STORAGE_MODE',
];

const storageMode = (process.env.STORAGE_MODE || 'dropbox').toLowerCase();

const dropboxRequired = [
  'DROPBOX_CLIENT_ID',
  'DROPBOX_CLIENT_SECRET',
  'DROPBOX_REFRESH_TOKEN',
  'DROPBOX_FOLDER_PATH',
];

const localRequired = [
  'LOCAL_VAULT_PATH',
];

const required = [
  ...alwaysRequired,
  ...(storageMode === 'dropbox' ? dropboxRequired : []),
  ...(storageMode === 'local' ? localRequired : []),
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  // --- Discord ---
  discord: {
    token: process.env.DISCORD_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
    dailyChannelId: process.env.DISCORD_DAILY_CHANNEL_ID,
    canvasChannelId: process.env.DISCORD_CANVAS_CHANNEL_ID || null,
  },

  // --- Storage ---
  storage: {
    mode: storageMode, // 'dropbox' or 'local'
    localVaultPath: process.env.LOCAL_VAULT_PATH || null,
  },

  // --- Dropbox ---
  dropbox: {
    clientId: process.env.DROPBOX_CLIENT_ID || null,
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || null,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || null,
    folderPath: process.env.DROPBOX_FOLDER_PATH || null,
  },
};
