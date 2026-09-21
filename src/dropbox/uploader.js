import { dbx } from './client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export async function uploadToDropbox(filename, content, bodyOnly) {
  const basePath = config.dropbox.folderPath.replace(/\/+$/, '');
  const filePath = `${basePath}/${filename}.md`;

  // Check if file already exists
  const existing = await downloadFromDropbox(filePath);

  if (existing) {
    // Nothing to append (e.g. a single-line message whose only content is the
    // title): leave the existing note untouched.
    if (!bodyOnly || !bodyOnly.trim()) {
      logger.info(`Nothing to append, existing note left unchanged: ${filePath}`);
      return { '.tag': 'file', path_display: filePath };
    }
    // Append to existing note
    const appended = existing.trimEnd() + '\n\n' + bodyOnly.trimStart();
    const response = await dbx.filesUpload({
      path: filePath,
      contents: Buffer.from(appended, 'utf-8'),
      mode: { '.tag': 'overwrite' },
    });
    logger.info(`Appended to existing: ${response.result.path_display}`);
    return response.result;
  }

  // New file
  const response = await dbx.filesUpload({
    path: filePath,
    contents: Buffer.from(content, 'utf-8'),
    mode: { '.tag': 'add' },
    autorename: false,
  });
  logger.info(`Uploaded: ${response.result.path_display}`);
  return response.result;
}

export async function uploadImageToDropbox(imageFilename, imageBuffer) {
  const basePath = config.dropbox.folderPath.replace(/\/+$/, '');
  const filePath = `${basePath}/images/${imageFilename}`;

  const response = await dbx.filesUpload({
    path: filePath,
    contents: imageBuffer,
    mode: { '.tag': 'add' },
    autorename: true,
  });
  logger.info(`Image uploaded: ${response.result.path_display}`);
  return response.result;
}

export async function downloadFromDropbox(filePath) {
  try {
    const response = await dbx.filesDownload({ path: filePath });
    // response.result.fileBinary contains the file content
    return response.result.fileBinary.toString('utf-8');
  } catch (error) {
    if (error?.error?.error_summary?.startsWith('path/not_found')) {
      return null; // File doesn't exist yet
    }
    throw error;
  }
}

export async function overwriteDropboxFile(filePath, content) {
  const response = await dbx.filesUpload({
    path: filePath,
    contents: Buffer.from(content, 'utf-8'),
    mode: { '.tag': 'overwrite' },
  });
  logger.info(`Updated: ${response.result.path_display}`);
  return response.result;
}
