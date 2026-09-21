import { promises as fs } from 'fs';
import { atomicWriteFile, serializeWrite } from '../storage/writeQueue.js';
import {
  scanAppliedFilePath,
  scanCursorFilePath,
  scanIgnoredFilePath,
  scanRunStateFilePath,
} from '../storage/paths.js';
import { logger } from '../utils/logger.js';

// 走査の内部状態（.state/ 配下の小さなJSON）の読み書き。
//
// ⚠ 読み込みはキャッシュしない。ポータルが触るファイルではないが、
//    「ディスクが正」という既存のやり方を崩さない。
// ⚠ 書き込みは必ず serializeWrite + atomicWriteFile を通す。
//    読む→足す→書き戻すを並行させると、先に書いた分が消える（既存Botの実績）。

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // 壊れていても走査は続ける（最悪もう一度読むだけ）。黙らないようにログは出す
      logger.warn(`[Scan] Could not read ${filePath}: ${error.message}`);
    }
  }
  return fallback;
}

function writeJson(filePath, value) {
  return serializeWrite(() => atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`));
}

// ---- カーソル -------------------------------------------------------
// 形: { "<channelId>": { "lastMessageId": "...", "updated": "ISO" } }

export function readCursors() {
  return readJson(scanCursorFilePath(), {});
}

/**
 * 読み終わったところまでカーソルを進める。
 * @param {Record<string, string>} updates channelId → lastMessageId
 */
export async function advanceCursors(updates, isoNow) {
  const entries = Object.entries(updates).filter(([, id]) => !!id);
  if (entries.length === 0) return;

  const current = await readCursors();
  for (const [channelId, lastMessageId] of entries) {
    current[channelId] = { lastMessageId: String(lastMessageId), updated: isoNow };
  }
  await writeJson(scanCursorFilePath(), current);
}

// ---- 走査の実行記録 -------------------------------------------------
// 形: { "lastScanDate": "YYYY-MM-DD", "lastStatus": "ok|failed", "lastError": "..." }

export function readRunState() {
  return readJson(scanRunStateFilePath(), {});
}

export async function markScanRun(dateString, status, error = null) {
  await writeJson(scanRunStateFilePath(), {
    lastScanDate: dateString,
    lastStatus: status,
    lastError: error ? String(error).slice(0, 500) : null,
  });
}

// ---- 却下された候補 -------------------------------------------------
// 形: { "fingerprints": { "<fp>": "ISO" } }
// ⚠ 無限に溜めない。古いものから捨てる（同じ候補が何年も先に再浮上する心配より、
//    ファイルが肥大してティックが重くなるほうが現実的な害）。

const MAX_IGNORED = 500;

export async function readIgnoredFingerprints() {
  const data = await readJson(scanIgnoredFilePath(), {});
  const fps = data.fingerprints;
  return fps && typeof fps === 'object' && !Array.isArray(fps) ? fps : {};
}

export async function addIgnoredFingerprints(fingerprints, isoNow) {
  const list = [...new Set(fingerprints.filter(Boolean))];
  if (list.length === 0) return;

  const current = await readIgnoredFingerprints();
  for (const fp of list) current[fp] = isoNow;

  // 追加順ではなく「記録した時刻」で古い順に落とす
  const trimmed = Object.entries(current)
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .slice(-MAX_IGNORED);

  await writeJson(scanIgnoredFilePath(), { fingerprints: Object.fromEntries(trimmed) });
}

// ---- 適用台帳 -------------------------------------------------------
// 形: { "<YYYY-MM-DD>::<candidateId>": { "taskId": "...", "notified": true, "at": "ISO" } }
//
// ★ 二重作成を防ぐ最後の砦。
//   「タスクを作る → scans/*.json に task_id を書き戻す」の途中で落ちたり、
//   書き戻しがポータルとの競合で失敗したりしても、ここを見れば作成済みと分かる。

export function appliedKey(dateString, candidateId) {
  return `${dateString}::${candidateId}`;
}

export async function readApplied() {
  const data = await readJson(scanAppliedFilePath(), {});
  return data && typeof data === 'object' ? data : {};
}

export async function recordApplied(key, entry) {
  const current = await readApplied();
  current[key] = { ...(current[key] || {}), ...entry };
  await writeJson(scanAppliedFilePath(), current);
  return current[key];
}
