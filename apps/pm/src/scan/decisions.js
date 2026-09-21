import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { jstIsoString, parseDueInput } from '../utils/datetime.js';
import { createTask, readTaskFile } from '../storage/tasks.js';
import { DEFAULT_REMIND_AT, suppressedKeysAt } from '../reminders/schedule.js';
import { buildCreatedMessage, postQuietly } from '../discord/notify.js';
import { listScanDates, readScanFile, writeScanFileIfUnchanged } from './scanFile.js';
import {
  addIgnoredFingerprints, appliedKey, readApplied, readIgnoredFingerprints, recordApplied,
} from './store.js';
import { fingerprint } from './dedupe.js';

// ★ ここが本体。マイポータルが書き込んだ decision / notify を見て、実際の処理を行う。
//
//   decision === "task"  かつ task_id === null  → タスクを作る → 必要なら通知 → task_id を書き戻す
//   decision === "ignore"                        → 何もしない。ただし指紋を覚えて再提案しない
//
// ⚠ **二重作成を絶対に起こさない** のがこのファイルの最重要事項。
//    scans/*.json への書き戻しはポータルとの競合で失敗しうるので、
//    「作った」という事実は .state/scan-applied.json（Botだけが触る台帳）にも残す。
//    書き戻しに失敗しても、台帳を見れば作成済みと分かるので作り直さない。

/** 古い走査結果まで毎分読み直さない。直近この本数だけ見る */
const MAX_FILES_PER_TICK = 14;

// 「担当者が未記入」等でタスクにできない候補のログを、毎分出し続けないための覚え書き（メモリのみ）
const warned = new Set();

/**
 * 1ティックぶんの反映。
 * @param {import('discord.js').Client} client
 * @param {{ nowMs?: number, beforeWriteBack?: Function }} [options]
 *        beforeWriteBack はテスト専用の差し込み口（本番では渡さない）。
 *        「ポータルが書き戻しの直前にファイルを書き換えた」状況を再現するために使う。
 */
export async function applyDecisions(client, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const summary = {
    created: [], notified: [], ignored: [], conflicts: [], blocked: [],
  };

  const dates = (await listScanDates()).slice(0, MAX_FILES_PER_TICK);
  for (const date of dates) {
    await applyForDate(client, date, nowMs, options, summary);
  }
  return summary;
}

async function applyForDate(client, date, nowMs, options, summary) {
  const loaded = await readScanFile(date);
  if (!loaded) return;

  const todo = loaded.data.candidates.filter(
    (c) => c && c.decision === 'task' && (c.task_id === null || c.task_id === undefined),
  );
  const toIgnore = loaded.data.candidates.filter((c) => c && c.decision === 'ignore');

  await rememberIgnored(toIgnore, nowMs, summary);
  if (todo.length === 0) return;

  const applied = await readApplied();
  const assignments = new Map(); // candidateId → taskId

  for (const candidate of todo) {
    const key = appliedKey(date, candidate.id);
    let entry = applied[key];
    let task = null;

    if (entry?.taskId) {
      // 既に作ってある（前回のティックで書き戻しに失敗したケース）。絶対に作り直さない
      task = (await readTaskFile(entry.taskId))?.task || null;
      logger.info(`[Scan] ${date}/${candidate.id} は作成済み（${entry.taskId}）。書き戻しだけやり直します`);
    } else {
      const problem = whyNotTaskable(candidate);
      if (problem) {
        if (!warned.has(key)) {
          warned.add(key);
          logger.warn(`[Scan] ${date}/${candidate.id}「${candidate.title}」はタスクにできません: ${problem}`);
        }
        summary.blocked.push({ id: candidate.id, reason: problem });
        continue;
      }

      task = await createFromCandidate(candidate, nowMs);
      entry = await recordApplied(key, {
        taskId: task.id, number: task.number, notified: false, at: jstIsoString(nowMs),
      });
      summary.created.push({ id: candidate.id, taskId: task.id, number: task.number });
      logger.info(`[Scan] ${date}/${candidate.id} からタスク #${task.number} を作成しました`);
    }

    // 通知は notify === true のときだけ。登録時（/task）と同じ文面・同じメンション
    if (candidate.notify === true && task && !entry?.notified) {
      const message = buildCreatedMessage(task);
      await postQuietly(client, task.channelId, message.content, message.mentionUserIds);
      await recordApplied(key, { notified: true });
      summary.notified.push({ id: candidate.id, taskId: task.id });
    }

    if (entry?.taskId) assignments.set(candidate.id, entry.taskId);
  }

  if (assignments.size === 0) return;

  // ---- task_id の書き戻し（ハッシュ照合つき） ----
  // ⚠ タスク作成中にポータルがこのファイルを書き換えている可能性がある。
  //    読んだときと中身が違っていたら **何も書かずに諦める**。
  //    作成済みの事実は台帳に残っているので、次のティックで書き戻しだけやり直せる。
  const fresh = await readScanFile(date);
  if (!fresh) return;

  let changed = false;
  for (const candidate of fresh.data.candidates) {
    const taskId = assignments.get(candidate?.id);
    if (taskId && candidate.task_id !== taskId) {
      candidate.task_id = taskId;
      changed = true;
    }
  }
  if (!changed) return;

  if (options.beforeWriteBack) await options.beforeWriteBack(date);

  const result = await writeScanFileIfUnchanged(date, fresh.data, fresh.hash);
  if (!result.ok) {
    summary.conflicts.push({ date, reason: result.reason, candidates: [...assignments.keys()] });
    logger.warn(
      `[Scan] scans/${date}.json への書き戻しを見送りました（${result.reason}）。`
      + ' ポータルが同時に書き換えています。次のティックでやり直します（タスクは作り直しません）。',
    );
  }
}

