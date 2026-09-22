import { ChannelType } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// 走査対象チャンネルの決定と、メッセージの取り出し。
//
// ⚠ ゲートウェイの Intent は Guilds のまま（既存の設計を崩さない）。
//    ここで使う messages.fetch は REST なので GuildMessages Intent は要らない。
//    ただし **MESSAGE CONTENT（特権Intent）が Developer Portal で無効だと
//    本文が空文字で返る**（実測済み）。コード側では警告を出すところまで。

const ARCHIVE_CATEGORY_NAME = 'archive';
const PAGE_SIZE = 100;

/**
 * 走査対象のテキストチャンネルを決める。
 * 除外の判定順は要件どおり: archive カテゴリ → 設定の除外 → 通知先チャンネル。
 * （Bot自身の投稿の除外はメッセージ単位なので pickMessages 側で行う）
 *
 * @returns {{ targets: Array<{id,name,channel}>, excluded: Array<{id,name,reason}> }}
 */
export async function selectChannels(guild) {
  // ⚠ 実行時に取り直す。IDを直書きすると、後から archive に移したチャンネルが
  //    いつまでも走査対象のまま残ってしまう
  const all = await guild.channels.fetch();

  const excludeIds = new Set(config.scan.excludeChannelIds);
  const notifyIds = new Set(config.scan.notifyChannelIds);

  const targets = [];
  const excluded = [];

  for (const channel of all.values()) {
    if (!channel) continue;
    if (channel.type !== ChannelType.GuildText) continue;

    const entry = { id: channel.id, name: channel.name || '', channel };

    const parent = channel.parentId ? all.get(channel.parentId) : null;
    if (isArchiveCategory(parent)) {
      excluded.push({ ...entry, channel: undefined, reason: `archive カテゴリ配下（${parent.name}）` });
      continue;
    }
    if (excludeIds.has(channel.id)) {
      excluded.push({ ...entry, channel: undefined, reason: 'SCAN_EXCLUDE_CHANNEL_IDS' });
      continue;
    }
    if (notifyIds.has(channel.id)) {
      excluded.push({ ...entry, channel: undefined, reason: 'PM Bot の通知先チャンネル' });
      continue;
    }
    // ⚠ 走査レポートの投稿先は必ず外す（自分の通知を読み返して候補にしないため）。
    //    設定漏れで事故らないよう、SCAN_EXCLUDE_CHANNEL_IDS とは別にコード側でも塞いでいる。
    if (config.scan.reportChannelId && channel.id === config.scan.reportChannelId) {
      excluded.push({ ...entry, channel: undefined, reason: 'PM Bot の走査レポート投稿先' });
      continue;
    }
    if (!canRead(channel, guild)) {
      excluded.push({ ...entry, channel: undefined, reason: '閲覧権限なし' });
      continue;
    }

    targets.push(entry);
  }

  // 出力の順序を安定させる（結果JSONの差分が読みやすくなる）
  targets.sort((a, b) => a.id.localeCompare(b.id));
  excluded.sort((a, b) => a.id.localeCompare(b.id));
  return { targets, excluded };
}

/** カテゴリ名が "archive"（大小文字・前後の空白は無視）かどうか */
function isArchiveCategory(parent) {
  if (!parent) return false;
  if (parent.type !== undefined && parent.type !== ChannelType.GuildCategory) return false;
  return String(parent.name || '').trim().toLowerCase() === ARCHIVE_CATEGORY_NAME;
}

/** Botが読めるか。権限が取れない環境では「読める」に倒す（取れないこと自体は異常ではない） */
function canRead(channel, guild) {
  const me = guild.members?.me;
  if (!me || typeof channel.permissionsFor !== 'function') return true;
  const perms = channel.permissionsFor(me);
  if (!perms || typeof perms.has !== 'function') return true;
  return perms.has('ViewChannel') && perms.has('ReadMessageHistory');
}

/**
 * 1チャンネルぶんのメッセージを取る。
 *
 * ⚠ **新しい方から**ページングする。
 *    上限（既定200件）に当たったときに「新しい方を優先し、カーソルは進める」
 *    という要件を、分岐を増やさずそのまま満たせるため。
 *
 * 停止条件:
 *    - カーソルあり : カーソル以前のメッセージに到達したら止める（同じ発言を二度渡さない）
 *    - カーソルなし : 直近 SCAN_FIRST_RUN_HOURS 時間より古いものに到達したら止める
 *                     （SCAN_FIRST_RUN_HOURS=0 なら期間の制限なし＝チャンネルの最初まで読む）
 *    - 共通         : 取得上限に達したら止める
 *
 * ★ バックフィル（カーソルなし かつ SCAN_FIRST_RUN_HOURS=0）のときだけ
 *   1チャンネルの取得上限を外す。本人の指示「基本は直近24時間でいいけど、初回は全部やる」のため。
 *   1ジョブが膨らまないようにするのは呼び出し側（scan.js）のジョブ分割の仕事。
 *   ⚠ 期間の制限がある通常運用では、新しいチャンネルでも上限（既定200件）は必ず効かせる。
 *
 * @returns {Promise<{ messages: any[], newestId: string|null, hitLimit: boolean, fetched: number }>}
 */
