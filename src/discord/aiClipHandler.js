import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { cleanupText } from '../ai/gemini.js';
import { containsUrl, extractUrl, fetchUrlContent } from '../scraper/urlFetcher.js';
import { downloadAndProcessImages, downloadAndProcessVideos } from '../scraper/imageDownloader.js';
import { convertToWebp, generateImageFilename } from '../utils/image.js';
import { uploadImage, downloadFile, overwriteFile, getDailyFilePath } from '../storage/index.js';
import { formatAiClipEntry, formatTweetEntry, buildDailyFile } from '../utils/markdown.js';

const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];

async function downloadAttachment(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function processDiscordImages(attachments) {
  const imageAttachments = attachments.filter(
    (att) => att.contentType && IMAGE_CONTENT_TYPES.includes(att.contentType)
  );

  const imageNames = [];
  for (const att of imageAttachments) {
    try {
      const rawBuffer = await downloadAttachment(att.url);
      const webpBuffer = await convertToWebp(rawBuffer);
      const imageFilename = generateImageFilename();
      await uploadImage(imageFilename, webpBuffer);
      imageNames.push(imageFilename);
    } catch (error) {
      logger.error(`[AIClip] Failed to process Discord image: ${att.name}`, error);
    }
  }
  return imageNames;
}

/**
 * Handle messages from the AI Clip channel.
 * - URL: fetch content (tweet/article) with images, videos, author info
 * - Text: clean up with Gemini AI, then save to daily
 */
export async function handleAiClipMessage(message) {
  const hasText = message.content && message.content.trim();
  const hasImages = message.attachments.some(
    (att) => att.contentType && IMAGE_CONTENT_TYPES.includes(att.contentType)
  );

  if (!hasText && !hasImages) {
    logger.warn(`[AIClip] Empty message from ${message.author.tag}, skipping.`);
    return;
  }

  logger.info(`[AIClip] Processing message from ${message.author.tag}: "${(message.content || '').substring(0, 50)}..."`);

  try {
    await message.react('⏳');
  } catch (e) { /* ignore */ }

  try {
    let entry = '';
    let replyText = '';

    const discordImageNames = hasImages
      ? await processDiscordImages([...message.attachments.values()])
      : [];

    if (hasText && containsUrl(message.content)) {
      // ===== URL Mode =====
      const urlData = extractUrl(message.content);
      if (urlData) {
        logger.info(`[AIClip] URL detected: ${urlData.url}`);
        const content = await fetchUrlContent(urlData.url);

        const urlImageNames = content.imageUrls.length > 0
          ? await downloadAndProcessImages(content.imageUrls)
          : [];
        const videoNames = content.videoUrls.length > 0
          ? await downloadAndProcessVideos(content.videoUrls)
          : [];
        const allImageNames = [...urlImageNames, ...discordImageNames];

        entry = formatTweetEntry(
          content.text, content.sourceUrl, allImageNames, videoNames, content.author,
        );

        const authorInfo = content.author ? `@${content.author.screenName}` : '';
        replyText = `📎 **クリップ完了** ${authorInfo}\n${(content.text || '').substring(0, 200)}`;
      }
    } else if (hasText) {
      // ===== Text Cleanup Mode (Gemini AI) =====
      logger.info(`[AIClip] Text cleanup mode`);
      const cleanedText = await cleanupText(message.content.trim());
      entry = formatAiClipEntry(cleanedText, discordImageNames);
      replyText = `✏️ **整形完了**\n${cleanedText}`;
    } else {
      // Images only
      entry = formatAiClipEntry('', discordImageNames);
      replyText = `🖼️ **画像保存完了**`;
    }

    // Save to daily file
    if (entry) {
      const dailyFilePath = getDailyFilePath();
      const existing = await downloadFile(dailyFilePath);
      const fullContent = buildDailyFile(existing, entry);
      await overwriteFile(dailyFilePath, fullContent);
      logger.info(`[AIClip] Appended to daily note`);
    }

    // Remove hourglass, add checkmark
    try {
      const hourglassReaction = message.reactions.cache.get('⏳');
      if (hourglassReaction) await hourglassReaction.remove();
    } catch (e) { /* ignore */ }

    await message.react('✅');

    if (replyText) {
      await message.reply({
        content: replyText.substring(0, 2000),
        allowedMentions: { repliedUser: false },
      });
    }

    logger.info(`[AIClip] Successfully processed`);
  } catch (error) {
    logger.error(`[AIClip] Failed to process message from ${message.author.tag}`, error);

    try {
      const hourglassReaction = message.reactions.cache.get('⏳');
      if (hourglassReaction) await hourglassReaction.remove();
    } catch (e) { /* ignore */ }

    try { await message.react('❌'); } catch (e) { /* ignore */ }
  }
}
