// 日時は全て「JST固定」で計算する。
//
// なぜ process.env.TZ に頼らないか:
//   TZ の設定漏れで UTC 動作になり、日付の変わり目がズレる事故が既存Botで起きている。
//   期限・通知時刻は業務の約束そのものなので、環境設定に結果が左右されない方がよい。
//   そこで「+09:00 固定オフセットの算術」で組む。日本には夏時間が無いので固定で正しい。
//   （docker-compose 側の TZ=Asia/Tokyo は、ログの時刻を読みやすくするために別途入れている）

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** epoch ms → JSTでの年月日時分（getUTC* を +9h ずらした値に対して使う） */
export function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(), // 0=日
  };
}

/** JSTの年月日時分 → epoch ms */
export function jstToMs(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - JST_OFFSET_MS;
}

/** その瞬間を含むJSTの日の 00:00 の epoch ms */
export function startOfJstDay(ms) {
  const p = jstParts(ms);
  return jstToMs(p.year, p.month, p.day, 0, 0, 0);
}

/** JSTの「その日の HH:mm」の epoch ms */
export function atJstTimeOfDay(dayMs, { hour, minute }) {
  const p = jstParts(dayMs);
  return jstToMs(p.year, p.month, p.day, hour, minute, 0);
}

/** "YYYY-MM-DD" */
export function jstDateString(ms) {
  const p = jstParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM-DD HH:mm" — .md の due に書く正規形 */
export function jstDueString(ms) {
  const p = jstParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2026-09-22T01:20:00+09:00" — created / updated に書く形 */
export function jstIsoString(ms) {
  const p = jstParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+09:00`;
}

/** 通知文用の短い表示: "10/15 18:00" */
export function dueLabel(ms) {
  const p = jstParts(ms);
  return `${p.month}/${p.day} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** オートコンプリート表示用: "10-15" */
export function shortDateLabel(ms) {
  const p = jstParts(ms);
  return `${pad(p.month)}-${pad(p.day)}`;
}

export function weekdayJa(ms) {
  return WEEKDAY_JA[jstParts(ms).weekday];
}

/**
 * 期限入力のパース。
 * 受け付けるのは "YYYY-MM-DD" と "YYYY-MM-DD HH:mm"（T区切りも可）。
 * 時刻を省略した場合は 23:59 とみなす（データ契約どおり）。
 *
 * @returns {{ ms: number, text: string } | null} 不正なら null
 */
export function parseDueInput(input) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 23 : Number(m[4]);
  const minute = m[5] === undefined ? 59 : Number(m[5]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const ms = jstToMs(year, month, day, hour, minute, 0);

  // 2026-02-31 のような存在しない日を弾く（Date.UTC は繰り上げてしまうため往復で確認）
  const p = jstParts(ms);
  if (p.year !== year || p.month !== month || p.day !== day) return null;

  return { ms, text: jstDueString(ms) };
}

/**
 * "HH:mm" のパース（remind_at 用）。
 * @returns {{ hour: number, minute: number, text: string } | null}
 */
export function parseTimeOfDay(input) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, text: `${pad(hour)}:${pad(minute)}` };
}

function pad(n) {
  return String(n).padStart(2, '0');
}
