import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { buildDailyFile } from '../utils/markdown.js';
import { getLastAppendAt, recordAppend } from './dailyState.js';

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

// ========== Write serialization ==========
//
// 書き込みはどれも「読む → 足す → 全体を上書き」なので、並行に走ると
// 後から書いた方が先に書いた内容を丸ごと消す。連投すると実際にメモが消えていた。
// Botの書き込み頻度はたかが知れているので、全部この1本のチェーンに並べて直列化する。
//
// ⚠ 外向きのAPI（名前・シグネチャ・戻り値）は変えていない。
//    canvasHandler が downloadFile / overwriteFile をそのまま呼んでいるため。

let writeQueue = Promise.resolve();

function serialize(task) {
  // 前の書き込みが失敗してもチェーンを止めない（then の第2引数で拾う）
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

// ========== Daily ordering ==========
//
// デイリーノートは時系列の記録なので、書き込み順 = 投稿順でなければ意味がない。
// ところが各ハンドラは投稿者名の取得（最大5秒）や画像処理を挟むため、
// 書き込みキューに並ぶ順番が投稿順とずれる（＝後から来た短い投稿が先に載る）。
//
// そこで「順番の予約」と「実際の書き込み」を分ける:
//   メッセージを受け取った瞬間に同期的に順番だけ取り（reserveDailySlot）、
//   時間のかかる処理が終わってから自分の番を待って書き込む。
//
// この鎖はデイリー専用。ノートや canvas の書き込みを待たせない
// （同一ファイルへの同時書き込みは、下の writeQueue 側で引き続き防いでいる）。

let dailyChain = Promise.resolve();

/**
 * 呼んだ瞬間に順番を確保する。**await せず、ハンドラ冒頭で同期的に呼ぶこと。**
 *
 * @returns {{ myTurn: Promise<void>, release: () => void }}
 *   myTurn: 自分より前の投稿が全部書き終わると解決する
 *   release: 自分の書き込みが終わったら必ず呼ぶ（失敗時も finally で呼ぶこと）
 */
export function reserveDailySlot() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  // 前の投稿が失敗しても後続を止めない
  const myTurn = dailyChain.catch(() => {});
  dailyChain = myTurn.then(() => gate);

  return { myTurn, release };
}

/**
 * Wait for all pending writes to finish (used on shutdown).
 * 予約済みでまだ書けていないデイリーも待つ（dailyChain は release 後に解決する）。
 */
export function flushWrites() {
  return Promise.all([writeQueue, dailyChain]).then(() => {});
}

// ========== Public API ==========

/**
 * Upload a note file (.md)
 */
export function uploadNote(filename, content, bodyOnly) {
  return serialize(() => uploadNoteRaw(filename, content, bodyOnly));
}

/**
 * Upload an image file
 */
export function uploadImage(imageFilename, imageBuffer) {
  return serialize(() => uploadImageRaw(imageFilename, imageBuffer));
}

/**
 * Download/read a file (returns string content or null)
 */
export function downloadFile(filePath) {
  return serialize(() => readRaw(filePath));
}

/**
 * Overwrite a file with new content
 */
export function overwriteFile(filePath, content) {
  return serialize(() => writeRaw(filePath, content));
}

// 前の投稿からこれ以上空いたら `***` の区切りを入れる
const DAILY_SEPARATOR_GAP_MS = 30 * 60 * 1000;

/**
 * Append one entry to today's daily note.
 * 読み込みから書き戻しまでを1つのタスクにまとめて直列化するのが肝。
 * （中では *Raw を呼ぶこと。公開APIを呼ぶとキューが自分を待ってデッドロックする）
 */
export function appendToDaily(entry) {
  return serialize(async () => {
    const filePath = getDailyFilePath();
    const existing = await readRaw(filePath);

    // その日の1本目には区切りを入れない（直前の投稿が無いので）
    const separator = existing ? shouldInsertSeparator(filePath) : false;

    const fullContent = buildDailyFile(existing, entry, { separator });
    const result = await writeRaw(filePath, fullContent);

    recordAppend(filePath);
    return result;
  });
}

function shouldInsertSeparator(filePath) {
  const lastAt = getLastAppendAt(filePath);

  // 記録が無い（再起動直後など） = 区切りを入れる側に倒す。
  // 入れすぎは無害だが、入れ忘れは後から見て気づきにくい
  if (lastAt === null) {
    logger.info('[Daily] No last-append record, inserting separator');
    return true;
  }

  return Date.now() - lastAt >= DAILY_SEPARATOR_GAP_MS;
}

// ========== Internals (直列化キューの中から呼ぶ版) ==========

async function uploadNoteRaw(filename, content, bodyOnly) {
  if (config.storage.mode === 'local') {
    const local = await getLocal();
    return local.uploadFile(filename, content, bodyOnly);
  }
  const dbx = await getDropbox();
  return dbx.uploadToDropbox(filename, content, bodyOnly);
}

async function uploadImageRaw(imageFilename, imageBuffer) {
  if (config.storage.mode === 'local') {
    const local = await getLocal();
    return local.uploadImage(imageFilename, imageBuffer);
  }
  const dbx = await getDropbox();
  return dbx.uploadImageToDropbox(imageFilename, imageBuffer);
}

async function readRaw(filePath) {
  if (config.storage.mode === 'local') {
    const local = await getLocal();
    return local.downloadFile(filePath);
  }
  const dbx = await getDropbox();
  return dbx.downloadFromDropbox(filePath);
}

async function writeRaw(filePath, content) {
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
