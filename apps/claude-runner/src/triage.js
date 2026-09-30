// task.triage（マイポータルの「雑なメモ → タスク」振り分け）専用の部品。
// kinds.js が肥大化しないよう、この kind だけが使うものをここに分けてある。
//
//   validateTriageInput … ジョブの input の形を見る（契約: text は4000文字まで 等）
//   buildTriageContext  … プロンプトに添える「今日の曜日と先6週間のカレンダー」
//
// ⚠ 受け渡しの契約（input の形）はマイポータル側と確定済み。勝手に変えないこと。

import { isValidDate } from './schemas/tasks.v1.js';

// 契約: メモは最大4000文字
export const MAX_TEXT_CHARS = 4000;
// 契約には無い上限。列が数百もあることは無いので、壊れた入力でプロンプトを膨らませないための安全弁
export const MAX_PROJECTS = 200;
// プロンプトに添えるカレンダーの日数（「来月頭」くらいまで届く長さ）
const CALENDAR_DAYS = 42;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * task.triage の input を検証する。問題が無ければ空配列。
 *
 * ⚠ エラー文にメモの中身を入れない（長さ・型だけ）。
 * ⚠ 未知のキーは弾かない。依頼側が後から項目を足しても runner の入れ替えを待たずに済むように
 *    （使わないキーはプロンプトの構造化入力に載るだけで害は無い）
 */
export function validateTriageInput(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['input must be an object'];
  }

  if (typeof input.text !== 'string' || input.text.trim() === '') {
    errors.push('input.text must be a non-empty string');
  } else if ([...input.text].length > MAX_TEXT_CHARS) {
    errors.push(`input.text must be at most ${MAX_TEXT_CHARS} characters (got ${[...input.text].length})`);
  }

  // today が無いと「明日」「来週金曜」を日付に直せない。推測させないため必須にする
  if (!isValidDate(input.today)) {
    errors.push('input.today must be a real date "YYYY-MM-DD"');
  }

  if (!Array.isArray(input.projects)) {
    errors.push('input.projects must be an array');
  } else if (input.projects.length > MAX_PROJECTS) {
    errors.push(`input.projects must have at most ${MAX_PROJECTS} items`);
  } else {
    const seen = new Set();
    input.projects.forEach((p, i) => {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) {
        errors.push(`input.projects[${i}] must be an object`);
        return;
      }
      if (typeof p.id !== 'string' || p.id === '') errors.push(`input.projects[${i}].id must be a non-empty string`);
      else if (seen.has(p.id)) errors.push(`input.projects[${i}].id is duplicated`);
      else seen.add(p.id);
      if (typeof p.name !== 'string') errors.push(`input.projects[${i}].name must be a string`);
    });
  }
  return errors;
}

/**
 * プロンプトに添える参考情報（runner が計算した確かな値）。
 *
 * ⚠ なぜ runner が計算するか: モデルに「2026-09-30 は何曜日か」から考えさせると、
 *    曜日の取り違えで「来週金曜」が1日ずれることがある。暦は機械的に出せるので、
 *    こちらで表にして渡し、モデルには表を引かせるだけにする。
 */
export function buildTriageContext(job) {
  const today = job?.input?.today;
  if (!isValidDate(today)) return [];
  const [y, m, d] = today.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);

  const lines = [];
  lines.push(`- 今日（input.today）は ${fmt(base)} です。`);
  lines.push('- 週は**月曜始まり**として扱います。「今週」＝今日を含む月〜日、「来週」＝その次の月〜日です。');
  lines.push(`- 今日から${CALENDAR_DAYS}日分の暦（日付と曜日。週の区切りに空行）:`);
  lines.push('```');
  for (let i = 0; i < CALENDAR_DAYS; i += 1) {
    const t = base + i * 86400000;
    const dow = new Date(t).getUTCDay();
    if (i > 0 && dow === 1) lines.push('');
    const label = i === 0 ? '  ← 今日' : i === 1 ? '  ← 明日' : i === 2 ? '  ← 明後日' : '';
    lines.push(`${fmt(t)}${label}`);
  }
  lines.push('```');
  return lines;
}

function fmt(t) {
  const dt = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}(${WEEKDAYS[dt.getUTCDay()]})`;
}
