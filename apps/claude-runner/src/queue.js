import { promises as fs } from 'fs';
import path from 'path';
import { BOTS } from './kinds.js';
import { ensureDir, listJsonFiles, writeJson } from './utils/fsx.js';
import { logger } from './utils/logger.js';

export const LANES = ['inbox', 'processing', 'result', 'failed'];

export function botDir(config, bot) {
  return path.join(config.queueDir, bot);
}

export function laneDir(config, bot, lane) {
  return path.join(config.queueDir, bot, lane);
}

/** 起動時に一度だけ。依頼側とどちらが先に起動しても困らないよう両者とも作る想定 */
export async function ensureQueueDirs(config) {
  for (const bot of BOTS) {
    for (const lane of LANES) {
      await ensureDir(laneDir(config, bot, lane));
    }
  }
  await ensureDir(config.workDir);
  logger.info(`[Queue] Ready: ${config.queueDir} (bots: ${BOTS.join(', ')})`);
}

/**
 * inbox のジョブを1件だけ取る。
 *
 * ★ inbox → processing の移動は **fs.rename 1回**。
 *   同一ファイルシステム上の rename は原子的なので、複数プロセスが同時に
 *   同じファイルを狙っても成功するのは1つだけ（他方は ENOENT）。
 *   「存在チェックしてから移動」にすると、その隙間で二重実行になる。
 *
 * @returns {Promise<{bot:string, fileName:string, processingPath:string}|null>}
 */
export async function claimNextJob(config) {
  for (const bot of BOTS) {
    const inbox = laneDir(config, bot, 'inbox');
    const files = await listJsonFiles(inbox);
    for (const fileName of files) {
      // 書き込み途中の一時ファイルは拾わない（依頼側も tmp→rename で置く約束）
      if (fileName.endsWith('.tmp.json')) continue;

      const from = path.join(inbox, fileName);
      const to = path.join(laneDir(config, bot, 'processing'), fileName);
      try {
        await fs.rename(from, to);
      } catch (error) {
        // ENOENT = 他プロセスに先を越された。それ以外は異常なのでログに残す
        if (error.code !== 'ENOENT') {
          logger.warn(`[Queue] failed to claim ${bot}/${fileName}: ${error.code || error.message}`);
        }
        continue;
      }
      if (!(await winClaimOk(config, bot, fileName))) continue;
      return { bot, fileName, processingPath: to };
    }
  }
  return null;
}

// ---- Windows でだけ効く保険 -------------------------------------------
//
// ⚠ 本番（NASのDocker = Linux）では rename 1回で十分。
//   POSIX の rename(2) は原子的で、負けた側は必ず ENOENT になる。
//
// ⚠⚠ ところが **Windows の fs.rename は、移動元が既に消えていても成功を返すこと
//    がある**（2026-09-22 に実測。20件を2プロセスで取り合わせたら 29回 "成功" した）。
//    開発機（Windows）で runner を2つ動かすと同じジョブを二重に処理してしまう。
//    そこで win32 のときだけ、排他作成（O_EXCL）のマーカーで勝者を1つに決める。
//    Linux ではこの関数は何もしないので、本番の経路は「rename 1回」のまま。
const IS_WIN = process.platform === 'win32';

function claimMarkerPath(config, bot, fileName) {
  return path.join(laneDir(config, bot, 'processing'), `${fileName.replace(/\.json$/, '')}.claim`);
}

async function winClaimOk(config, bot, fileName) {
  if (!IS_WIN) return true;
  try {
    // 'wx' = 既にあれば EEXIST。作成できたプロセスだけが所有者
    const fh = await fs.open(claimMarkerPath(config, bot, fileName), 'wx');
    await fh.close();
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    logger.warn(`[Queue] claim marker failed for ${bot}/${fileName}: ${error.message}`);
    return false;
  }
}

async function clearClaimMarker(config, bot, fileName) {
  if (!IS_WIN) return;
  try { await fs.unlink(claimMarkerPath(config, bot, fileName)); } catch { /* 無ければ何もしない */ }
}

/** 結果JSONを result/ に置く（依頼側はここだけをポーリングする） */
export async function writeResult(config, bot, jobId, result) {
  const dest = path.join(laneDir(config, bot, 'result'), `${jobId}.json`);
  await writeJson(dest, result);
  return dest;
}

