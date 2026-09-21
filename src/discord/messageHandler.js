import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sanitizeFilename } from '../utils/sanitize.js';
import {
  formatMarkdown, formatTweetNote, formatYoutubeNote, formatArticleNote,
  formatDailyEntry, formatTweetEntry, formatYoutubeEntry, formatArticleEntry,
  buildDailyFile,
} from '../utils/markdown.js';
import { uploadNote, uploadImage, downloadFile, overwriteFile, getDailyFilePath } from '../storage/index.js';
import { generateImageFilename, convertToWebp } from '../utils/image.js';
import { containsUrl, extractUrl, fetchUrlContent } from '../scraper/urlFetcher.js';
import { downloadAndProcessImages, downloadAndProcessVideos } from '../scraper/imageDownloader.js';
import { handleCanvasMessage } from './canvasHandler.js';

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
      logger.info(`Downloading image: ${att.name}`);
      const rawBuffer = await downloadAttachment(att.url);
      const webpBuffer = await convertToWebp(rawBuffer);
      const imageFilename = generateImageFilename();
      await uploadImage(imageFilename, webpBuffer);
      imageNames.push(imageFilename);
      logger.info(`Image saved as: ${imageFilename}`);
    } catch (error) {
      logger.error(`Failed to process image: ${att.name}`, error);
    }
  }

  return imageNames;
}

// ========== Normal note mode (1 message = 1 file) ==========
async function handleNoteMessage(message) {
  const hasText = message.content && message.content.trim();
  const hasImages = message.attachments.some(
    (att) => att.contentType && IMAGE_CONTENT_TYPES.includes(att.contentType)
  );

  if (!hasText && !hasImages) {
    logger.warn(`Empty message from ${message.author.tag}, skipping.`);
    return;
  }

  logger.info(`[Note] Processing message from ${message.author.tag}: "${(message.content || '').substring(0, 50)}..."`);

  try {
    // Check if message contains a URL
    if (hasText && containsUrl(message.content)) {
      const urlData = extractUrl(message.content);
      if (urlData) {
        logger.info(`[Note] URL detected: ${urlData.url}`);
        const content = await fetchUrlContent(urlData.url);

        if (content.type === 'youtube') {
          // === YouTube: embed URL + #youtube tag ===
          const { title, content: fileContent, bodyOnly } = formatYoutubeNote(content.sourceUrl, urlData.comment);
          const filename = sanitizeFilename(title);
          await uploadNote(filename, fileContent, bodyOnly);
          logger.info(`[Note] YouTube saved as ${filename}.md`);
          await message.react('✅');
          return;
        }

        if (content.type === 'article') {
          // === Article: embed URL + 1 image ===
          const articleImageNames = content.imageUrls.length > 0
            ? await downloadAndProcessImages(content.imageUrls, 1)
            : [];
          const discordImageNames = hasImages
            ? await processDiscordImages([...message.attachments.values()])
            : [];
          const allImageNames = [...articleImageNames, ...discordImageNames];

          const { title, content: fileContent, bodyOnly } = formatArticleNote(content.sourceUrl, allImageNames, urlData.comment);
          const filename = sanitizeFilename(title);
          await uploadNote(filename, fileContent, bodyOnly);
          logger.info(`[Note] Article saved as ${filename}.md`);
          await message.react('✅');
          return;
        }

        // === Twitter: keep existing behavior ===
        const urlImageNames = content.imageUrls.length > 0
          ? await downloadAndProcessImages(content.imageUrls)
          : [];
        const videoNames = content.videoUrls.length > 0
          ? await downloadAndProcessVideos(content.videoUrls)
          : [];
        const discordImageNames = hasImages
          ? await processDiscordImages([...message.attachments.values()])
          : [];
        const allImageNames = [...urlImageNames, ...discordImageNames];

        const { title, content: fileContent, bodyOnly } = formatTweetNote(
          content.text, content.sourceUrl, allImageNames, videoNames, content.author, urlData.comment,
        );

        const filename = sanitizeFilename(title);
        await uploadNote(filename, fileContent, bodyOnly);
        logger.info(`[Note] Tweet saved as ${filename}.md`);
        await message.react('✅');
        return;
      }
    }

    // Normal text note (no URL)
    const imageNames = hasImages
      ? await processDiscordImages([...message.attachments.values()])
      : [];

    if (hasText) {
      const { title, content, bodyOnly } = formatMarkdown(message, imageNames);
      const filename = sanitizeFilename(title);
      await uploadNote(filename, content, bodyOnly);
      logger.info(`Successfully saved as ${filename}.md`);
    }

    await message.react('✅');
  } catch (error) {
    logger.error(`Failed to process note from ${message.author.tag}`, error);
  }
}

