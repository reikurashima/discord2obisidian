import { extractUrls } from '../scraper/urlFetcher.js';
import { sanitizeTitle, urlToNoteName } from './sanitize.js';

// ========== URL の展開（ノート・デイリー共通） ==========

/**
 * 本文中のURLを必ず次の形に展開する。分岐を増やさないため例外は作らない。
 *
 *   [[投稿者名]]      ← X / YouTube で取れたときだけ
 *   ![](URL)          ← 埋め込みプレビュー用
 *   URL               ← 埋め込みが効かないサイト用に生URLも残す
 *
 * URLに添えたコメントは捨てずに、展開の直前に1行として残す。
 * （以前は extractUrl が comment を返すだけでノート側に渡らず、黙って消えていた）
 *
 * @param {string} text
 * @param {Map<string, string>} authorNames URL -> 投稿者名
 */
export function expandUrls(text, authorNames = new Map()) {
  return text
    .split('\n')
    .map((line) => expandUrlsInLine(line, authorNames))
    .join('\n');
}

function expandUrlsInLine(line, authorNames) {
  const urls = extractUrls(line);
  if (urls.length === 0) return line;

  const out = [];

  // URLを取り除いた残り = 本人が書いたコメント
  let comment = line;
  for (const url of urls) {
    comment = comment.replace(url, ' ');
  }
  comment = comment.replace(/\s{2,}/g, ' ').trim();
  if (comment) out.push(comment);

  // 複数URLは全部処理する（以前は最初の1本しか見ていなかった）
  for (const url of urls) {
    const author = authorNames.get(url);
    if (author) out.push(`[[${author}]]`);
    out.push(`![](${url})`);
    out.push(url);
  }

  return out.join('\n');
}

// ========== Note channel (1 message = 1 file) ==========

/**
 * ルール（例外なし）:
 *   1行目            → ノート名
 *   2行目以降        → 本文
 *   1行目がURLの場合 → ノート名はそのURLをハイフン化したもの。本文にも同じURLを展開する
 */
export function formatMarkdown(message, imageNames = [], authorNames = new Map()) {
  const lines = message.content.split('\n');
  const firstLine = lines[0].trim();
  const firstLineUrls = extractUrls(firstLine);

  const title = firstLineUrls.length > 0
    ? urlToNoteName(firstLineUrls[0])
    : sanitizeTitle(firstLine);

  // 1行目を本文から落とすのが原則。例外は2つだけ:
  //   - URLを含む行（ノート名にはなったが、本文にもURLを展開して残す仕様）
  //   - サニタイズで空になる行（絵文字・記号のみ。落とすと書いた内容が消える）
  const keepFirstLine = firstLineUrls.length > 0 || title === '';
  const bodySource = keepFirstLine ? lines : lines.slice(1);

  const frontmatter = makeFrontmatter();
  let body = expandUrls(bodySource.join('\n'), authorNames).trim();

  if (imageNames.length > 0) {
    const imageLinks = imageNames
      .map((name) => `![[${name}|350]]`)
      .join('\n');
    body = body ? body + '\n\n' + imageLinks : imageLinks;
  }

  return {
    title,
    content: frontmatter + body + '\n',
    bodyOnly: body + '\n',
  };
}

/**
 * テキストなし・画像だけの投稿用（Note channel）。
 * 以前はノートが1行も作られず、保存された画像がどこからもリンクされていなかった。
 * ノート名の材料が無いので日時から作る。
 */
export function formatImageOnlyNote(imageNames = []) {
  const frontmatter = makeFrontmatter();
  const body = imageNames.map((name) => `![[${name}|350]]`).join('\n');

  return {
    title: dateTimeString(),
    content: frontmatter + body + '\n',
    bodyOnly: body + '\n',
  };
}

// ========== Daily channel (append to YYYY-MM-DD.md) ==========

/**
 * デイリーは1投稿＝1箇条書き。URL展開で複数行になるので、
 * 2行目以降はタブで字下げして同じ箇条書きの中に収める。
 */
export function formatDailyEntry(message, imageNames = [], authorNames = new Map()) {
  const rawText = (message.content || '').trim();
  const body = rawText ? expandUrls(rawText, authorNames).trim() : '';
  const bodyLines = body ? body.split('\n') : [];
  const imageLinks = imageNames.map((name) => `![[${name}|350]]`);

  // 画像だけの投稿は、先頭の画像を箇条書きの1行目にする（空の「- 」を作らないため）
  if (bodyLines.length === 0) {
    if (imageLinks.length === 0) return '- ';
    return [`- ${imageLinks[0]}`, ...imageLinks.slice(1).map((link) => `\t- ${link}`)].join('\n');
  }

  let entry = `- ${bodyLines[0]}`;
  for (const line of bodyLines.slice(1)) {
    entry += `\n\t${line}`;
  }
  for (const link of imageLinks) {
    entry += `\n\t- ${link}`;
  }

  return entry;
}

// ========== Daily file builder ==========

/**
 * @param {string|null} existingContent
 * @param {string} newEntry
 * @param {{ separator?: boolean }} options separator=true で `***` の区切り行を1本挟む
 */
export function buildDailyFile(existingContent, newEntry, options = {}) {
  const { separator = false } = options;

  if (existingContent) {
    // 区切りの前後は空行を空ける。箇条書きの直後に `***` を置くとリストが途切れて
    // 見た目が崩れるため（既存の日付ノートでも段落として区切られている）
    const head = separator ? '\n\n***\n\n' : '\n';
    return existingContent.trimEnd() + head + newEntry + '\n';
  }

  // その日の1本目。直前の投稿が存在しないので区切りは入れない
  const frontmatter = makeFrontmatter();
  return frontmatter + '#雑記\n\n' + newEntry + '\n';
}

// ========== Helpers ==========

function makeFrontmatter() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return [
    '---',
    `created: ${dateStr}`,
    'source: discord',
    '---',
    '',
  ].join('\n');
}

function dateTimeString() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