/**
 * ジョブ本体を failed/ へ退避する。
 * ⚠ 失敗したジョブは**再実行しない**。二重実行のほうが危険なので、
 *   人が見て判断できるよう原本とエラー出力を残すだけにする。
 */
export async function moveToFailed(config, bot, fileName, rawError) {
  const from = path.join(laneDir(config, bot, 'processing'), fileName);
  const to = path.join(laneDir(config, bot, 'failed'), fileName);
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`[Queue] failed to move ${fileName} to failed/: ${error.message}`);
  }
  await clearClaimMarker(config, bot, fileName);
  if (rawError) {
    // ⚠ 認証切れの判定ロジックは実機で確かめてから詰める。
    //    それまでは「生のエラー出力をそのまま残す」ことを優先する
    const errPath = path.join(laneDir(config, bot, 'failed'), `${fileName.replace(/\.json$/, '')}.error.json`);
    try { await writeJson(errPath, rawError); } catch (e) { logger.warn(`[Queue] could not write error dump: ${e.message}`); }
  }
  return to;
}

/** 正常終了したジョブ本体を processing/ から消す */
export async function clearProcessing(config, bot, fileName) {
  try {
    await fs.unlink(path.join(laneDir(config, bot, 'processing'), fileName));
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`[Queue] could not clear processing/${fileName}: ${error.message}`);
  }
  await clearClaimMarker(config, bot, fileName);
}

/**
 * 起動時、processing/ に残っているジョブを failed/ へ回収する。
 *
 * ⚠ **再実行しない。** 前回のプロセスがどこまで進んだか分からないため、
 *   もう一度走らせると「同じ判断結果を2回返す」ことになり、
 *   依頼側が二重にタスクを作る事故になり得る。
 */
export async function recoverStaleProcessing(config) {
  const recovered = [];
  for (const bot of BOTS) {
    const dir = laneDir(config, bot, 'processing');
    for (const fileName of await listJsonFiles(dir)) {
      const jobId = fileName.replace(/\.json$/, '');
      const now = new Date().toISOString();
      await writeResult(config, bot, jobId, {
        jobId,
        status: 'error',
        output: null,
        errorCode: 'INTERRUPTED',
        logTail: 'runner が処理途中で停止したため回収しました。再実行はしていません（二重実行を避けるため）。必要なら依頼側が投げ直してください。',
        startedAt: null,
        finishedAt: now,
      });
      await moveToFailed(config, bot, fileName, null);
      recovered.push(`${bot}/${fileName}`);
    }
    // 取りこぼした排他マーカー（Windows用）も掃除しておく
    const dirNames = await fs.readdir(dir).catch(() => []);
    for (const n of dirNames.filter((x) => x.endsWith('.claim'))) {
      await fs.unlink(path.join(dir, n)).catch(() => {});
    }
  }
  if (recovered.length > 0) {
    logger.warn(`[Queue] recovered ${recovered.length} stale job(s) to failed/ (not re-executed): ${recovered.join(', ')}`);
  }
  return recovered;
}

/** result / failed を保持日数で掃除する（起動時＋日次） */
export async function purgeOldFiles(config, now = Date.now()) {
  const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const bot of BOTS) {
    for (const lane of ['result', 'failed']) {
      const dir = laneDir(config, bot, lane);
      let names;
      try { names = await fs.readdir(dir); } catch { continue; }
      for (const name of names) {
        const p = path.join(dir, name);
        try {
          const st = await fs.stat(p);
          if (st.isFile() && st.mtimeMs < cutoff) {
            await fs.unlink(p);
            removed.push(`${bot}/${lane}/${name}`);
          }
        } catch { /* 読めないものは触らない */ }
      }
    }
  }
  if (removed.length > 0) logger.info(`[Queue] purged ${removed.length} file(s) older than ${config.retentionDays} days`);
  return removed;
}

/** health.json 用のキュー深さ */
export async function queueDepth(config) {
  const depth = {};
  for (const bot of BOTS) {
    depth[bot] = {};
    for (const lane of LANES) {
      depth[bot][lane] = (await listJsonFiles(laneDir(config, bot, lane))).length;
    }
  }
  return depth;
}
