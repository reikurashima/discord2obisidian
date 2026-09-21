import { config } from '../config.js';
import { dueLabel } from '../utils/datetime.js';
import { logger } from '../utils/logger.js';

// 公開通知（タスクが登録されたチャンネルに投稿する）。
//
// ⚠ allowedMentions は必ず明示する。
//    省略すると本文中の @everyone / @here / ロールメンションが素通りしてしまう。
//    ここでは parse: [] にして「users に挙げたIDだけが鳴る」状態を強制している。
//    完了通知は users も空 = 本文に <@...> を書かないので誰も鳴らない。

/**
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @param {string} content
 * @param {string[]} mentionUserIds 実際に鳴らすユーザーID
 */
export async function postToChannel(client, channelId, content, mentionUserIds = []) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || typeof channel.send !== 'function') {
    throw new Error(`Channel ${channelId} is not sendable`);
  }
  return channel.send({
    content,
    allowedMentions: { parse: [], users: mentionUserIds },
  });
}

/** 通知の失敗でコマンド自体を失敗させたくない場面用（ログだけ残す） */
export async function postQuietly(client, channelId, content, mentionUserIds = []) {
  try {
    await postToChannel(client, channelId, content, mentionUserIds);
    return true;
  } catch (error) {
    logger.error(`[Notify] Failed to post to channel ${channelId}`, error);
    return false;
  }
}

/**
 * オーナーと担当者のメンション。
 * 担当者＝オーナーのときは1回にまとめる（同じ人に2回飛ばさない）。
 */
export function ownerAndAssigneeMentions(task) {
  const ids = [config.ownerUserId];
  if (task.assigneeId && task.assigneeId !== config.ownerUserId) ids.push(task.assigneeId);
  return { ids, text: ids.map((id) => `<@${id}>`).join(' ') };
}

function assigneeMention(task) {
  const ids = task.assigneeId ? [task.assigneeId] : [];
  return { ids, text: ids.map((id) => `<@${id}>`).join(' ') };
}

/** 登録時 */
export function buildCreatedMessage(task) {
  const m = assigneeMention(task);
  const content = `📌 **#${task.number}** ${m.text} さんに『${task.title}』をお願いしました（期限 ${dueLabel(task.dueMs)}）`;
  return { content, mentionUserIds: m.ids };
}

/**
 * 変更時（担当・期限・通知時刻が変わったときだけ呼ぶ）。
 * 担当者が替わったときは旧担当にも知らせる（「自分はもう見なくていい」が伝わらないため）。
 */
export function buildUpdatedMessage(task, changes, previousAssigneeId) {
  const ids = [];
  if (task.assigneeId) ids.push(task.assigneeId);
  if (previousAssigneeId && previousAssigneeId !== task.assigneeId) ids.push(previousAssigneeId);

  const lines = [
    `✏️ **#${task.number}**『${task.title}』の内容を変更しました`,
    ...changes.map((c) => `・${c.label}: ${c.from} → ${c.to}`),
    ids.map((id) => `<@${id}>`).join(' '),
  ].filter((line) => line !== '');

  return { content: lines.join('\n'), mentionUserIds: ids };
}

/** 3日前 / 1日前 / 期限ちょうど */
export function buildReminderMessage(task, key) {
  const m = ownerAndAssigneeMentions(task);
  const due = dueLabel(task.dueMs);

  let head;
  let body;
  if (key === '-3d') {
    head = `⏰ **#${task.number}**『${task.title}』は期限まであと3日です（期限 ${due}）`;
    body = '進捗はいかがでしょうか？';
  } else if (key === '-1d') {
    head = `⏰ **#${task.number}**『${task.title}』は明日が期限です（期限 ${due}）`;
    body = '遅れそうな場合は一報をいただけると助かります。';
  } else {
    head = `🔔 **#${task.number}**『${task.title}』が期限の時刻になりました（${due}）`;
    body = '提出をお願いします。';
  }

  return { content: `${head}\n${body} ${m.text}`, mentionUserIds: m.ids };
}

/** 完了時（メンションしない） */
export function buildCompletedMessage(task) {
  return {
    content: `✅ タスク #${task.number}『${task.title}』完了！ありがとうございました！`,
    mentionUserIds: [],
  };
}
