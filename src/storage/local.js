import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

function getBasePath() {
  return config.storage.localVaultPath.replace(/\/+$/, '');
}

let tmpCounter = 0;

/**
 * 一時ファイルに書き切ってから rename する。
 * rename は同一ファイルシステム上では原子的なので、書き込み途中の壊れた状態が
 * Obsidian（＝同期対象の実データ）から見えることがない。
 */
async function atomicWrite(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  const tmpPath = `${filePath}.${process.pid}-${++tmpCounter}.tmp`;

  try {
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // 失敗したら一時ファイルを残さない（Vaultにゴミを置かないため）
    try { await fs.unlink(tmpPath); } catch { /* 後始末の失敗は無視 */ }
    throw error;
  }
}

export async function uploadFile(filename, content, bodyOnly) {
  const basePath = getBasePath();
  const filePath = path.join(basePath, `${filename}.md`);

  const existing = await downloadFile(filePath);

  if (existing) {
    // Nothing to append (e.g. a single-line message whose only content is the
    // title): leave the existing note untouched.
    if (!bodyOnly || !bodyOnly.trim()) {
      logger.info(`[Local] Nothing to append, existing note left unchanged: ${filePath}`);
      return { path_display: filePath };
    }
    const appended = existing.trimEnd() + '\n\n' + bodyOnly.trimStart();
    await atomicWrite(filePath, appended);
    logger.info(`[Local] Appended to existing: ${filePath}`);
    return { path_display: filePath };
  }

  await atomicWrite(filePath, content);
  logger.info(`[Local] Saved: ${filePath}`);
  return { path_display: filePath };
}

export async function uploadImage(imageFilename, imageBuffer) {
  const basePath = getBasePath();
  const filePath = path.join(basePath, 'images', imageFilename);

  await atomicWrite(filePath, imageBuffer);
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
  await atomicWrite(filePath, content);
  logger.info(`[Local] Updated: ${filePath}`);
  return { path_display: filePath };
}
