import { convertToWebp, generateImageFilename, generateVideoFilename } from '../utils/image.js';
import { uploadImage } from '../storage/index.js';
import { logger } from '../utils/logger.js';

/**
 * Download external images, convert to WebP, and upload to storage.
 * Returns array of saved image filenames.
 */
export async function downloadAndProcessImages(imageUrls, maxImages = 4) {
  const urls = imageUrls.slice(0, maxImages);
  const imageNames = [];

  for (const url of urls) {
    try {
      logger.info(`[ImageDL] Downloading: ${url.substring(0, 80)}...`);

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        logger.warn(`[ImageDL] HTTP ${response.status} for ${url}`);
        continue;
      }

      const rawBuffer = Buffer.from(await response.arrayBuffer());

      // Skip very small images (likely icons/pixels)
      if (rawBuffer.length < 1024) {
        logger.info(`[ImageDL] Skipping tiny image (${rawBuffer.length} bytes)`);
        continue;
      }

      const webpBuffer = await convertToWebp(rawBuffer);
      const filename = generateImageFilename();
      await uploadImage(filename, webpBuffer);
      imageNames.push(filename);

      logger.info(`[ImageDL] Saved as: ${filename}`);
    } catch (error) {
      logger.error(`[ImageDL] Failed to process: ${url}`, error);
    }
  }

  return imageNames;
}

/**
 * Download videos and upload to storage.
 * Returns array of saved video filenames.
 */
export async function downloadAndProcessVideos(videoUrls, maxVideos = 2) {
  const urls = videoUrls.slice(0, maxVideos);
  const videoNames = [];

  for (const url of urls) {
    try {
      logger.info(`[VideoDL] Downloading: ${url.substring(0, 80)}...`);

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
        signal: AbortSignal.timeout(60000), // Videos can be large, 60s timeout
      });

      if (!response.ok) {
        logger.warn(`[VideoDL] HTTP ${response.status} for ${url}`);
        continue;
      }

      const videoBuffer = Buffer.from(await response.arrayBuffer());

      // Skip if too small (likely error page) or too large (>50MB)
      if (videoBuffer.length < 1024) {
        logger.info(`[VideoDL] Skipping tiny file (${videoBuffer.length} bytes)`);
        continue;
      }
      if (videoBuffer.length > 50 * 1024 * 1024) {
        logger.warn(`[VideoDL] Skipping oversized video (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
        continue;
      }

      const filename = generateVideoFilename();
      await uploadImage(filename, videoBuffer); // reuse uploadImage for any file
      videoNames.push(filename);

      logger.info(`[VideoDL] Saved as: ${filename} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
    } catch (error) {
      logger.error(`[VideoDL] Failed to process: ${url}`, error);
    }
  }

  return videoNames;
}
