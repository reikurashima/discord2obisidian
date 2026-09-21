import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { listOpenTasks, updateTask } from '../storage/tasks.js';
import { REMINDER_KEYS, dueReminders } from './schedule.js';
import { buildReminderMessage, postToChannel } from '../discord/notify.js';

// 1分ごとのティックで判定する。cron を足さないのは、
// 依存が増えるうえ「コンテナのTZ設定次第で時刻がズレる」事故を1つ増やすため。
//
// 二重送信の防止は reminders_sent（ファイル）で行うので、
// ティックが多少ズレても、再起動しても、同じ通知は2回飛ばない。

let ticking = false;
let timer = null;

/**
 * 1回分の判定。テストから任意の時刻で呼べるよう now を引数にしている。
 * @param {import('discord.js').Client} client
 * @param {number} nowMs
 * @returns {Promise<{ sent: Array<{ id: string, number: number, key: string }>, suppressed: Array<{ id: string, key: string }> }>}
 */
export async function runTick(client, nowMs = Date.now()) {
  const sent = [];
  const suppressed = [];

  // ⚠ 毎ティックでディスクから読み直す。
  //    ポータル側が期限や内容を書き換えていても、次のティックから必ず新しい値で動く
  const tasks = await listOpenTasks();

  for (const task of tasks) {
    const { send, suppress } = dueReminders(task, nowMs);
    if (send.length === 0 && suppress.length === 0) continue;

    const toSuppress = [...suppress];

    // 停止していて複数のタイミングをまたいだ場合は、一番差し迫ったものだけを送る。
    // 「あと3日です」と「明日が期限です」を同時に流しても受け手が混乱するだけなので、
    // 残りは送らずに送信済み扱いにする（＝まとめて1回）。
    let keyToSend = null;
    if (send.length > 0) {
      keyToSend = send.reduce((a, b) => (REMINDER_KEYS.indexOf(a) > REMINDER_KEYS.indexOf(b) ? a : b));
      toSuppress.push(...send.filter((k) => k !== keyToSend));
    }

    if (toSuppress.length > 0) {
      await markReminders(task.id, toSuppress);
      toSuppress.forEach((key) => suppressed.push({ id: task.id, key }));
      logger.info(`[Reminder] #${task.number} skipped ${toSuppress.join(',')} (out of window)`);
    }

    if (!keyToSend) continue;

    // 先に「送信済み」を書いてから送る。
    // 逆順だと、送信直後にプロセスが落ちたときに次の起動で同じ通知をもう一度送ってしまう。
    // 送信に失敗した場合だけ記録を戻して、次のティックで再挑戦させる。
    await markReminders(task.id, [keyToSend]);
    try {
      const message = buildReminderMessage(task, keyToSend);
      await postToChannel(client, task.channelId, message.content, message.mentionUserIds);
      sent.push({ id: task.id, number: task.number, key: keyToSend });
      logger.info(`[Reminder] #${task.number} sent ${keyToSend}`);
    } catch (error) {
      await unmarkReminders(task.id, [keyToSend]);
      logger.error(`[Reminder] #${task.number} failed to send ${keyToSend}, will retry next tick`, error);
    }
  }

  return { sent, suppressed };
}

function markReminders(id, keys) {
  return updateTask(id, (values) => {
    const current = Array.isArray(values.reminders_sent) ? values.reminders_sent.map(String) : [];
    const merged = [...current];
    for (const key of keys) if (!merged.includes(key)) merged.push(key);
    if (merged.length === current.length) return false;
    values.reminders_sent = merged;
  });
}

function unmarkReminders(id, keys) {
  return updateTask(id, (values) => {
    const current = Array.isArray(values.reminders_sent) ? values.reminders_sent.map(String) : [];
    const kept = current.filter((k) => !keys.includes(String(k)));
    if (kept.length === current.length) return false;
    values.reminders_sent = kept;
  });
}

/** 起動時に1回走らせてから、以後1分ごと */
export function startReminderLoop(client) {
  const tick = async () => {
    if (ticking) return; // 前のティックが長引いたら今回は見送る（多重実行させない）
    ticking = true;
    try {
      await runTick(client);
    } catch (error) {
      logger.error('[Reminder] Tick failed', error);
    } finally {
      ticking = false;
    }
  };

  tick();
  timer = setInterval(tick, config.reminders.tickIntervalMs);
  logger.info(`[Reminder] Loop started (every ${config.reminders.tickIntervalMs / 1000}s)`);
  return timer;
}

export function stopReminderLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
