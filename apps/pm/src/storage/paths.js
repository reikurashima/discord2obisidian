import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ディレクトリ構成はマイポータル側との契約。勝手に変えないこと。
//   <STATE_DIR>/tasks/<id>.md
//   <STATE_DIR>/.state/counter.json
//   <STATE_DIR>/scans/YYYY-MM-DD.json  ← 会話走査の結果（ポータルが decision/notify を書き込む）

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

/** 走査結果（マイポータルとの契約ファイル）。<STATE_DIR>/scans/YYYY-MM-DD.json */
export function scanFilePath(dateString) {
  return path.join(scansDir(), `${dateString}.json`);
}

// ---- 走査のための内部状態 -------------------------------------------
// ⚠ すべて .state/ の下に置く。scans/ はポータルとの契約なので、
//    Bot の都合で作ったファイルを混ぜない。

/** チャンネルごとの「最後に読んだメッセージID」 */
export function scanCursorFilePath() {
  return path.join(stateDir(), '.state', 'scan-cursor.json');
}

/** 「その日の走査をもう走らせたか」。1日1回に保つための記録 */
export function scanRunStateFilePath() {
  return path.join(stateDir(), '.state', 'scan-state.json');
}

/** decision:"ignore" にされた候補の指紋。次回以降 同じ候補を再提案しないため */
export function scanIgnoredFilePath() {
  return path.join(stateDir(), '.state', 'scan-ignored.json');
}

/** 「この候補からこのタスクを作った」の記録。二重作成を絶対に起こさないための台帳 */
export function scanAppliedFilePath() {
  return path.join(stateDir(), '.state', 'scan-applied.json');
}

/** 起動時に一度だけ呼ぶ。ポータル側がどちらを先に起動しても困らないよう、両者とも作る想定 */
export async function ensureStateDirs() {
  for (const dir of [tasksDir(), path.dirname(counterFilePath()), scansDir()]) {
    await fs.mkdir(dir, { recursive: true });
  }
  logger.info(`[State] Ready: ${stateDir()}`);
}
