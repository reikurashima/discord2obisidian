import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { atJstTimeOfDay, jstDateString, jstParts } from '../utils/datetime.js';
import { postQuietly } from '../discord/notify.js';
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

// SCAN_RUN_ON_BOOT=1 のときだけ、起動後の最初のティックで時刻を待たずに1回走らせる。
// 初回バックフィルを手で走らせるための口（使い終わったら .env から外す）。
let bootScanDone = false;

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

  // ---- ② 走査（1日1回。SCAN_RUN_ON_BOOT=1 なら起動直後にも1回） ----
  if (scanning) return { decisions, skipped: 'already-scanning' };

  const bootScan = config.scan.runOnBoot && !bootScanDone;
  if (bootScan) {
    bootScanDone = true;
    logger.info('[Scan] SCAN_RUN_ON_BOOT=1 のため、時刻を待たずに起動直後の走査を行います');
  }
  if (!options.forceScan && !bootScan && !(await isScanDue(nowMs))) return { decisions };

  scanning = true;
  const date = jstDateString(nowMs);
  try {
    const result = await runScan(client, nowMs);

    // ⚠ 成否によらず「今日はもう走らせた」を記録する。
    //    失敗を翌日に持ち越さない（何度も投げ直してトークンを溶かさないため）。
    await markScanRun(date, result.ok ? 'ok' : 'failed', result.error);

    // ★ 成否によらず毎日1通、pm チャンネルに報告する。
    //   「動いていること」が分かるのが目的なので、候補0件でも必ず送る。
    await report(
      client,
      result.ok ? successMessage(nowMs, result) : failureMessage(nowMs, result.error, result),
    );
    return { decisions, scan: result };
  } catch (error) {
    logger.error('[Scan] 走査に失敗しました', error);
    await markScanRun(date, 'failed', error.message);
    await report(client, failureMessage(nowMs, error.message, null));
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

// ---- 報告 -----------------------------------------------------------
//
// ⚠ オーナーへのDMは廃止した（2026-09-22 本人指示）。送り先は pm チャンネル1本。
// ⚠ **メンションはしない**。毎日飛ぶので、鳴らすと通知が鬱陶しくなる。
// ⚠ 候補の中身は書かない。判断はポータルでするものなので、
//    Discordに内容を並べると「Discordで判断した気になる」導線ができてしまう。

async function report(client, content) {
  const channelId = config.scan.reportChannelId;
  if (!channelId) {
    logger.warn('[Scan] SCAN_REPORT_CHANNEL_ID が空なので、走査の報告を送れませんでした');
    return false;
  }
  return postQuietly(client, channelId, content, []); // メンションなし
}

/** 走査レポート（毎日必ず送る。候補0件でも「候補 0件」と明記する） */
function successMessage(nowMs, result) {
  const stats = result.stats || {};
  const lines = [
    `実行     ${stamp(nowMs)}`,
    `対象     ${stats.channels ?? 0}チャンネル / 発言 ${stats.quoted ?? 0}件`,
    `候補     ${result.candidates.length}件（未判断）`,
    `使用     ${modelLabel(config.scan.runnerModel)} / ジョブ ${stats.jobs ?? 0}本`,
  ];
  if (stats.truncatedChannels?.length) {
    lines.push(`打切り   ${stats.truncatedChannels.join(', ')}（1回の取得上限に達しました）`);
  }
  if (stats.contentLooksDisabled) {
    lines.push('⚠ 本文がすべて空でした。MESSAGE CONTENT Intent を確認してください');
  }
  return block('## 🔍 会話の走査を実行しました', lines);
}

function failureMessage(nowMs, error, result) {
  const stats = result?.stats || {};
  const lines = [
    `実行     ${stamp(nowMs)}`,
    `理由     ${String(error || '不明').replace(/\s+/g, ' ').slice(0, 400)}`,
  ];
  if (result) {
    lines.push(`対象     ${stats.channels ?? 0}チャンネル / 発言 ${stats.quoted ?? 0}件`);
    lines.push(`候補     ${result.candidates?.length ?? 0}件（ここまでの分は保存しました）`);
    lines.push(`使用     ${modelLabel(config.scan.runnerModel)} / ジョブ ${stats.jobs ?? 0}本`);
  }
  return block('## ❌ 会話の走査に失敗しました', lines);
}

/** 見出し＋コードブロック（Discordは見出しもコードブロックも解釈する） */
function block(heading, lines) {
  const link = scansUrl();
  const body = link ? [...lines, '', '; 判断はこちらから', link] : lines;
  return `${heading}\n\`\`\`\n${body.join('\n')}\n\`\`\``;
}

/** PORTAL_PM_URL から走査一覧のURLを組み立てる。未設定なら省く */
function scansUrl() {
  const base = String(config.scan.portalUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return base.endsWith('/scans') ? base : `${base}/scans`;
}

function stamp(nowMs) {
  const p = jstParts(nowMs);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}`;
}

/** モデル名を人が読む形に。知らない値はそのまま出す（嘘をつかない） */
function modelLabel(model) {
  const known = {
    haiku: 'Claude Haiku 4.5',
    sonnet: 'Claude Sonnet 4.5',
    opus: 'Claude Opus 4.5',
  };
  return known[String(model || '').toLowerCase()] || String(model || '既定モデル');
}

/** テスト用: 走査中フラグを落とす */
export function __resetScanning() {
  scanning = false;
}

/** テスト用: 起動直後の走査をもう一度「未実行」に戻す */
export function __resetBootScan(pending = true) {
  bootScanDone = !pending;
}