/** decision:"ignore" の候補を覚える。同じ指紋を毎分書き直さないよう、新しいものだけ足す */
async function rememberIgnored(candidates, nowMs, summary) {
  if (candidates.length === 0) return;
  const fps = candidates
    .map((c) => fingerprint(c.title, c.assignee_name))
    .filter(Boolean);
  if (fps.length === 0) return;

  const current = await readIgnoredFingerprints();
  const fresh = fps.filter((fp) => !current[fp]);
  if (fresh.length === 0) return;

  await addIgnoredFingerprints(fresh, jstIsoString(nowMs));
  summary.ignored.push(...fresh);
  logger.info(`[Scan] 却下された候補 ${fresh.length} 件を記録しました（今後は再提案しません）`);
}

/**
 * タスクにできない理由。
 * ⚠ 勝手に埋めない。担当者も期限も業務の約束そのものなので、
 *    欠けているならポータルで人に埋めてもらう（次のティックで自動的に拾い直す）。
 */
function whyNotTaskable(candidate) {
  if (!String(candidate.title || '').trim()) return 'title が空です';
  if (!String(candidate.assignee_id || '').trim()) return 'assignee_id が未記入です（ポータルで担当者を選んでください）';
  if (!parseDueInput(String(candidate.due || ''))) return 'due が未記入か形式が違います（YYYY-MM-DD で指定してください）';
  return null;
}

/** /task と同じ経路・同じ採番でタスクを作る */
function createFromCandidate(candidate, nowMs) {
  const due = parseDueInput(String(candidate.due));
  const remindAt = DEFAULT_REMIND_AT;

  // 期限まで3日を切っていれば、もう過ぎている通知は最初から送信済み扱いにする（/task と同じ）
  const remindersSent = suppressedKeysAt(
    { dueMs: due.ms, remindAt, remindersSent: [] },
    nowMs,
  );

  return createTask({
    title: String(candidate.title).trim(),
    channelId: String(candidate.channel_id),
    channelName: String(candidate.channel_name || ''),
    assigneeId: String(candidate.assignee_id),
    assigneeName: String(candidate.assignee_name || candidate.assignee_id),
    due: due.text,
    remindAt,
    remindersSent,
    // 「誰が登録したか」はオーナー扱い。判断したのはポータル上のオーナー本人なので
    createdBy: config.ownerUserId,
  });
}
