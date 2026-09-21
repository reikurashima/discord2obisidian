import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';

// デイリーノートの「最後に追記した時刻」を覚えておくための小さな状態ファイル。
//
// 日付ノートの中身には時刻が一切書かれていないので、ファイルを読んでも
// 前回の投稿がいつだったかは分からない。かといって Vault（実データ）に
// 状態ファイルを置きたくないため、コンテナ内の一時ディレクトリに置く。
//
// プロセス再起動で消えても壊れない: 記録が無い = 「区切りを入れる」側に倒す。
// 入れすぎは無害だが、入れ忘れは後から見て気づきにくいため。
const STATE_FILE = path.join(os.tmpdir(), 'discord-obsidian-bot-daily-state.json');

// 古い日付のキーを残し続けないための保持期間
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

let cache = null;

function load() {
  if (cache) return cache;

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    cache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    // 初回起動・壊れたファイル・読めない: どれも「記録なし」として扱えばよい
    cache = {};
  }

  return cache;
}

/**
 * @param {string} key デイリーノートのファイルパス
 * @returns {number|null} 最終追記時刻(ms)。記録が無ければ null
 */
export function getLastAppendAt(key) {
  const value = load()[key];
  return typeof value === 'number' ? value : null;
}

/**
 * @param {string} key デイリーノートのファイルパス
 */
export function recordAppend(key, at = Date.now()) {
  const state = load();
  state[key] = at;

  for (const [k, v] of Object.entries(state)) {
    if (typeof v !== 'number' || at - v > RETENTION_MS) delete state[k];
  }

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch (error) {
    // 状態が保存できなくても、次回に区切りが1本多く入るだけ。本体は止めない
    logger.warn(`[Daily] Failed to persist last-append state: ${error.message}`);
  }
}
