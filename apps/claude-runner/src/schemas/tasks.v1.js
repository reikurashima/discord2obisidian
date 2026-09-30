// tasks.v1 — 本人が貼った雑なメモを、マイポータルのタスクに振り分けた結果。
//
// ⚠ ここで返るのは "振り分け案" であって、登録済みのタスクではない。
//    実際の登録（どの列に入れるか・受信箱に回すか）は依頼側（マイポータル）が行う。runner は副作用を持たない。
//
// ⚠ 受け渡しの契約（キー・型）はマイポータル側と確定済み。勝手に変えないこと。
//
// ⚠ projectId の正否は「ジョブの input.projects に載っている id か」で決まる。
//    スキーマ単体では判断できないので、runner が normalize / validate の第2引数に { job } を渡す。
//    （他のスキーマは第2引数を受け取らないだけで、挙動は変わらない）

export const name = 'tasks.v1';

// 1件のタスクのキー（この5つちょうど）
export const TASK_KEYS = ['title', 'projectId', 'notes', 'dueDate', 'starred'];

// 契約: title は200文字以内
export const MAX_TITLE_CHARS = 200;
// 契約には無い上限。メモは最大4000文字なので、正常ならこの数には届かない。
// 暴走した出力（同じタスクの繰り返しなど）をそのまま登録させないための安全弁
export const MAX_TASKS = 100;
// notes も同じく安全弁（メモ全体より長い補足は、写し間違いか暴走）
export const MAX_NOTES_CHARS = 4000;

export function describe() {
  return [
    '```jsonc',
    '{',
    '  "tasks": [',
    '    {',
    '      "title":     "string",              // 整えたタスク名（200文字以内・空文字不可）',
    '      "projectId": "string | null",       // input.projects のいずれかの id。合う列が無い・自信が無ければ null',
    '      "notes":     "string",              // 補足。無ければ空文字 ""',
    '      "dueDate":   "YYYY-MM-DD | null",   // 期限。メモに書かれていなければ null',
    '      "starred":   false                  // 「急ぎ」「重要」「!!」などがあれば true。それ以外は false',
    '    }',
    '  ]',
    '}',
    '```',
    '- タスクが1件も無ければ `{"tasks": []}` を返すこと。',
    '- 各タスクは5個のキーを**すべて**出力すること（値が無いキーも省略しない）。',
    '- `projectId` は input.projects に**実在する id をそのまま**書くこと。列名（name）を書かないこと。新しい id を作らないこと。',
    '- `starred` は真偽値（`true` / `false`）。文字列にしないこと。',
  ].join('\n');
}

/**
 * 検証の前に一度だけ通す軽い正規化。**メモに無い値を推測で補うことはしない。**
 *
 * - title: 前後の空白を落とす（中身は変えない。200文字超は validate で弾く）
 * - projectId: input.projects に無い id・空文字は null に落とす
 *   （契約: 「合うものが無ければ null」＝ポータル側で受信箱に入る。
 *    列の取り違え1件のために結果全体を捨てるのは割に合わないため。invoice.v1 の登録番号と同じ考え方）
 * - notes: null は空文字に寄せる（「無い」の表し方の揺れ）
 * - dueDate: 空文字は null に寄せる
 *
 * ⚠ キーの過不足や型違いには手を付けない。それは validate で全か無かで弾く。
 */
export function normalize(value, ctx = {}) {
  if (!isPlainObject(value) || !Array.isArray(value.tasks)) return value;
  const allowedIds = projectIdsOf(ctx.job);

  const tasks = value.tasks.map((t) => {
    if (!isPlainObject(t)) return t;
    const out = { ...t };
    if (typeof out.title === 'string') out.title = out.title.trim();
    if ('projectId' in out) {
      if (typeof out.projectId === 'string' && !allowedIds.has(out.projectId)) out.projectId = null;
    }
    if ('notes' in out && out.notes === null) out.notes = '';
    if (typeof out.notes === 'string') out.notes = out.notes.trim();
    if (out.dueDate === '') out.dueDate = null;
    return out;
  });
  return { ...value, tasks };
}

export function validate(value, ctx = {}) {
  // ⚠ エラー文には**値を入れない**（キー名と「何が違うか」だけ）。
  //   メモは本人の予定・取引先名などを含み得るため、logTail に値を重ねて残さない
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['root must be a JSON object'] };
  }
  checkExactKeys(value, ['tasks'], 'root', errors);
  if (!Array.isArray(value.tasks)) {
    errors.push('root.tasks must be an array');
    return { ok: false, errors };
  }
  if (value.tasks.length > MAX_TASKS) {
    errors.push(`root.tasks must have at most ${MAX_TASKS} items (got ${value.tasks.length})`);
    return { ok: false, errors };
  }

  const allowedIds = projectIdsOf(ctx.job);

  value.tasks.forEach((t, i) => {
    const where = `tasks[${i}]`;
    if (!isPlainObject(t)) {
      errors.push(`${where} must be an object`);
      return;
    }
    checkExactKeys(t, TASK_KEYS, where, errors);

    if (typeof t.title !== 'string' || t.title.trim().length === 0) {
      errors.push(`${where}.title must be a non-empty string`);
    } else if ([...t.title].length > MAX_TITLE_CHARS) {
      // ⚠ 切り詰めて通すことはしない。途中で切れたタスク名を黙って登録させないため
      errors.push(`${where}.title must be at most ${MAX_TITLE_CHARS} characters`);
    }

    // normalize を通っていれば必ず満たすが、通さずに呼ばれた場合の保険
    if ('projectId' in t && t.projectId !== null) {
      if (typeof t.projectId !== 'string') errors.push(`${where}.projectId must be a string or null`);
      else if (!allowedIds.has(t.projectId)) errors.push(`${where}.projectId must be one of input.projects[].id or null`);
    }

    if ('notes' in t) {
      if (typeof t.notes !== 'string') errors.push(`${where}.notes must be a string`);
      else if ([...t.notes].length > MAX_NOTES_CHARS) errors.push(`${where}.notes must be at most ${MAX_NOTES_CHARS} characters`);
    }

    // 期限は形式に加えて「実在する日付か」まで見る（2026-02-30 のような値を通さない）
    if ('dueDate' in t && t.dueDate !== null && !isValidDate(t.dueDate)) {
      errors.push(`${where}.dueDate must be a real date "YYYY-MM-DD" or null`);
    }

    if ('starred' in t && typeof t.starred !== 'boolean') {
      errors.push(`${where}.starred must be a boolean`);
    }
  });

  return { ok: errors.length === 0, errors };
}

// ---- helpers ----

/** ジョブの input.projects から、選んでよい id の集合を作る（無ければ空＝全部 null しか許さない） */
function projectIdsOf(job) {
  const projects = job?.input?.projects;
  const ids = new Set();
  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (isPlainObject(p) && typeof p.id === 'string' && p.id !== '') ids.add(p.id);
    }
  }
  return ids;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isValidDate(v) {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function checkExactKeys(obj, allowed, where, errors) {
  for (const k of allowed) {
    if (!(k in obj)) errors.push(`${where}.${k} is missing`);
  }
  // ⚠ 未知キーも不一致として弾く（全か無か）
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}.${safeKey(k)} is not allowed`);
  }
}

/** エラー文に載せるキー名。英数字の識別子らしいものだけ名前を出す（モデルの出力をそのまま載せない） */
function safeKey(k) {
  return /^[A-Za-z0-9_]{1,40}$/.test(k) ? k : '(英数字以外の未知キー)';
}
