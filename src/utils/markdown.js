// ========== Note channel (1 message = 1 file) ==========

export function formatMarkdown(message, imageNames = []) {
  const lines = message.content.split('\n');
  const firstLine = lines[0].trim();
  const bodyLines = lines.slice(1);

  const frontmatter = makeFrontmatter();

  // First line is always the title; it is never part of the body.
  let body = bodyLines.join('\n').trim();

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
 * Title = first 20 chars of tweet text.
 */
export function formatTweetNote(tweetText, sourceUrl, imageNames = [], videoNames = [], author = null, comment = null) {
  const frontmatter = makeFrontmatter();
  const parts = [];

  // User comment (text sent alongside the URL) goes first
  if (comment) {
    parts.push(comment);
  }

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

  // Title = first 20 chars of tweet text
  const title = tweetText
    ? tweetText.replace(/\n/g, ' ').substring(0, 20).trim()
    : (author ? author.name : 'clip');

  return {
    title,
    content: frontmatter + body + '\n',
    bodyOnly: body + '\n',
  };
}

/**
 * Format a YouTube URL as a note (Note channel).
 * Title = URL.
 */
export function formatYoutubeNote(sourceUrl, comment = null) {
  const frontmatter = makeFrontmatter();
  const parts = [];

  // User comment (text sent alongside the URL) goes first
  if (comment) {
    parts.push(comment);
  }
  parts.push(`![](${sourceUrl})`);
  parts.push('#youtube');
  const body = parts.join('\n');

  return {
    title: sourceUrl,
    content: frontmatter + body + '\n',
    bodyOnly: body + '\n',
  };
}

/**
 * Format an article URL as a note (Note channel).
 * Title = URL.
 */
export function formatArticleNote(sourceUrl, imageNames = [], comment = null) {
  const frontmatter = makeFrontmatter();
  const parts = [];

  // User comment (text sent alongside the URL) goes first
  if (comment) {
    parts.push(comment);
  }
  parts.push(`![](${sourceUrl})`);

  if (imageNames.length > 0) {
    parts.push(`![[${imageNames[0]}|350]]`);
  }

  const body = parts.join('\n');

  return {
    title: sourceUrl,
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
 * Format a tweet entry for Daily channel.
 */
export function formatTweetEntry(tweetText, sourceUrl, imageNames = [], videoNames = [], author = null, comment = null) {
  const lines = ['***'];

  // User comment (text sent alongside the URL) goes first
  if (comment) {
    lines.push(comment);
  }

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
 * Format a YouTube entry for Daily channel.
 */
export function formatYoutubeEntry(sourceUrl, comment = null) {
  const lines = ['***'];
  if (comment) {
    lines.push(comment);
  }
  lines.push(`![](${sourceUrl})`);
  lines.push('#youtube');
  lines.push('***');
  return lines.join('\n');
}

/**
 * Format an article entry for Daily channel.
 */
export function formatArticleEntry(sourceUrl, imageNames = [], comment = null) {
  const lines = ['***'];
  if (comment) {
    lines.push(comment);
  }
  lines.push(`![](${sourceUrl})`);
  if (imageNames.length > 0) {
    lines.push(`![[${imageNames[0]}|350]]`);
  }
  lines.push('***');
  return lines.join('\n');
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
