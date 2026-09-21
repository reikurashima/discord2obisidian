import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ディレクトリ構成はマイポータル側との契約。勝手に変えないこと。
//   <STATE_DIR>/tasks/<id>.md
//   <STATE_DIR>/.state/counter.json
//   <STATE_DIR>/scans/YYYY-MM-DD.json   （今回は読み書きしないが場所は確保しておく）

export function stateDir() {
  return config.stateDir;
}

export function tasksDir() {
  return path.join(stateDir(), 'tasks');
}

export function taskFilePath(id) {
  return path.join(tasksDir(), `${id}.md`);
}

export function counterFilePath() {
  return path.join(stateDir(), '.state', 'counter.json');
}

export function scansDir() {
  return path.join(stateDir(), 'scans');
}

/** 起動時に一度だけ呼ぶ。ポータル側がどちらを先に起動しても困らないよう、両者とも作る想定 */
export async function ensureStateDirs() {
  for (const dir of [tasksDir(), path.dirname(counterFilePath()), scansDir()]) {
    await fs.mkdir(dir, { recursive: true });
  }
  logger.info(`[State] Ready: ${stateDir()}`);
}
