// invoice.v1 — 請求書PDF（外注先から届いたもの）から読み取った会計用の項目。
//
// ⚠ ここで返るのは "読み取り結果" であって、確定した会計データではない。
//    登録・支払予定の作成は依頼側（マイポータル）が人の確認を経て行う。runner は副作用を持たない。
//
// ⚠ 受け渡しの契約（キー・型）はマイポータル側と確定済み。勝手に変えないこと。

export const name = 'invoice.v1';

export function describe() {
  return [
    '```jsonc',
    '{',
    '  "issuer_name":    "string | null",      // 請求元（この請求書を発行した外注先）の名前',
    '  "issue_date":     "YYYY-MM-DD | null",  // 発行日（請求日）',
    '  "due_date":       "YYYY-MM-DD | null",  // 支払期日・振込期限',
    '  "amount_excl":    "integer | null",     // 税抜金額（円）',
    '  "tax_amount":     "integer | null",     // 消費税額（円）',
    '  "amount_incl":    "integer | null",     // 税込金額（円）。源泉徴収がある場合は差し引く前の請求額',
    '  "withholding":    "integer | null",     // 源泉徴収税額（円）。記載が無ければ null',
    '  "invoice_number": "string | null",      // 適格請求書発行事業者の登録番号（"T" + 13桁の数字）',
    '  "project_hint":   "string | null"       // 件名・案件名',
    '}',
    '```',
    '- 9個のキーを**すべて**出力すること（値が無いキーも省略せず null にする）。',
    '- **読み取れない項目・書かれていない項目は推測せず null にすること。**',
    '- 金額はカンマ・円記号・「円」を付けない整数（例: `110000`）。文字列にしないこと。',
    '- 日付は `YYYY-MM-DD`（例: `2026-09-30`）。',
    '- `invoice_number` は `T` に続く13桁の数字（例: `T1234567890123`）。形式が合わなければ null。',
  ].join('\n');
}

export const KEYS = [
  'issuer_name', 'issue_date', 'due_date',
  'amount_excl', 'tax_amount', 'amount_incl', 'withholding',
  'invoice_number', 'project_hint',
];

const STRING_KEYS = ['issuer_name', 'invoice_number', 'project_hint'];
const DATE_KEYS = ['issue_date', 'due_date'];
const AMOUNT_KEYS = ['amount_excl', 'tax_amount', 'amount_incl', 'withholding'];

const INVOICE_NUMBER_RE = /^T\d{13}$/;

/**
 * 検証の前に一度だけ通す軽い正規化。**値の中身を推測で補うことはしない。**
 *
 * - invoice_number: 空白・ハイフンを除き、全角を半角に寄せたうえで `^T\d{13}$` に合わなければ null に落とす
 *   （契約: 「形式が合わなければ null」。番号だけのために結果全体を捨てるのは割に合わないため）
 * - 文字列項目の空文字・空白だけ: null に寄せる（「無い」の表し方の揺れ）
 *
 * ⚠ キーの過不足や型違いには手を付けない。それは validate で全か無かで弾く。
 */
export function normalize(value) {
  if (!isPlainObject(value)) return value;
  const out = { ...value };

  for (const k of STRING_KEYS) {
    if (typeof out[k] === 'string' && out[k].trim() === '') out[k] = null;
  }

  if (typeof out.invoice_number === 'string') {
    const compact = out.invoice_number.normalize('NFKC').replace(/[\s\-‐‑–—−ー]/g, '').toUpperCase();
    out.invoice_number = INVOICE_NUMBER_RE.test(compact) ? compact : null;
  }
  return out;
}

export function validate(value) {
  // ⚠ エラー文には**値を入れない**（キー名と「何が違うか」だけ）。
  //   invoice.extract は失敗時に生の出力を残さず、このエラー文だけを logTail / failed に残すため。
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['root must be a JSON object'] };
  }
  checkExactKeys(value, KEYS, 'root', errors);

  for (const k of STRING_KEYS) {
    if (k in value) requireStringOrNull(value[k], `root.${k}`, errors);
  }

  // 日付は形式に加えて「実在する日付か」まで見る（2026-02-30 のような値を通さない）
  for (const k of DATE_KEYS) {
    if (!(k in value) || value[k] === null) continue;
    if (!isValidDate(value[k])) errors.push(`root.${k} must be a real date "YYYY-MM-DD" or null`);
  }

  // 金額は 0 以上の整数（文字列の "110,000" や 1.5 は型違いとして弾く）
  for (const k of AMOUNT_KEYS) {
    if (!(k in value) || value[k] === null) continue;
    if (!Number.isSafeInteger(value[k]) || value[k] < 0) {
      errors.push(`root.${k} must be a non-negative integer or null`);
    }
  }

  // normalize を通っていれば必ず満たすが、通さずに呼ばれた場合の保険
  if (typeof value.invoice_number === 'string' && !INVOICE_NUMBER_RE.test(value.invoice_number)) {
    errors.push('root.invoice_number must match ^T\\d{13}$ or be null');
  }

  return { ok: errors.length === 0, errors };
}

// ---- helpers ----

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireStringOrNull(v, where, errors) {
  if (v === null) return;
  if (typeof v !== 'string') errors.push(`${where} must be a string or null`);
}

function isValidDate(v) {
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

/**
 * エラー文に載せるキー名。
 * ⚠ このスキーマのエラー文は logTail / failed に残る（invoice.extract は生の出力を残さない方針）。
 *   未知キーの名前はモデルの出力そのものなので、取引先名などが紛れ込み得る。
 *   英数字の識別子らしいものだけ名前を出し、それ以外は伏せる。
 */
function safeKey(k) {
  return /^[A-Za-z0-9_]{1,40}$/.test(k) ? k : '(英数字以外の未知キー)';
}
