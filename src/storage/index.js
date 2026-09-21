import path from 'path';
import fs from 'fs';
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

/**
 * Get the canvas file path: basePath/<name>.canvas
 */
export function getCanvasFilePath(name) {
  const basePath = getBasePath();

  if (config.storage.mode === 'local') {
    return path.join(basePath, `${name}.canvas`);
  }
  return `${basePath}/${name}.canvas`;
}

// Cache the resolved vault-relative images path (see getVaultRelativeImagesPath).
let cachedVaultRelativeImagesPath = null;

/**
 * Resolve the images directory as a path relative to the Obsidian vault root,
 * which is what a JSON Canvas "file" node expects.
 *
 * - local: walk up to 3 levels from basePath looking for a `.obsidian` directory.
 *   If found, that directory is the vault root and the relative path is computed
 *   from it to basePath/images. Otherwise fall back to 'images'.
 * - dropbox: always 'images'.
 *
 * The result is cached for the process lifetime.
 */
export function getVaultRelativeImagesPath() {
  if (cachedVaultRelativeImagesPath !== null) {
    return cachedVaultRelativeImagesPath;
  }

  if (config.storage.mode !== 'local') {
    cachedVaultRelativeImagesPath = 'images';
    return cachedVaultRelativeImagesPath;
  }

  const basePath = getBasePath();
  const imagesPath = path.join(basePath, 'images');

  let vaultRoot = null;
  let current = basePath;
  for (let i = 0; i <= 3; i++) {
    try {
      if (fs.existsSync(path.join(current, '.obsidian'))) {
        vaultRoot = current;
        break;
      }
    } catch {
      // Ignore fs errors and keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  if (vaultRoot) {
    cachedVaultRelativeImagesPath = path.relative(vaultRoot, imagesPath).split(path.sep).join('/');
    logger.info(`[Storage] Vault root found at ${vaultRoot}, images relative path: ${cachedVaultRelativeImagesPath}`);
  } else {
    cachedVaultRelativeImagesPath = 'images';
    logger.info(`[Storage] No .obsidian vault root found near ${basePath}, using 'images'`);
  }

  return cachedVaultRelativeImagesPath;
}
