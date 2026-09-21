import { config } from '../config.js';
import {
  MS_PER_DAY,
  atJstTimeOfDay,
  parseTimeOfDay,
  startOfJstDay,
} from '../utils/datetime.js';

// 通知は3種類だけ。frontmatter の reminders_sent にこのキーを積んで二重送信を防ぐ。
export const REMINDER_KEYS = ['-3d', '-1d', '0'];

export const DEFAULT_REMIND_AT = '18:00';

/**
 * タスクの通知予定時刻を求める。
 * @returns {{ '-3d': number, '-1d': number, '0': number } | null} due が壊れていれば null
 */
export function reminderSchedule(task) {
  if (!task.dueMs) return null;

  const time = parseTimeOfDay(task.remindAt) || parseTimeOfDay(DEFAULT_REMIND_AT);
  const dueDayStart = startOfJstDay(task.dueMs);

  return {
    '-3d': atJstTimeOfDay(dueDayStart - 3 * MS_PER_DAY, time),
    '-1d': atJstTimeOfDay(dueDayStart - 1 * MS_PER_DAY, time),
    '0': task.dueMs,
  };
}

/**
 * 登録時点／期限変更時点で、もう過ぎてしまっているタイミングを求める。
 * これを reminders_sent に入れておくことで「飛ばす」を表現する。
 * （例: 期限まで2日で登録 → -3d は最初から送信済み扱いにして、-1d と 0 だけ残す）
 */
export function suppressedKeysAt(task, nowMs) {
  const schedule = reminderSchedule(task);
  if (!schedule) return [];
  return REMINDER_KEYS.filter((key) => schedule[key] <= nowMs);
}

/**
 * いま送るべき通知キーを返す。
 *
 * 判定の方針:
 *   -3d / -1d : 予定時刻を過ぎていて、まだ期限前なら送る。
 *               期限を過ぎていたら送らずに送信済み扱いにする（もう意味が無いので）。
 *   0         : 期限を過ぎたら送る。ただし停止していた場合に何日も前のものを
 *               掘り起こさないよう、dueCatchUpWindowMs を過ぎたものは送らず送信済み扱い。
 *               （期限超過の未完了タスクはポータル側で赤字表示するので、Discordでは追撃しない）
 *
 * @returns {{ send: string[], suppress: string[] }}
 */
export function dueReminders(task, nowMs) {
  const schedule = reminderSchedule(task);
  if (!schedule) return { send: [], suppress: [] };

  const send = [];
  const suppress = [];

  for (const key of REMINDER_KEYS) {
    if (task.remindersSent.includes(key)) continue;

    const scheduledMs = schedule[key];
    if (scheduledMs > nowMs) continue; // まだ先

    if (key === '0') {
      if (nowMs - scheduledMs <= config.reminders.dueCatchUpWindowMs) send.push(key);
      else suppress.push(key);
      continue;
    }

    if (nowMs < task.dueMs) send.push(key);
    else suppress.push(key);
  }

  return { send, suppress };
}
