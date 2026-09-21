import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { scanFilePath, scansDir } from '../storage/paths.js';
import { atomicWriteFile, serializeWrite } from '../storage/writeQueue.js';
import { logger } from '../utils/logger.js';

// <STATE_DIR>/scans/YYYY-MM-DD.json の読み書き。
//
// ⚠ この形はマイポータルとの合意済みの契約。キー名・構造を変えないこと。
//   {
//     "date": "YYYY-MM-DD",
//     "generated": "ISO(+09:00)",
//     "candidates": [{
//       id, channel_id, channel_name, assignee_name, assignee_id, due, title,
//       evidence: { text, author, posted_at, message_url },
//       decision, notify, decided_at, task_id
//     }]
//   }
//
// ★ ポータルが decision / notify を書き込み、Botが task_id を書き戻す。
//   同じファイルを2つのプロセスが書くので、**読んだときのハッシュと
//   書き戻す直前のハッシュが一致するときだけ書く**（照合に負けたら次のティック）。

/**
 * 読む。ファイルごとのハッシュ（＝読んだ瞬間の中身）も一緒に返す。
 * @returns {Promise<{ data: any, hash: string } | null>}
 */
export async function readScanFile(dateString) {
  let raw;
  try {
    raw = await fs.readFile(scanFilePath(dateString), 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    // ポータルが書き込み途中、あるいは壊れている。次のティックで読み直す
    logger.warn(`[Scan] scans/${dateString}.json を読めませんでした: ${error.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.candidates)) {
    logger.warn(`[Scan] scans/${dateString}.json の形が契約と違います（candidates が配列ではありません）`);
    return null;
  }

  return { data, hash: hashOf(raw) };
}

/** scans/ にある日付を新しい順に返す */
export async function listScanDates() {
  let names = [];
  try {
    names = await fs.readdir(scansDir());
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .map((n) => n.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

/** 新規に書き出す（走査直後）。既存ファイルがあれば上書きする */
export function writeScanFile(dateString, data) {
  return serializeWrite(async () => {
    await fs.mkdir(path.dirname(scanFilePath(dateString)), { recursive: true });
    await atomicWriteFile(scanFilePath(dateString), serialize(data));
  });
}

/**
 * ★ ハッシュ照合つきの書き戻し。
 *
 * 書き込み直前にもう一度ディスクから読み、expectedHash と一致するときだけ書く。
 * 一致しなければ「ポータルが間に入って書き換えた」ということなので、
 * **何も書かずに諦める**（次のティックで読み直してやり直す）。
 *
 * 読み直しから書き込みまでを serializeWrite の中で完結させているので、
 * 自分自身の他の書き込みが割り込む余地は無い。
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export function writeScanFileIfUnchanged(dateString, data, expectedHash) {
  return serializeWrite(async () => {
    let raw;
    try {
      raw = await fs.readFile(scanFilePath(dateString), 'utf-8');
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, reason: 'missing' };
      throw error;
    }

    if (hashOf(raw) !== expectedHash) {
      return { ok: false, reason: 'conflict' };
    }

    await atomicWriteFile(scanFilePath(dateString), serialize(data));
    return { ok: true };
  });
}

export function hashOf(text) {
  return crypto.createHash('sha256').update(String(text), 'utf-8').digest('hex');
}

/** 書き出しの形を1か所に固定する（ハッシュ照合が揺れないように） */
function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** 契約どおりの候補オブジェクトを作る。キーの順序も固定する */
export function makeCandidate({
  id, channelId, channelName, assigneeName, assigneeId, due, title, evidence,
}) {
  return {
    id,
    channel_id: channelId,
    channel_name: channelName,
    assignee_name: assigneeName ?? null,
    assignee_id: assigneeId ?? null,
    due: due ?? null,
    title,
    evidence: {
      text: evidence.text,
      author: evidence.author,
      posted_at: evidence.postedAt ?? null,
      message_url: evidence.messageUrl ?? null,
    },
    // ここから先はポータルとBotが後から書き込む欄。生成時は必ず null
    decision: null,
    notify: null,
    decided_at: null,
    task_id: null,
  };
}

/** ポータルから元発言に飛べるようにする。guild/channel/message の3点が揃って初めて成立する */
export function buildMessageUrl(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
