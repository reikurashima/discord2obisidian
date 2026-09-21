import { promises as fs } from 'fs';
import path from 'path';

// 書き込みは全部この1本のチェーンに並べて直列化する。
// 「読む→変える→書き戻す」を並行に走らせると、後勝ちで前の変更が消えるため。
// （既存Botのデイリーノートで実際にメモが消えた事故と同じ構図）

let writeQueue = Promise.resolve();

/**
 * 書き込みタスクを直列に実行する。
 * ⚠ 読み込みはこのキューを通さない。ポータル側が同じファイルを編集するので、
 *    読むときは必ずその場でディスクから読む（キャッシュもしない）。
 */
export function serializeWrite(task) {
  // 前の書き込みが失敗してもチェーンを止めない
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

/** 進行中の書き込みが片付くまで待つ（シャットダウン用） */
export function flushWrites() {
  return writeQueue.then(() => {});
}

let tmpCounter = 0;

/**
 * 一時ファイルに書き切ってから rename する。
 * rename は同一ファイルシステム上では原子的なので、
 * 書き込み途中の壊れた .md をポータル側が読んでしまうことがない。
 */
export async function atomicWriteFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  const tmpPath = `${filePath}.${process.pid}-${++tmpCounter}.tmp`;

  try {
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // 失敗したら一時ファイルを残さない（共有ディレクトリにゴミを置かないため）
    try { await fs.unlink(tmpPath); } catch { /* 後始末の失敗は無視 */ }
    throw error;
  }
}
