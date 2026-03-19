import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// Lazy-load storage backends to avoid requiring unused credentials
let dropboxModule = null;
let localModule = null;

async function getDropbox() {
  if (!dropboxModule) {
    dropboxModule = await import('../dropbox/uploader.js');
  }
  return dropboxModule;
}

async function getLocal() {
  if (!localModule) {
    localModule = await import('./local.js');
  }
  return localModule;
}

function getBasePath() {
  if (config.storage.mode === 'local') {
    return config.storage.localVaultPath.replace(/\/+$/, '');
  }
  return config.dropbox.folderPath.replace(/\/+$/, '');
}

/**
 * Upload a note file (.md)
 */
export async function uploadNote(filename, content, bodyOnly) {
  if (config.storage.mode === 'local') {
    const local = await getLocal();
    return local.uploadFile(filename, content, bodyOnly);
  }
  const dbx = await getDropbox();
  return dbx.uploadToDropbox(filename, content, bodyOnly);
}

/**
 * Upload an image file
 */
export async function uploadImage(imageFilename, imageBuffer) {
  if (config.storage.mode === 'local') {
    const local = await getLocal();
    return local.uploadImage(imageFilename, imageBuffer);
  }
  const dbx = await getDropbox();
  return dbx.uploadImageToDropbox(imageFilename, imageBuffer);
}

/**
 * Download/read a file (returns string content or null)
 */
export async function downloadFile(filePath) {
  if (config.storage.mode === 'local') {
    const local = await getLocal();
    return local.downloadFile(filePath);
  }
  const dbx = await getDropbox();
  return dbx.downloadFromDropbox(filePath);
}

/**
 * Overwrite a file with new content
 */
export async function overwriteFile(filePath, content) {
  if (config.storage.mode === 'local') {
    const local = await getLocal();
    return local.overwriteFile(filePath, content);
  }
  const dbx = await getDropbox();
  return dbx.overwriteDropboxFile(filePath, content);
}

/**
 * Get the daily file path for today: basePath/YYYY-MM-DD.md
 */
export function getDailyFilePath() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const basePath = getBasePath();

  if (config.storage.mode === 'local') {
    return path.join(basePath, `${dateStr}.md`);
  }
  return `${basePath}/${dateStr}.md`;
}