export async function fetchChannelMessages(channel, { cursorId, nowMs }) {
  const cursor = cursorId ? toSnowflake(cursorId) : null;
  const backfill = cursor === null && config.scan.firstRunHours === 0;
  const limit = backfill ? Infinity : config.scan.maxMessagesPerChannel;
  // firstRunHours=0 は「期間の制限なし」。-Infinity にしておけば分岐を足さずに済む
  const cutoffMs = config.scan.firstRunHours > 0
    ? nowMs - config.scan.firstRunHours * 60 * 60 * 1000
    : -Infinity;

  const collected = [];
  let newestId = null;
  let before;
  let reachedEnd = false;
  let fetched = 0;

  while (collected.length < limit && !reachedEnd) {
    const options = { limit: PAGE_SIZE };
    if (before) options.before = before;

    const page = await channel.messages.fetch(options);
    const list = [...page.values()].sort((a, b) => cmpSnowflake(b.id, a.id)); // 新しい順
    if (list.length === 0) break;

    fetched += list.length;
    if (!newestId) newestId = list[0].id;
    before = list[list.length - 1].id;

    for (const message of list) {
      if (cursor !== null) {
        if (toSnowflake(message.id) <= cursor) { reachedEnd = true; break; }
      } else if (createdMs(message) < cutoffMs) {
        reachedEnd = true;
        break;
      }
      if (collected.length >= limit) break;
      collected.push(message);
    }

    if (list.length < PAGE_SIZE) break; // これ以上古いメッセージは無い
  }

  const hitLimit = collected.length >= limit && !reachedEnd;
  collected.reverse(); // 時系列（古い→新しい）に戻す。会話として読ませるため
  return { messages: collected, newestId, hitLimit, fetched };
}

/**
 * 取得したメッセージから、Claudeに渡す分だけを選ぶ。
 * ここで落とすのは「Bot自身の投稿」「他のBotの投稿」「本文が空のもの」。
 *
 * @returns {{ picked: any[], botCount: number, emptyCount: number, humanCount: number }}
 */
export function pickMessages(messages, selfUserId) {
  let botCount = 0;
  let emptyCount = 0;
  let humanCount = 0;
  const picked = [];

  for (const message of messages) {
    const authorId = message.author?.id ? String(message.author.id) : '';
    // 自分の通知を読み返さない。他のBotの自動投稿も会話ではないので外す
    if (authorId === String(selfUserId) || message.author?.bot) { botCount += 1; continue; }

    humanCount += 1;
    const text = String(message.content ?? '').trim();
    if (text === '') { emptyCount += 1; continue; }

    picked.push(message);
  }

  return { picked, botCount, emptyCount, humanCount };
}

// ---- 本文が空だったときの警告 ---------------------------------------
//
// ⚠ 黙って0件で終わると「今日は話題が無かった」と区別がつかない。必ず声を出す。
//    MESSAGE CONTENT Intent（特権Intent）が無効だと本文が空文字で返ってくる（実測済み）。

/** チャンネル単位。空の発言が1件でもあれば言う */
export function warnEmptyContent(channelName, { humanCount, emptyCount }) {
  if (emptyCount === 0) return false;
  logger.warn(
    `[Scan] #${channelName}: 人の発言 ${humanCount} 件のうち ${emptyCount} 件が本文が空でした。`
    + ' 添付だけの投稿でなければ、Discord Developer Portal の MESSAGE CONTENT Intent が'
    + ' 無効になっている可能性があります（有効化はオーナーの作業です）。',
  );
  return true;
}

/** 走査全体。人の発言が1件も読めていないなら、ほぼ確実に Intent の問題 */
export function warnIfContentLooksDisabled({ humanCount, emptyCount, pickedCount }) {
  if (humanCount === 0) return false;
  if (pickedCount > 0) return false;
  if (emptyCount < humanCount) return false;

  logger.warn(
    `[Scan] ★ 人の発言を ${humanCount} 件取得しましたが、本文がすべて空でした。`
    + ' Discord Developer Portal の MESSAGE CONTENT Intent が無効になっている可能性が高いです'
    + '（有効化はオーナーの作業です）。走査は0件で終わりますが、原因は「話題が無かった」ではありません。',
  );
  return true;
}

// ---- Snowflake（メッセージID）の比較 --------------------------------
// ⚠ Number にすると 2^53 を超えて桁落ちする。必ず BigInt で比べる。

export function toSnowflake(id) {
  try { return BigInt(String(id)); } catch { return 0n; }
}

export function cmpSnowflake(a, b) {
  const x = toSnowflake(a);
  const y = toSnowflake(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

export function createdMs(message) {
  if (Number.isFinite(message?.createdTimestamp)) return message.createdTimestamp;
  // Discord の Snowflake は 2015-01-01 起点のミリ秒を上位42bitに持つ
  return Number((toSnowflake(message?.id) >> 22n) + 1420070400000n);
}
