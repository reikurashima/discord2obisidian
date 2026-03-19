export function sanitizeFilename(raw) {
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

  // Fallback if empty
  if (!name) {
    name = `untitled-${Date.now()}`;
  }

  return name;
}