// ========== Daily note mode (append to YYYY-MM-DD.md) ==========
async function handleDailyMessage(message) {
  const hasText = message.content && message.content.trim();
  const hasImages = message.attachments.some(
    (att) => att.contentType && IMAGE_CONTENT_TYPES.includes(att.contentType)
  );

  if (!hasText && !hasImages) {
    logger.warn(`Empty daily message from ${message.author.tag}, skipping.`);
    return;
  }

  logger.info(`[Daily] Processing message from ${message.author.tag}: "${(message.content || '').substring(0, 50)}..."`);

  try {
    // Check if message contains a URL
    if (hasText && containsUrl(message.content)) {
      const urlData = extractUrl(message.content);
      if (urlData) {
        logger.info(`[Daily] URL detected: ${urlData.url}`);
        const content = await fetchUrlContent(urlData.url);

        if (content.type === 'youtube') {
          // === YouTube: embed URL + #youtube tag ===
          const entry = formatYoutubeEntry(content.sourceUrl, urlData.comment);
          const dailyFilePath = getDailyFilePath();
          const existing = await downloadFile(dailyFilePath);
          const fullContent = buildDailyFile(existing, entry);
          await overwriteFile(dailyFilePath, fullContent);
          logger.info(`[Daily] YouTube appended to daily note`);
          await message.react('✅');
          return;
        }

        if (content.type === 'article') {
          // === Article: embed URL + 1 image ===
          const articleImageNames = content.imageUrls.length > 0
            ? await downloadAndProcessImages(content.imageUrls, 1)
            : [];
          const discordImageNames = hasImages
            ? await processDiscordImages([...message.attachments.values()])
            : [];
          const allImageNames = [...articleImageNames, ...discordImageNames];

          const entry = formatArticleEntry(content.sourceUrl, allImageNames, urlData.comment);
          const dailyFilePath = getDailyFilePath();
          const existing = await downloadFile(dailyFilePath);
          const fullContent = buildDailyFile(existing, entry);
          await overwriteFile(dailyFilePath, fullContent);
          logger.info(`[Daily] Article appended to daily note`);
          await message.react('✅');
          return;
        }

        // === Twitter: keep existing behavior ===
        const urlImageNames = content.imageUrls.length > 0
          ? await downloadAndProcessImages(content.imageUrls)
          : [];
        const videoNames = content.videoUrls.length > 0
          ? await downloadAndProcessVideos(content.videoUrls)
          : [];
        const discordImageNames = hasImages
          ? await processDiscordImages([...message.attachments.values()])
          : [];
        const allImageNames = [...urlImageNames, ...discordImageNames];

        const entry = formatTweetEntry(
          content.text, content.sourceUrl, allImageNames, videoNames, content.author, urlData.comment,
        );

        const dailyFilePath = getDailyFilePath();
        const existing = await downloadFile(dailyFilePath);
        const fullContent = buildDailyFile(existing, entry);
        await overwriteFile(dailyFilePath, fullContent);

        logger.info(`[Daily] Tweet appended to daily note`);
        await message.react('✅');
        return;
      }
    }

    // Normal text daily entry (no URL)
    const imageNames = hasImages
      ? await processDiscordImages([...message.attachments.values()])
      : [];

    const dailyFilePath = getDailyFilePath();
    const existing = await downloadFile(dailyFilePath);
    const entry = formatDailyEntry(message, imageNames);
    const fullContent = buildDailyFile(existing, entry);
    await overwriteFile(dailyFilePath, fullContent);

    logger.info(`[Daily] Appended to daily note`);
    await message.react('✅');
  } catch (error) {
    logger.error(`Failed to process daily from ${message.author.tag}`, error);
  }
}

// ========== Router ==========
export async function handleMessage(message) {
  if (message.author.bot) return;

  if (message.channelId === config.discord.channelId) {
    return handleNoteMessage(message);
  }

  if (message.channelId === config.discord.dailyChannelId) {
    return handleDailyMessage(message);
  }

  if (config.discord.canvasChannelId && message.channelId === config.discord.canvasChannelId) {
    return handleCanvasMessage(message);
  }
}
