// echo.v1 — 疎通確認用の最小スキーマ。
// 「キューが回っているか」「claude の認証が生きているか」を確かめるためだけに使う。

export const name = 'echo.v1';

export function describe() {
  return [
    '```jsonc',
    '{',
    '  "echo": "string"   // 入力の input.text をそのまま返す',
    '}',
    '```',
  ].join('\n');
}

export function validate(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['root must be a JSON object'] };
  }
  checkExactKeys(value, ['echo'], 'root', errors);
  if (typeof value.echo !== 'string') errors.push('root.echo must be a string');

  return { ok: errors.length === 0, errors };
}

// ---- helpers（schemas 内で共有したいほどの量ではないので各ファイルに置く） ----

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkExactKeys(obj, allowed, where, errors) {
  for (const k of allowed) {
    if (!(k in obj)) errors.push(`${where}.${k} is missing`);
  }
  // ⚠ 未知キーも不一致として弾く。
  //    「余計なキーが付いているが中身は合っている」を通すと、
  //    依頼側が想定していない値を混ぜ込まれる余地になるため（全か無か）。
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}.${k} is not allowed`);
  }
}
