/**
 * `claude -p --output-format json` の出力から、モデルが書いた JSON を取り出す。
 *
 * claude は「実行結果の封筒（envelope）」を JSON で返し、
 * モデルの本文はその中の `result` フィールドに**文字列として**入る。
 * 封筒の形は将来変わり得るので、当てが外れたら stdout 全体を本文とみなす二段構えにしてある。
 */
export function extractOutputJson(stdout) {
  const raw = String(stdout ?? '').trim();
  if (raw.length === 0) return { ok: false, reason: 'empty stdout', value: null, envelope: null };

  let envelope = null;
  let body = raw;

  const parsedEnvelope = tryParse(raw);
  if (parsedEnvelope && typeof parsedEnvelope === 'object' && !Array.isArray(parsedEnvelope)) {
    if (typeof parsedEnvelope.result === 'string') {
      envelope = parsedEnvelope;
      body = parsedEnvelope.result;
    } else if (parsedEnvelope.result && typeof parsedEnvelope.result === 'object') {
      // 封筒の中で既にオブジェクトになっている場合はそのまま使う
      return { ok: true, value: parsedEnvelope.result, envelope: parsedEnvelope, reason: null };
    } else {
      // 封筒ではなく、モデルの JSON がそのまま出ているケース
      return { ok: true, value: parsedEnvelope, envelope: null, reason: null };
    }
  }

  const value = parseModelJson(body);
  if (value === undefined) {
    return { ok: false, reason: 'model output is not valid JSON', value: null, envelope };
  }
  return { ok: true, value, envelope, reason: null };
}

/**
 * モデル本文から JSON を取り出す。
 * 「JSON だけ出せ」と指示していても ```json フェンスや前置きが付くことがあるので、
 * そこまでは吸収する。**内容の補正は一切しない**（直したくなったら SCHEMA エラーにする）。
 */
export function parseModelJson(text) {
  let s = String(text ?? '').trim();

  const fenced = s.match(/```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```/i);
  if (fenced) s = fenced[1].trim();

  const direct = tryParse(s);
  if (direct !== undefined) return direct;

  // 前後に説明文が付いた場合の保険: 最初の { から最後の } まで
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const sliced = tryParse(s.slice(first, last + 1));
    if (sliced !== undefined) return sliced;
  }
  return undefined;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}
