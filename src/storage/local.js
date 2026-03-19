import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

function getBasePath() {
  return config.storage.localVaultPath.replace(/\/+$/, '');
}

export async function uploadFile(filename, content, bodyOnly) {
  const basePath = getBasePath();
  const filePath = path.join(basePath, `${filename}.md`);

  const existing = await downloadFile(filePath);

  if (existing) {
    const appended = existing.trimEnd() + '\n\n' + bodyOnly.trimStart();
    await fs.writeFile(filePath, appended, 'utf-8');
    logger.info(`[Local] Appended to existing: ${filePath}`);
    return { path_display: filePath };
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  logger.info(`[Local] Saved: ${filePath}`);
  return { path_display: filePath };
}

export async function uploadImage(imageFilename, imageBuffer) {
  const basePath = getBasePath();
  const filePath = path.join(basePath, 'images', imageFilename);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, imageBuffer);
  logger.info(`[Local] Image saved: ${filePath}`);
  return { path_display: filePath };
}

export async function downloadFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function overwriteFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  logger.info(`[Local] Updated: ${filePath}`);
  return { path_display: filePath };
}
