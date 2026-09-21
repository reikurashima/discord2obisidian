/**
 * Normalize a string into a note name.
 * 絵文字や記号だけの行は**空文字を返す**。呼び出し側で「ノート名にできなかった」と
 * 判定して1行目を本文へ残せるように、ここではフォールバック名を付けない。
 */
export function sanitizeTitle(raw) {
  let name = raw.trim();

  // Remove characters not allowed in file paths and control characters
  name = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '');

  // Remove emoji and other non-letter/number/space/punctuation symbols
  name = name.replace(/[\u{1F600}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');

  // Replace whitespace sequences with a single hyphen
  name = name.replace(/\s+/g, '-');

  // Collapse multiple hyphens
  name = name.replace(/-{2,}/g, '-');

  // Truncate to 100 characters
  name = name.slice(0, 100);

  // Remove leading/trailing hyphens and dots
  name = name.replace(/^[-.\s]+|[-.\s]+$/g, '');

  return name;
}

/**
 * URLをそのままノート名にする。
 *   https://x.com/jack/status/20  →  x.com-jack-status-20
 *
 * sanitizeTitle に直接通すと区切り記号が「消える」だけで
 * httpsx.comjackstatus20 になって読めないため、先にハイフンへ置き換える。
 */
export function urlToNoteName(url) {
  let name = url.trim();

  // スキームは全URLに付くだけで識別の役に立たないので落とす
  name = name.replace(/^https?:\/\//i, '');

  // 区切り記号をハイフンに寄せる
  name = name.replace(/[/:?&=]+/g, '-');

  // 連続ハイフンは1つに畳み、前後のハイフンは落とす（末尾スラッシュ対策）
  name = name.replace(/-{2,}/g, '-');
  name = name.replace(/^-+|-+$/g, '');

  // 残った禁止文字・絵文字の除去と長さ制限は共通処理に任せる
  return sanitizeTitle(name);
}

export function sanitizeFilename(raw) {
  const name = sanitizeTitle(raw);

  // Fallback if empty
  return name || `untitled-${Date.now()}`;
}
