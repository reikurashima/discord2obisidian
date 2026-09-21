// digest.v1 — Discordのログから「タスク候補」を抜き出した結果。
//
// ⚠ ここで返るのは "候補" であって、タスクそのものではない。
//    実際の登録（.md の作成・Discordへの投稿）は依頼側（PM Bot）が人の確認を経て行う。
//    runner は副作用を持たない。

export const name = 'digest.v1';

export function describe() {
  return [
    '```jsonc',
    '{',
    '  "candidates": [',
    '    {',
    '      "channel_id":    "string",             // 発言があったチャンネルID',
    '      "channel_name":  "string",             // 同 チャンネル名',
    '      "assignee_name": "string | null",      // 担当者名。読み取れなければ null',
    '      "assignee_id":   "string | null",      // 担当者のDiscordユーザーID。分からなければ null',
    '      "due":           "YYYY-MM-DD | null",  // 期限。読み取れなければ null',
    '      "title":         "string",             // タスクの内容を一文で',
    '      "evidence": {                          // 根拠となった実際の発言',
    '        "text":        "string",',
    '        "author":      "string",',
    '        "posted_at":   "string | null",',
    '        "message_url": "string | null"',
    '      }',
    '    }',
    '  ]',
    '}',
    '```',
    '- 候補が1件も無ければ `{"candidates": []}` を返すこと。',
    '- 推測で値を埋めないこと。読み取れない項目は null にすること。',
    '- `evidence.text` は引用データ中の文言をそのまま写すこと（要約しない）。',
  ].join('\n');
}

const CANDIDATE_KEYS = [
  'channel_id', 'channel_name', 'assignee_name', 'assignee_id', 'due', 'title', 'evidence',
];
const EVIDENCE_KEYS = ['text', 'author', 'posted_at', 'message_url'];

export function validate(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['root must be a JSON object'] };
  }
  checkExactKeys(value, ['candidates'], 'root', errors);

  if (!Array.isArray(value.candidates)) {
    errors.push('root.candidates must be an array');
    return { ok: false, errors };
  }

  value.candidates.forEach((c, i) => {
    const where = `candidates[${i}]`;
    if (!isPlainObject(c)) {
      errors.push(`${where} must be an object`);
      return;
    }
    checkExactKeys(c, CANDIDATE_KEYS, where, errors);

    requireString(c.channel_id, `${where}.channel_id`, errors);
    requireString(c.channel_name, `${where}.channel_name`, errors);
    requireString(c.title, `${where}.title`, errors);
    requireStringOrNull(c.assignee_name, `${where}.assignee_name`, errors);
    requireStringOrNull(c.assignee_id, `${where}.assignee_id`, errors);

    // 期限は日付形式まで見る。ここが崩れていると依頼側の期限計算が黙って狂う
    // （キー自体の欠損は checkExactKeys が報告済みなので、ここでは値だけ見る）
    if ('due' in c && c.due !== null && !(typeof c.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.due))) {
      errors.push(`${where}.due must be "YYYY-MM-DD" or null`);
    }

    if (!isPlainObject(c.evidence)) {
      errors.push(`${where}.evidence must be an object`);
    } else {
      checkExactKeys(c.evidence, EVIDENCE_KEYS, `${where}.evidence`, errors);
      requireString(c.evidence.text, `${where}.evidence.text`, errors);
      requireString(c.evidence.author, `${where}.evidence.author`, errors);
      requireStringOrNull(c.evidence.posted_at, `${where}.evidence.posted_at`, errors);
      requireStringOrNull(c.evidence.message_url, `${where}.evidence.message_url`, errors);
    }
  });

  return { ok: errors.length === 0, errors };
}

// ---- helpers ----

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v, where, errors) {
  if (typeof v !== 'string' || v.length === 0) errors.push(`${where} must be a non-empty string`);
}

function requireStringOrNull(v, where, errors) {
  if (v === null) return;
  if (typeof v !== 'string') errors.push(`${where} must be a string or null`);
}

function checkExactKeys(obj, allowed, where, errors) {
  for (const k of allowed) {
    if (!(k in obj)) errors.push(`${where}.${k} is missing`);
  }
  // ⚠ 未知キーも不一致として弾く（全か無か）
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}.${k} is not allowed`);
  }
}
