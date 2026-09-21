import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sanitizeFilename } from '../utils/sanitize.js';
import { formatMarkdown, formatImageOnlyNote, formatDailyEntry } from '../utils/markdown.js';
import { uploadNote, uploadImage, appendToDaily, reserveDailySlot } from '../storage/index.js';
import { generateImageFilename, convertToWebp } from '../utils/image.js';
import { extractUrls, fetchAuthorName } from '../scraper/urlFetcher.js';
import { handleCanvasMessage } from './canvasHandler.js';

const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];

async function downloadAttachment(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Discordに直接添付された画像の保存。
 * ここは従来どおり。やめたのは「URL先から画像・動画を取ってくる」処理だけ。
 */
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

/**
 * Resolve author display names for every URL in the message.
 * 取れなかったURLはMapに入れない ＝ [[投稿者名]] の行が省かれるだけで処理は続く。
 */
async function resolveAuthorNames(text) {
  const authorNames = new Map();

  for (const url of new Set(extractUrls(text))) {
    const name = await fetchAuthorName(url);
    if (name) authorNames.set(url, name);
  }

  return authorNames;
}

/**
 * 失敗を本人に見せるための ❌。react 自体が失敗しても握りつぶす
 * （権限不足やメッセージ削除済みで例外になり得るが、そこで落としても意味がない）。
 */
async function react(message, emoji) {
  try {
    await message.react(emoji);
  } catch (error) {
    logger.warn(`Failed to react with ${emoji}: ${error.message}`);
  }
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
    const authorNames = hasText ? await resolveAuthorNames(message.content) : new Map();

    const imageNames = hasImages
      ? await processDiscordImages([...message.attachments.values()])
      : [];

    // 画像だけの投稿でもノートを作る。
    // 以前はここで何も作らず、保存された画像がどこからもリンクされていなかった
    const { title, content, bodyOnly } = hasText
      ? formatMarkdown(message, imageNames, authorNames)
      : formatImageOnlyNote(imageNames);

    const filename = sanitizeFilename(title);
    await uploadNote(filename, content, bodyOnly);
    logger.info(`Successfully saved as ${filename}.md`);

    await react(message, '✅');
  } catch (error) {
    logger.error(`Failed to process note from ${message.author.tag}`, error);
    await react(message, '❌');
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

  // ⚠ ここは await より前、必ず同期的に呼ぶこと。
  //   デイリーは時系列の記録なので、書き込み順は「投稿順」でなければならない。
  //   投稿者名の取得や画像処理を挟んでから並ぼうとすると、処理の速い投稿に
  //   追い越されて並びが前後する。受け取った瞬間に順番だけ取っておく。
  const { myTurn, release } = reserveDailySlot();

  logger.info(`[Daily] Processing message from ${message.author.tag}: "${(message.content || '').substring(0, 50)}..."`);

  try {
    const authorNames = hasText ? await resolveAuthorNames(message.content) : new Map();

    const imageNames = hasImages
      ? await processDiscordImages([...message.attachments.values()])
      : [];

    const entry = formatDailyEntry(message, imageNames, authorNames);

    // 自分より前の投稿が書き終わるのを待ってから書く
    await myTurn;
    await appendToDaily(entry);

    logger.info(`[Daily] Appended to daily note`);
    await react(message, '✅');
  } catch (error) {
    logger.error(`Failed to process daily from ${message.author.tag}`, error);
    await react(message, '❌');
  } finally {
    // 失敗しても必ず次へ譲る（ここを漏らすと以降のデイリーが永久に止まる）
    release();
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
