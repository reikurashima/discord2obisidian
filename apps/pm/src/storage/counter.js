import { promises as fs } from 'fs';
import { counterFilePath, tasksDir } from './paths.js';
import { atomicWriteFile } from './writeQueue.js';
import { logger } from '../utils/logger.js';

// 連番（#12 の 12）の採番。契約は { "next": 13 }。
//
// ⚠ この関数は必ず serializeWrite() の中から呼ぶこと。
//    read → +1 → write を並行に走らせると同じ番号を2回配ってしまう。

/**
 * 次の番号を1つ取り出して、カウンタを進める。
 * @returns {Promise<number>}
 */
export async function takeNextNumber() {
  const filePath = counterFilePath();
  let next = null;

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed?.next) && parsed.next > 0) next = parsed.next;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`[Counter] Could not read ${filePath}: ${error.message}`);
    }
  }

  if (next === null) {
    // カウンタが無い/壊れている場合、既存タスクの最大番号から復旧する。
    // 1 に戻して番号が重複するほうが後始末が面倒なので、必ず既存を見る
    next = (await maxExistingNumber()) + 1;
    logger.warn(`[Counter] Rebuilt counter from existing tasks: next=${next}`);
  }

  await atomicWriteFile(filePath, `${JSON.stringify({ next: next + 1 }, null, 2)}\n`);
  return next;
}

async function maxExistingNumber() {
  let max = 0;
  let files = [];
  try {
    files = await fs.readdir(tasksDir());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return 0;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const text = await fs.readFile(`${tasksDir()}/${file}`, 'utf-8');
      const m = text.match(/^number:\s*(\d+)\s*$/m);
      if (m) max = Math.max(max, Number(m[1]));
    } catch { /* 読めないファイルは飛ばす */ }
  }
  return max;
}
