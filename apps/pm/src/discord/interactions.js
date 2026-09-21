import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { dueLabel, jstIsoString, parseDueInput, parseTimeOfDay } from '../utils/datetime.js';
import { STATUS, createTask, readTaskFile, updateTask } from '../storage/tasks.js';
import { DEFAULT_REMIND_AT, suppressedKeysAt } from '../reminders/schedule.js';
import { buildDueChoices, buildTaskChoices } from './autocomplete.js';
import {
  buildCompletedMessage,
  buildCreatedMessage,
  buildUpdatedMessage,
  postQuietly,
} from './notify.js';

// ⚠ このBotに指示できるのはオーナー1人だけ。
//    ロール（権限）では判定しない。ロールは付け外しできるし、
//    サーバー管理者は default_member_permissions を無視して実行できてしまうため。
//    必ず user.id そのものを見る。
function isOwner(interaction) {
  return interaction.user?.id === config.ownerUserId;
}

/** すべての応答は ephemeral（本人にしか見えない）。公開したい内容は notify.js から別途投稿する */
function replyPrivate(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * interactionCreate の入口。
 * @param {import('discord.js').Client} client
 * @param {any} interaction
 */
export async function handleInteraction(client, interaction) {
  try {
    if (interaction.isAutocomplete?.()) {
      // オートコンプリートも他人には一切返さない（未完了タスクの一覧は業務情報なので）
      if (!isOwner(interaction)) {
        await interaction.respond([]);
        return;
      }
      await handleAutocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand?.()) return;

    if (!isOwner(interaction)) {
      logger.warn(`[Auth] Rejected /${interaction.commandName} from user ${interaction.user?.id}`);
      await replyPrivate(interaction, '⛔ このBotに指示できるのはオーナーのみです。');
      return;
    }

    switch (interaction.commandName) {
      case 'task': return await handleTask(client, interaction);
      case 'complete': return await handleComplete(client, interaction);
      case 'task-edit': return await handleTaskEdit(client, interaction);
      case 'task-drop': return await handleTaskDrop(client, interaction);
      default:
        await replyPrivate(interaction, `未知のコマンドです: /${interaction.commandName}`);
    }
  } catch (error) {
    logger.error(`[Interaction] Failed to handle ${interaction?.commandName}`, error);
    try {
      if (interaction.isAutocomplete?.()) return;
      if (interaction.replied || interaction.deferred) return;
      await replyPrivate(interaction, '⚠️ 処理中にエラーが発生しました。ログを確認してください。');
    } catch { /* 応答すら返せない場合は諦める（ログには残っている） */ }
  }
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);

  if (focused.name === 'task') {
    await interaction.respond(await buildTaskChoices(focused.value));
    return;
  }
  if (focused.name === 'due') {
    await interaction.respond(buildDueChoices(focused.value));
    return;
  }
  await interaction.respond([]);
}

// ---------------------------------------------------------------- /task

async function handleTask(client, interaction) {
  const assignee = interaction.options.getUser('assignee');
  const dueInput = interaction.options.getString('due');
  const title = (interaction.options.getString('title') || '').trim();
  const remindInput = interaction.options.getString('remind_at');

  const due = parseDueInput(dueInput);
  if (!due) {
    await replyPrivate(interaction, `⚠️ 期限の形式が違います: \`${dueInput}\`\n\`YYYY-MM-DD\` または \`YYYY-MM-DD HH:mm\` で指定してください。`);
    return;
  }

  const remind = remindInput ? parseTimeOfDay(remindInput) : parseTimeOfDay(DEFAULT_REMIND_AT);
  if (!remind) {
    await replyPrivate(interaction, `⚠️ 通知時刻の形式が違います: \`${remindInput}\`\n\`HH:mm\` で指定してください。`);
    return;
  }

  if (!title) {
    await replyPrivate(interaction, '⚠️ 内容が空です。');
    return;
  }

  // 期限まで3日を切って登録された場合、もう過ぎているタイミングは最初から送信済み扱いにする
  const now = Date.now();
  const remindersSent = suppressedKeysAt(
    { dueMs: due.ms, remindAt: remind.text, remindersSent: [] },
    now,
  );

  const task = await createTask({
    title,
    channelId: interaction.channelId,
    channelName: interaction.channel?.name || '',
    assigneeId: assignee.id,
    assigneeName: resolveDisplayName(interaction, 'assignee', assignee),
    due: due.text,
    remindAt: remind.text,
    remindersSent,
    createdBy: interaction.user.id,
  });

  const message = buildCreatedMessage(task);
  await postQuietly(client, task.channelId, message.content, message.mentionUserIds);

  const skipped = remindersSent.length > 0
    ? `\n（${remindersSent.map(keyLabel).join('・')}の通知は登録時点で過ぎているため送りません）`
    : '';
  await replyPrivate(
    interaction,
    `✅ タスク #${task.number} を登録しました。\n担当: ${task.assigneeName} / 期限: ${dueLabel(task.dueMs)} / 通知: ${task.remindAt}${skipped}`,
  );
}

// ------------------------------------------------------------ /complete

async function handleComplete(client, interaction) {
  const id = interaction.options.getString('task');

  const result = await updateTask(id, (values) => {
    if (values.status !== STATUS.TODO) return false;
    values.status = STATUS.DONE;
    values.completed_at = jstIsoString(Date.now());
  });

  if (!result) {
    await replyPrivate(interaction, '⚠️ そのタスクが見つかりませんでした。');
    return;
  }
  if (result.after.status !== STATUS.DONE) {
    await replyPrivate(interaction, `⚠️ タスク #${result.before.number} は既に「${result.before.status}」です。`);
    return;
  }

  const message = buildCompletedMessage(result.after);
  await postQuietly(client, result.after.channelId, message.content, message.mentionUserIds);

  await replyPrivate(interaction, `✅ タスク #${result.after.number} を完了にしました。`);
}

