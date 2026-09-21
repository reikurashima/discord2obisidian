import { listOpenTasks } from '../storage/tasks.js';
import {
  MS_PER_DAY,
  jstDateString,
  jstParts,
  jstToMs,
  parseDueInput,
  shortDateLabel,
  startOfJstDay,
  weekdayJa,
} from '../utils/datetime.js';

// Discordのオートコンプリートは最大25件。name/value とも100文字まで。
const MAX_CHOICES = 25;
const MAX_LEN = 100;

/**
 * 期限の候補。「今日」「来週水曜」のような相対指定を、実際の日付に解決して並べる。
 * 値は YYYY-MM-DD（時刻を足したい場合は手入力すればそのまま通る）。
 */
export function buildDueChoices(input, nowMs = Date.now()) {
  const today = startOfJstDay(nowMs);
  const candidates = [];

  const push = (label, dayMs) => {
    candidates.push({ label, dayMs });
  };

  push('今日', today);
  push('明日', today + MS_PER_DAY);
  push('明後日', today + 2 * MS_PER_DAY);
  push('今週末（土）', nextWeekday(today, 6));
  push('1週間後', today + 7 * MS_PER_DAY);

  // 来週の月〜金。「来週◯曜」を指で選べるようにするのが目的
  const nextMonday = nextWeekday(today + MS_PER_DAY, 1);
  const weekdayNames = ['月', '火', '水', '木', '金'];
  weekdayNames.forEach((name, i) => push(`来週${name}曜`, nextMonday + i * MS_PER_DAY));

  push('今月末', endOfJstMonth(today));

  const choices = [];

  // 入力がすでに日付として成立しているなら、それを最優先で出す
  // （オートコンプリート付きの項目は候補を選ばないと確定しづらいため、逃げ道を用意する）
  const typed = parseDueInput(input);
  if (typed) {
    choices.push({ name: `${input.trim()} をそのまま使う`, value: input.trim() });
  }

  for (const c of candidates) {
    const value = jstDateString(c.dayMs);
    const name = `${c.label}（${value} ${weekdayJa(c.dayMs)}）`;
    if (choices.some((x) => x.value === value)) continue;
    if (!matches(input, `${c.label} ${name} ${value}`)) continue;
    choices.push({ name: truncate(name), value });
  }

  return choices.slice(0, MAX_CHOICES);
}

/**
 * タスク選択の候補。未完了（todo）だけを出す。
 * 表示は「#12 田中 / 10-15 / 修正版データの提出」、値はタスクID。
 */
export async function buildTaskChoices(input) {
  const tasks = await listOpenTasks();

  const choices = [];
  for (const task of tasks) {
    const date = task.dueMs ? shortDateLabel(task.dueMs) : '??-??';
    const label = `#${task.number} ${task.assigneeName} / ${date} / ${task.title}`;
    if (!matches(input, `${label} ${task.id}`)) continue;
    choices.push({ name: truncate(label), value: task.id });
    if (choices.length >= MAX_CHOICES) break;
  }
  return choices;
}

function matches(input, haystack) {
  const q = String(input ?? '').trim().toLowerCase();
  if (q === '') return true;
  return haystack.toLowerCase().includes(q);
}

function truncate(s) {
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s;
}

/** fromMs 以降で最初に来る指定曜日（fromMs がその曜日ならその日） */
function nextWeekday(fromMs, weekday) {
  const diff = (weekday - jstParts(fromMs).weekday + 7) % 7;
  return fromMs + diff * MS_PER_DAY;
}

/** 今月末（JSTの0:00）。翌月1日の1日前として求める */
function endOfJstMonth(dayMs) {
  const p = jstParts(dayMs);
  return jstToMs(p.year, p.month + 1, 1) - MS_PER_DAY;
}
