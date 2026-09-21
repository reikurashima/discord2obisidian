import sharp from 'sharp';
import { logger } from './logger.js';

function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getDateString() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export function generateImageFilename() {
  return `dropbox_${getDateString()}_${randomString(5)}.webp`;
}

export async function convertToWebp(inputBuffer) {
  try {
    const webpBuffer = await sharp(inputBuffer)
      .webp({ quality: 80 })
      .toBuffer();
    return webpBuffer;
  } catch (error) {
    logger.error('Failed to convert image to WebP', error);
    throw error;
  }
}
