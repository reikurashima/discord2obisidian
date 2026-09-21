import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import { sanitizeFilename } from '../utils/sanitize.js';
import { generateImageFilename, convertToWebp } from '../utils/image.js';
import { containsUrl, extractUrl, fetchUrlContent } from '../scraper/urlFetcher.js';
import {
  uploadImage, downloadFile, overwriteFile,
  getCanvasFilePath, getVaultRelativeImagesPath,
} from '../storage/index.js';
import { buildCanvasNodes, computeStartPosition } from '../utils/canvas.js';

const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff'];

function todayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function downloadBuffer(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Convert a raw image buffer to WebP, store it, and read its dimensions.
 * Returns { filename, width, height } (width/height may be undefined on failure).
 */
async function processImageToNode(rawBuffer) {
  const webpBuffer = await convertToWebp(rawBuffer);
  const filename = generateImageFilename();
  await uploadImage(filename, webpBuffer);

  let width;
  let height;
  try {
    const meta = await sharp(webpBuffer).metadata();
    width = meta.width;
    height = meta.height;
  } catch (error) {
    logger.warn(`[Canvas] Failed to read image dimensions for ${filename}: ${error.message}`);
  }

  return { filename, width, height };
}

// Vault-relative "file" path for a stored image, e.g. "images/xxx.webp".
function buildImageFilePath(filename) {
  return `${getVaultRelativeImagesPath()}/${filename}`;
}

// Remove the in-progress hourglass reaction added by the bot; ignore failures.
async function removeHourglass(message) {
  try {
    const reaction = message.reactions.cache.get('⏳');
    if (reaction) await reaction.users.remove(message.client.user.id);
  } catch {
    // Ignore: the reaction may already be gone.
  }
}

// ========== Canvas mode (paste into an Obsidian .canvas file) ==========
export async function handleCanvasMessage(message) {
  const hasText = message.content && message.content.trim();
  const hasImages = message.attachments.some(
    (att) => att.contentType && IMAGE_CONTENT_TYPES.includes(att.contentType)
  );

  if (!hasText && !hasImages) {
    logger.warn(`Empty canvas message from ${message.author.tag}, skipping.`);
    return;
  }

  logger.info(`[Canvas] Processing message from ${message.author.tag}: "${(message.content || '').substring(0, 50)}..."`);

  await message.react('⏳');

  try {
    // Determine the text without any URL, then the canvas name from its 1st line.
    let urlData = null;
    let textWithoutUrl = '';
    if (hasText && containsUrl(message.content)) {
      urlData = extractUrl(message.content);
      textWithoutUrl = (urlData && urlData.comment) || '';
    } else if (hasText) {
      textWithoutUrl = message.content.trim();
    }

    const firstLine = textWithoutUrl.split('\n')[0].trim();
    const canvasName = firstLine ? sanitizeFilename(firstLine) : todayDateString();

    // ---- Gather items to place on the canvas ----
    const items = [];

    // Discord attachments (single or multiple).
    const imageAttachments = [...message.attachments.values()].filter(
      (att) => att.contentType && IMAGE_CONTENT_TYPES.includes(att.contentType)
    );
    for (const att of imageAttachments) {
      try {
        logger.info(`[Canvas] Downloading attachment: ${att.name}`);
        const rawBuffer = await downloadBuffer(att.url);
        const node = await processImageToNode(rawBuffer);
        items.push({ kind: 'image', file: buildImageFilePath(node.filename), width: node.width, height: node.height });
      } catch (error) {
        logger.error(`[Canvas] Failed to process attachment: ${att.name}`, error);
      }
    }

    // URL content: Twitter images, or a YouTube link node. Articles are ignored.
    if (urlData) {
      logger.info(`[Canvas] URL detected: ${urlData.url}`);
      const content = await fetchUrlContent(urlData.url);

      if (content.type === 'youtube') {
        items.push({ kind: 'link', url: content.sourceUrl });
      } else if (content.type === 'twitter') {
        for (const imgUrl of content.imageUrls) {
          try {
            logger.info(`[Canvas] Downloading tweet image: ${imgUrl.substring(0, 80)}...`);
            const rawBuffer = await downloadBuffer(imgUrl);
            const node = await processImageToNode(rawBuffer);
            items.push({ kind: 'image', file: buildImageFilePath(node.filename), width: node.width, height: node.height });
          } catch (error) {
            logger.error(`[Canvas] Failed to process tweet image: ${imgUrl}`, error);
          }
        }
      } else {
        // Article (or other) URLs are not supported on the canvas channel.
        logger.info(`[Canvas] URL type '${content.type}' ignored on canvas channel: ${urlData.url}`);
      }
    }

    if (items.length === 0) {
      logger.warn(`[Canvas] Nothing to place on canvas from ${message.author.tag}, skipping.`);
      await removeHourglass(message);
      return;
    }

    // ---- Load / parse the target canvas file ----
    const canvasPath = getCanvasFilePath(canvasName);
    const existing = await downloadFile(canvasPath);
    const canvasData = { nodes: [], edges: [] };

    if (existing) {
      try {
        const parsed = JSON.parse(existing);
        if (!parsed || !Array.isArray(parsed.nodes)) throw new Error('missing nodes array');
        canvasData.nodes = parsed.nodes;
        canvasData.edges = Array.isArray(parsed.edges) ? parsed.edges : [];
      } catch (error) {
        // Safe side: never overwrite a canvas we cannot parse (avoids data loss).
        logger.warn(`[Canvas] Failed to parse existing canvas ${canvasPath}, aborting to avoid data loss: ${error.message}`);
        await removeHourglass(message);
        await message.react('❌');
        return;
      }
    }

    // ---- Lay out and append the new nodes ----
    // Continue from the end of the last existing row instead of starting a new one.
    const startPosition = computeStartPosition(canvasData.nodes);
    const newNodes = buildCanvasNodes(items, startPosition);
    canvasData.nodes.push(...newNodes);

    await overwriteFile(canvasPath, JSON.stringify(canvasData, null, 2));
    logger.info(`[Canvas] Appended ${newNodes.length} node(s) to ${canvasName}.canvas`);

    await removeHourglass(message);
    await message.react('✅');
  } catch (error) {
    logger.error(`Failed to process canvas from ${message.author.tag}`, error);
    await removeHourglass(message);
    await message.react('❌');
  }
}
