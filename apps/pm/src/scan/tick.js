import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { atJstTimeOfDay, jstDateString } from '../utils/datetime.js';
import { dmOwner } from '../discord/notify.js';
import { markScanRun, readRunState } from './store.js';
import { runScan } from './scan.js';
import { applyDecisions } from './decisions.js';

// 既存の1分ティックに相乗りする。新しいスケジューラ（cron等）は足さない。
//
// 毎ティックでやること:
//   1. 判断の反映（ポータルが書いた decision / notify を実行に移す）… 毎回
//   2. 走査                                                       … 1日1回、SCAN_AT を過ぎたら
//
// ⚠ 走査は数分かかることがある（runner の結果待ち）。
//    走っている間に次のティックが来ても二重に走らせない。

let scanning = false;

/**
 * @param {import('discord.js').Client} client
 * @param {number} nowMs
 * @param {object} [options] テスト用（beforeWriteBack / forceScan）
 */
export async function runScanTick(client, nowMs = Date.now(), options = {}) {
  if (!config.scan.enabled) return { skipped: 'disabled' };

  // ---- ① 判断の反映（こちらは毎ティック） ----
  let decisions = null;
  try {
    decisions = await applyDecisions(client, { nowMs, beforeWriteBack: options.beforeWriteBack });
  } catch (error) {
    logger.error('[Scan] 判断の反映に失敗しました', error);
  }

  // ---- ② 走査（1日1回） ----
  if (scanning) return { decisions, skipped: 'already-scanning' };
  if (!options.forceScan && !(await isScanDue(nowMs))) return { decisions };

  scanning = true;
  const date = jstDateString(nowMs);
  try {
    const result = await runScan(client, nowMs);

    // ⚠ 成否によらず「今日はもう走らせた」を記録する。
    //    失敗を翌日に持ち越さない（何度も投げ直してトークンを溶かさないため）。
    await markScanRun(date, result.ok ? 'ok' : 'failed', result.error);

    if (!result.ok) {
      await dmOwner(client, failureMessage(date, result.error));
      return { decisions, scan: result };
    }

    // 候補が0件なら通知しない（毎朝「0件です」を送られても役に立たない）
    if (result.candidates.length > 0) {
      await dmOwner(client, candidatesMessage(date, result.candidates.length));
    }
    return { decisions, scan: result };
  } catch (error) {
    logger.error('[Scan] 走査に失敗しました', error);
    await markScanRun(date, 'failed', error.message);
    await dmOwner(client, failureMessage(date, error.message));
    return { decisions, scan: { ok: false, date, error: error.message } };
  } finally {
    scanning = false;
  }
}

/** 今日ぶんの走査時刻を過ぎていて、まだ今日走らせていないか */
async function isScanDue(nowMs) {
  if (nowMs < atJstTimeOfDay(nowMs, config.scan.at)) return false;
  const state = await readRunState();
  return state.lastScanDate !== jstDateString(nowMs);
}

/**
 * ⚠ 候補の中身はDMに書かない。判断はポータルでするものなので、
 *    Discordに内容を並べると「DMで判断した気になる」導線ができてしまう。
 */
function candidatesMessage(date, count) {
  const link = config.scan.portalUrl ? `\n${config.scan.portalUrl}` : '';
  return `## 🔔 今日のタスク候補が ${count} 件あります\n\`\`\`\n${date} の会話から抽出しました。\nポータルで採否を判断してください。\n\`\`\`${link}`;
}

function failureMessage(date, error) {
  return `## ❌ 会話の走査に失敗しました\n\`\`\`\n日付: ${date}\n理由: ${String(error || '不明').slice(0, 600)}\n\`\`\``;
}

/** テスト用: 走査中フラグを落とす */
export function __resetScanning() {
  scanning = false;
}
