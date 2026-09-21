// frontmatter の最小パーサ / シリアライザ（自前実装。依存を足さないため）
//
// ⚠ この .md はマイポータル（別プロセス）も編集する共有フォーマット。
//    だから「知らないキーは絶対に落とさない」ことが最重要。
//    - 知っているキー: 値を解釈し、書き戻すときは型ごとの決まった書式で出す
//    - 知らないキー  : 生の行をそのまま保持して、そのまま書き戻す（解釈しない＝壊さない）
//
// YAMLのフル実装ではない。扱うのは以下だけで、これはタスクファイルの契約を満たす:
//    key: 素の文字列 / "引用符つき文字列" / 数値 / null / [] / ["a", "b"]
//    key:
//      - ブロック形式の配列

/** 値を素の文字列ではなく引用符つきで書き出すキー（IDや "18:00" が数値・時刻に誤解されないように） */
const QUOTED_KEYS = new Set([
  'channel_id',
  'assignee_id',
  'created_by',
  'remind_at',
]);

/** 常にインライン配列として書き出すキー */
const ARRAY_KEYS = new Set([
  'reminders_sent',
]);

/** 数値として書き出すキー */
const NUMBER_KEYS = new Set([
  'number',
]);

/** 新規ファイルを書くときのキーの並び順（既存ファイルは元の順序を尊重する） */
export const CANONICAL_KEY_ORDER = [
  'id',
  'number',
  'title',
  'status',
  'channel_id',
  'channel_name',
  'assignee_id',
  'assignee_name',
  'due',
  'remind_at',
  'reminders_sent',
  'created_by',
  'created',
  'updated',
  'completed_at',
];

/**
 * @typedef {{ order: string[], values: Record<string, any>, raw: Record<string, string[]>, known: Set<string>, body: string }} Doc
 */

/**
 * frontmatter つき Markdown をパースする。
 * @returns {Doc}
 */
export function parseDocument(text) {
  // known = 「Botが意味を理解しているキー」。ここに無いキーはポータル側が足したものとみなし、
  // 生行のまま保持して書き戻す（未知のキーを保持するのがデータ契約）
  const doc = { order: [], values: {}, raw: {}, known: new Set(CANONICAL_KEY_ORDER), body: '' };

  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') {
    // frontmatter が無いファイルは本文のみとして扱う（壊れたファイルでも落ちないように）
    doc.body = String(text);
    return doc;
  }

  const closeIndex = lines.indexOf('---', 1);
  if (closeIndex === -1) {
    doc.body = String(text);
    return doc;
  }

  const fmLines = lines.slice(1, closeIndex);
  let bodyLines = lines.slice(closeIndex + 1);
  // 区切り直後の空行1つは体裁なので落とす（書き戻すときに必ず1つ入れる）
  if (bodyLines[0] === '') bodyLines = bodyLines.slice(1);
  doc.body = bodyLines.join('\n');

  let currentKey = null;
  for (const line of fmLines) {
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]?(.*)$/);
    if (m) {
      currentKey = m[1];
      doc.order.push(currentKey);
      doc.raw[currentKey] = [line];
      doc.values[currentKey] = parseScalar(m[2]);
      continue;
    }
    // 継続行（ブロック配列の "- x" や、インデントされた行）は直前のキーに属させる
    if (currentKey !== null && /^[ \t]*(-[ \t]|[ \t]+\S)/.test(line)) {
      doc.raw[currentKey].push(line);
      continue;
    }
    // それ以外（空行・コメント等）は無視する。生行は直前キーにぶら下げて保持する
    if (currentKey !== null) doc.raw[currentKey].push(line);
  }

  // ブロック配列を組み立て直す
  for (const key of doc.order) {
    const rawLines = doc.raw[key];
    if (rawLines.length > 1 && doc.values[key] === '') {
      const items = [];
      for (const l of rawLines.slice(1)) {
        const im = l.match(/^[ \t]*-[ \t]*(.*)$/);
        if (im) items.push(parseScalar(im[1]));
      }
      if (items.length > 0) doc.values[key] = items;
    }
  }

  return doc;
}

/**
 * Doc を Markdown 文字列に戻す。
 * 知っているキーは決まった書式で、知らないキーは生行のまま出す。
 * @param {Doc} doc
 */
export function stringifyDocument(doc) {
  const emitted = new Set();
  const out = ['---'];

  for (const key of doc.order) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    if (!(key in doc.values)) continue; // 呼び出し側が明示的に消したキー
    out.push(...emitLines(key, doc.values[key], doc));
  }

  // 元のファイルに無かったキー（新しく足したもの）は決まった順序で末尾に足す
  const extras = Object.keys(doc.values).filter((k) => !emitted.has(k));
  extras.sort((a, b) => canonicalIndex(a) - canonicalIndex(b));
  for (const key of extras) {
    emitted.add(key);
    out.push(...emitLines(key, doc.values[key], doc));
  }

  out.push('---', '');
  const body = doc.body ? doc.body.replace(/\s*$/, '') : '';
  return `${out.join('\n')}\n${body}\n`;
}

function emitLines(key, value, doc) {
  // 知らないキーは触らない。生行をそのまま返すのが一番安全
  if (!doc.known.has(key) && doc.raw[key]) {
    return doc.raw[key];
  }
  return [`${key}: ${formatScalar(key, value)}`];
}

function canonicalIndex(key) {
  const i = CANONICAL_KEY_ORDER.indexOf(key);
  return i === -1 ? CANONICAL_KEY_ORDER.length : i;
}

function parseScalar(rawValue) {
  const v = String(rawValue).trim();
  if (v === '') return '';
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;

  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return splitInlineArray(inner).map((item) => parseScalar(item));
  }

  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)
    || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    return unquote(v);
  }

  if (/^-?\d+$/.test(v)) return Number(v);

  return v;
}

/** 引用符の中のカンマで割らないように、素朴に状態を持って分割する */
function splitInlineArray(inner) {
  const items = [];
  let buf = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === ',') { items.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim() !== '') items.push(buf.trim());
  return items;
}

function unquote(v) {
  const body = v.slice(1, -1);
  if (v[0] === '"') return body.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return body;
}

function formatScalar(key, value) {
  if (ARRAY_KEYS.has(key) || Array.isArray(value)) {
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) return '[]';
    return `[${items.map((i) => quote(String(i))).join(', ')}]`;
  }
  if (value === null || value === undefined) return 'null';
  if (NUMBER_KEYS.has(key)) return String(Number(value));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const s = String(value);
  if (QUOTED_KEYS.has(key)) return quote(s);
  // 素で書くとYAML的に誤読される可能性がある文字列は引用符をつける
  if (needsQuoting(s)) return quote(s);
  return s;
}

function needsQuoting(s) {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (/^[-?*&!|>%@`"'[{]/.test(s)) return true;
  if (s.includes(': ') || s.endsWith(':')) return true;
  if (s.includes(' #')) return true;
  if (s.includes('\n')) return true;
  return false;
}

function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
