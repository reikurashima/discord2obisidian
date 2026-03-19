// ========== Note channel (1 message = 1 file) ==========

export function formatMarkdown(message, imageNames = []) {
  const lines = message.content.split('\n');
  const firstLine = lines[0].trim();
  const bodyLines = lines.slice(1);

  const frontmatter = makeFrontmatter();

  let body;
  if (bodyLines.length === 0) {
    body = firstLine;
  } else {
    body = bodyLines.join('\n').trim();
  }

  if (imageNames.length > 0) {
    const imageLinks = imageNames
      .map((name) => `![[${name}|350]]`)
      .join('\n');
    body = body ? body + '\n\n' + imageLinks : imageLinks;
  }

  return {
    title: firstLine,
    content: frontmatter + body + '\n',
    bodyOnly: body + '\n',
  };
}

/**
 * Format a tweet/URL as a full note page (Note channel).
 * Title = author name (no date).
 */
export function formatTweetNote(tweetText, sourceUrl, imageNames = [], videoNames = [], author = null) {
  const frontmatter = makeFrontmatter();
  const parts = [];

  // Tweet text (bold)
  if (tweetText) {
    parts.push(`**${tweetText}**`);
  }

  // Images (inline, no bullets)
  if (imageNames.length > 0) {
    parts.push(imageNames.map((name) => `![[${name}|350]]`).join('\n'));
  }

  // Videos
  if (videoNames.length > 0) {
    parts.push(videoNames.map((name) => `![[${name}]]`).join('\n'));
  }

  // Author + link line
  const authorLine = author
    ? `[[${author.name}]] @${author.screenName}`
    : '';
  const linkLine = `[🔗link](${sourceUrl}) #Xclip`;

  if (authorLine) {
    parts.push(authorLine);
  }
  parts.push(linkLine);

  const body = parts.join('\n');

  // Title = author name only (no date)
  const title = author ? author.name : 'clip';

  return {
    title,
    content: frontmatter + body + '\n',
    bodyOnly: body + '\n',
  };
}

// ========== Daily channel (append to YYYY-MM-DD.md) ==========

export function formatDailyEntry(message, imageNames = []) {
  let entry = `- ${message.content.trim()}`;

  if (imageNames.length > 0) {
    const imageLinks = imageNames
      .map((name) => `\n\t- ![[${name}|350]]`)
      .join('');
    entry += imageLinks;
  }

  return entry;
}

/**
 * Format a tweet entry for Daily / AI Clip channels.
 *
 * Output format:
 * ***
 * **本文**
 * ![[image.webp|350]]
 * ![[video.mp4]]
 * [[投稿者名]] @screen_name
 * [🔗link](URL) #Xclip
 * ***
 */
export function formatTweetEntry(tweetText, sourceUrl, imageNames = [], videoNames = [], author = null) {
  const lines = ['***'];

  // Tweet text (bold)
  if (tweetText) {
    lines.push(`**${tweetText}**`);
  }

  // Images (inline, no bullets)
  for (const name of imageNames) {
    lines.push(`![[${name}|350]]`);
  }

  // Videos
  for (const name of videoNames) {
    lines.push(`![[${name}]]`);
  }

  // Author line
  if (author) {
    lines.push(`[[${author.name}]] @${author.screenName}`);
  }

  // Link + tag
  lines.push(`[🔗link](${sourceUrl}) #Xclip`);
  lines.push('***');

  return lines.join('\n');
}

/**
 * Format an AI Clip entry (text cleanup mode, no URL).
 */
export function formatAiClipEntry(text, imageNames = []) {
  let entry = `- ${text}`;

  if (imageNames.length > 0) {
    const imageLinks = imageNames
      .map((name) => `\n\t- ![[${name}|350]]`)
      .join('');
    entry += imageLinks;
  }

  return entry;
}

// ========== Daily file builder ==========

export function buildDailyFile(existingContent, newEntry) {
  if (existingContent) {
    return existingContent.trimEnd() + '\n' + newEntry + '\n';
  }

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
