import { promises as fs } from 'fs';
import path from 'path';
import { taskFilePath, tasksDir } from './paths.js';
import { atomicWriteFile, serializeWrite } from './writeQueue.js';
import { takeNextNumber } from './counter.js';
import { parseDocument, stringifyDocument } from '../utils/frontmatter.js';
import { jstIsoString, jstDateString, parseDueInput } from '../utils/datetime.js';
import { logger } from '../utils/logger.js';

// ⚠ このモジュールは意図的にキャッシュを持たない。
//    マイポータル（別プロセス）が同じ .md を編集するので、
//    メモリに覚えるとポータルの編集が永久に反映されなくなる。
//    読み込みは毎回ディスクから。

export const STATUS = {
  TODO: 'todo',
  DONE: 'done',
  DROPPED: 'dropped',
};

const DEFAULT_BODY = '## メモ\n';

/**
 * 1タスク分の .md を読む。
 * @returns {Promise<{ doc: any, task: any } | null>}
 */
export async function readTaskFile(id) {
  let text;
  try {
    text = await fs.readFile(taskFilePath(id), 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const doc = parseDocument(text);
  return { doc, task: toTask(doc.values) };
}

/** 全タスクを毎回ディスクから読む（並び順は番号の昇順） */
export async function listTasks() {
  let files = [];
  try {
    files = await fs.readdir(tasksDir());
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const tasks = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const text = await fs.readFile(path.join(tasksDir(), file), 'utf-8');
      const doc = parseDocument(text);
      const task = toTask(doc.values);
      if (!task.id) continue; // frontmatter の無いゴミファイルは無視
      tasks.push(task);
    } catch (error) {
      // 1ファイル壊れていても他のタスクまで止めない
      logger.warn(`[Tasks] Skipped unreadable file ${file}: ${error.message}`);
    }
  }

  tasks.sort((a, b) => (a.number || 0) - (b.number || 0));
  return tasks;
}

/** 未完了（todo）のみ */
export async function listOpenTasks() {
  const tasks = await listTasks();
  return tasks.filter((t) => t.status === STATUS.TODO);
}

/**
 * 新規タスクを作る。採番とファイル作成を1つの直列タスクにまとめる
 * （分けると番号だけ取ってファイルが作られない隙間ができる）。
 */
export function createTask(fields) {
  return serializeWrite(async () => {
    const now = Date.now();
    const number = await takeNextNumber();
    const id = await allocateId(now);

    const values = {
      id,
      number,
      title: fields.title,
      status: STATUS.TODO,
      channel_id: String(fields.channelId),
      channel_name: fields.channelName || '',
      assignee_id: String(fields.assigneeId),
      assignee_name: fields.assigneeName || '',
      due: fields.due,
      remind_at: fields.remindAt,
      reminders_sent: fields.remindersSent || [],
      created_by: String(fields.createdBy),
      created: jstIsoString(now),
      updated: jstIsoString(now),
      completed_at: null,
    };

    const doc = parseDocument(''); // 空のDocを作ってから値を入れる（順序は CANONICAL に従う）
    doc.values = values;
    doc.body = DEFAULT_BODY;

    await atomicWriteFile(taskFilePath(id), stringifyDocument(doc));
    logger.info(`[Tasks] Created #${number} (${id})`);
    return toTask(values);
  });
}

/**
 * 既存タスクを書き換える。
 * ディスクから読み直してから mutate を当てるので、
 * ポータル側が直前に編集していてもその内容を踏みつぶさない。
 *
 * @param {string} id
 * @param {(values: Record<string, any>, doc: any) => void | false} mutate
 *        false を返すと書き込みを行わない
 * @returns {Promise<{ before: any, after: any } | null>} タスクが無ければ null
 */
export function updateTask(id, mutate) {
  return serializeWrite(async () => {
    const loaded = await readTaskFile(id);
    if (!loaded) return null;

    const { doc } = loaded;
    const before = toTask({ ...doc.values });

    const result = mutate(doc.values, doc);
    if (result === false) return { before, after: before };

    doc.values.updated = jstIsoString(Date.now());
    await atomicWriteFile(taskFilePath(id), stringifyDocument(doc));

    return { before, after: toTask(doc.values) };
  });
}

/** frontmatter の値 → 扱いやすいタスクオブジェクト */
export function toTask(values) {
  const due = values.due === null || values.due === undefined ? '' : String(values.due);
  const parsedDue = parseDueInput(due);

  return {
    id: values.id ? String(values.id) : '',
    number: Number(values.number) || 0,
    title: values.title === null || values.title === undefined ? '' : String(values.title),
    status: values.status ? String(values.status) : STATUS.TODO,
    channelId: values.channel_id ? String(values.channel_id) : '',
    channelName: values.channel_name ? String(values.channel_name) : '',
    assigneeId: values.assignee_id ? String(values.assignee_id) : '',
    assigneeName: values.assignee_name ? String(values.assignee_name) : '',
    due,
    dueMs: parsedDue ? parsedDue.ms : null,
    remindAt: values.remind_at ? String(values.remind_at) : '18:00',
    remindersSent: Array.isArray(values.reminders_sent)
      ? values.reminders_sent.map((v) => String(v))
      : [],
    createdBy: values.created_by ? String(values.created_by) : '',
    created: values.created ? String(values.created) : '',
    updated: values.updated ? String(values.updated) : '',
    completedAt: values.completed_at ?? null,
  };
}

/** id は "tsk-YYYYMMDD-xxxx"（xxxx は16進4桁）。万一衝突したら引き直す */
async function allocateId(nowMs) {
  const datePart = jstDateString(nowMs).replace(/-/g, '');
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    const id = `tsk-${datePart}-${suffix}`;
    try {
      await fs.access(taskFilePath(id));
    } catch {
      return id; // 存在しない = 使える
    }
  }
  throw new Error('Could not allocate a unique task id');
}