// ----------------------------------------------------------- /task-edit

async function handleTaskEdit(client, interaction) {
  const id = interaction.options.getString('task');
  const newAssignee = interaction.options.getUser('assignee');
  const dueInput = interaction.options.getString('due');
  const newTitle = interaction.options.getString('title');
  const remindInput = interaction.options.getString('remind_at');

  if (!newAssignee && !dueInput && !newTitle && !remindInput) {
    await replyPrivate(interaction, '⚠️ 変更する項目を1つ以上指定してください。');
    return;
  }

  let due = null;
  if (dueInput) {
    due = parseDueInput(dueInput);
    if (!due) {
      await replyPrivate(interaction, `⚠️ 期限の形式が違います: \`${dueInput}\``);
      return;
    }
  }

  let remind = null;
  if (remindInput) {
    remind = parseTimeOfDay(remindInput);
    if (!remind) {
      await replyPrivate(interaction, `⚠️ 通知時刻の形式が違います: \`${remindInput}\``);
      return;
    }
  }

  const existing = await readTaskFile(id);
  if (!existing) {
    await replyPrivate(interaction, '⚠️ そのタスクが見つかりませんでした。');
    return;
  }

  const changes = [];          // 公開通知に出す変更（担当・期限・通知時刻）
  const quietChanges = [];     // 本人にだけ伝える変更（内容）
  let scheduleChanged = false;

  const result = await updateTask(id, (values) => {
    if (newAssignee) {
      const name = resolveDisplayName(interaction, 'assignee', newAssignee);
      if (String(values.assignee_id) !== newAssignee.id) {
        changes.push({ label: '担当', from: String(values.assignee_name || '—'), to: name });
      }
      values.assignee_id = newAssignee.id;
      values.assignee_name = name;
    }

    if (due && String(values.due) !== due.text) {
      const before = parseDueInput(String(values.due));
      changes.push({
        label: '期限',
        from: before ? dueLabel(before.ms) : String(values.due),
        to: dueLabel(due.ms),
      });
      values.due = due.text;
      scheduleChanged = true;
    }

    if (remind && String(values.remind_at) !== remind.text) {
      changes.push({ label: '通知時刻', from: String(values.remind_at), to: remind.text });
      values.remind_at = remind.text;
      scheduleChanged = true;
    }

    if (newTitle && String(values.title) !== newTitle.trim()) {
      quietChanges.push({ label: '内容', from: String(values.title), to: newTitle.trim() });
      values.title = newTitle.trim();
    }

    if (changes.length === 0 && quietChanges.length === 0) return false;

    // 期限・通知時刻が動いたら通知の予定も引き直す。
    // 送信済みの記録を残したままだと、期限を延ばしても「3日前」が二度と来ない
    if (scheduleChanged) {
      const nowMs = Date.now();
      values.reminders_sent = suppressedKeysAt(
        {
          dueMs: parseDueInput(String(values.due))?.ms ?? null,
          remindAt: String(values.remind_at),
          remindersSent: [],
        },
        nowMs,
      );
    }
  });

  if (!result) {
    // 読んだ直後にポータル側が消した、など。落とさずに知らせる
    await replyPrivate(interaction, '⚠️ そのタスクが見つかりませんでした。');
    return;
  }

  if (changes.length === 0 && quietChanges.length === 0) {
    await replyPrivate(interaction, 'ℹ️ 変更はありませんでした（指定された値が現在と同じです）。');
    return;
  }

  if (changes.length > 0) {
    const message = buildUpdatedMessage(result.after, changes, existing.task.assigneeId);
    await postQuietly(client, result.after.channelId, message.content, message.mentionUserIds);
  }

  const all = [...changes, ...quietChanges].map((c) => `・${c.label}: ${c.from} → ${c.to}`);
  const note = changes.length === 0
    ? '\n（内容のみの変更なので、チャンネルへの通知はしていません）'
    : '';
  await replyPrivate(
    interaction,
    `✅ タスク #${result.after.number} を更新しました。\n${all.join('\n')}${note}`,
  );
}

// ----------------------------------------------------------- /task-drop

async function handleTaskDrop(client, interaction) {
  const id = interaction.options.getString('task');

  const result = await updateTask(id, (values) => {
    if (values.status !== STATUS.TODO) return false;
    values.status = STATUS.DROPPED;
  });

  if (!result) {
    await replyPrivate(interaction, '⚠️ そのタスクが見つかりませんでした。');
    return;
  }
  if (result.after.status !== STATUS.DROPPED) {
    await replyPrivate(interaction, `⚠️ タスク #${result.before.number} は既に「${result.before.status}」です。`);
    return;
  }

  // 取り下げはチャンネルに出さない（要件の通知表に無い。
  // 「やっぱり無し」を公開で流しても受け手の役に立たないため）
  await replyPrivate(interaction, `🗑 タスク #${result.after.number}『${result.after.title}』を取り下げました。`);
}

// ---------------------------------------------------------------- utils

/** サーバーでの表示名を優先する（本名運用でもニックネーム運用でも自然な表示になるように） */
function resolveDisplayName(interaction, optionName, user) {
  let member = null;
  try {
    member = interaction.options.getMember?.(optionName) ?? null;
  } catch { /* メンバーが取れない場合は user 側で代替する */ }
  return member?.displayName || member?.nickname || user.globalName || user.username || user.id;
}

function keyLabel(key) {
  if (key === '-3d') return '3日前';
  if (key === '-1d') return '1日前';
  return '期限時刻';
}
