import { promises as fs } from 'fs';
import path from 'path';

let tmpCounter = 0;

/**
 * 一時ファイルに書き切ってから rename する。
 * rename は同一ファイルシステム上では原子的なので、
 * 依頼側（PM Bot / ポータル）が「書き込み途中の result JSON」を読むことがない。
 * （既存Botで、追記の途中を読まれて壊れた事故と同じ構図を避ける）
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

export async function writeJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 存在しなくてもエラーにしない再帰削除（作業ディレクトリの後始末用） */
export async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

/** ディレクトリ内の *.json を名前順で返す。ディレクトリが無ければ空配列 */
export async function listJsonFiles(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
