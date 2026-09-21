import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { jstDateString, jstIsoString } from '../utils/datetime.js';
import { listOpenTasks } from '../storage/tasks.js';
import {
  fetchChannelMessages, pickMessages, selectChannels, warnEmptyContent, warnIfContentLooksDisabled,
} from './collect.js';
import { createRunnerClient } from './runnerClient.js';
import { advanceCursors, readCursors, readIgnoredFingerprints } from './store.js';
import {
  buildMessageUrl, makeCandidate, readScanFile, writeScanFile, writeScanFileIfUnchanged,
} from './scanFile.js';
import { duplicatesExistingTask, fingerprint, normalizeTitle } from './dedupe.js';

// 1日1回の会話走査。
//
// ★ ジョブは **1日1本にまとめる**。
//   claude-runner は1ジョブあたり約6,700トークンの固定オーバーヘッドがあるので、
//   11チャンネルを別ジョブにすると、それだけで7万トークンを超えてしまう。

/**
 * 走査を1回実行する。
 * @returns {Promise<{ ok: boolean, date: string, candidates: any[], stats: object, error?: string }>}
 */
export async function runScan(client, nowMs = Date.now()) {
  const date = jstDateString(nowMs);
  const generated = jstIsoString(nowMs);
  const stats = {
    channels: 0, excluded: 0, messages: 0, quoted: 0, jobs: 0,
    rawCandidates: 0, droppedDuplicate: 0, droppedIgnored: 0, droppedUnmatched: 0,
    contentLooksDisabled: false, truncatedChannels: [],
  };

  const guild = await client.guilds.fetch(config.discord.guildId);
  const { targets, excluded } = await selectChannels(guild);
  stats.channels = targets.length;
  stats.excluded = excluded.length;

  logger.info(`[Scan] ${date} 対象 ${targets.length}ch / 除外 ${excluded.length}ch`);
  for (const e of excluded) logger.info(`[Scan]   除外: #${e.name} (${e.id}) — ${e.reason}`);

  // ---- ① 前回の続きから発言を集める ----
  const cursors = await readCursors();
  const quoted = [];
  const sources = new Map();      // messageId → { channelId, channelName, text, author, postedAt }
  const channelRanges = [];       // 引用の何番から何番がどのチャンネルか（Claudeに渡す）
  const cursorUpdates = {};
  let humanTotal = 0;
  let emptyTotal = 0;

  for (const target of targets) {
    const cursorId = cursors[target.id]?.lastMessageId || null;
    let fetched;
    try {
      fetched = await fetchChannelMessages(target.channel, { cursorId, nowMs });
    } catch (error) {
      // 1チャンネル読めなくても走査全体は続ける（権限変更・一時的な失敗）
      logger.warn(`[Scan] #${target.name} の取得に失敗しました: ${error.message}`);
      continue;
    }

    if (fetched.newestId) cursorUpdates[target.id] = fetched.newestId;
    if (fetched.hitLimit) stats.truncatedChannels.push(target.name);

    const { picked, emptyCount, humanCount } = pickMessages(fetched.messages, client.user?.id);
    humanTotal += humanCount;
    emptyTotal += emptyCount;
    warnEmptyContent(target.name, { humanCount, emptyCount });
    stats.messages += fetched.messages.length;
    if (picked.length === 0) continue;

    const from = quoted.length + 1;
    for (const message of picked) {
      const postedAt = new Date(message.createdTimestamp ?? Date.now()).toISOString();
      const author = displayNameOf(message);
      const text = String(message.content).trim();

      quoted.push({
        source: `discord:${message.id}`,
        author,
        text,
        postedAt,
      });
      sources.set(String(message.id), {
        messageId: String(message.id),
        channelId: target.id,
        channelName: target.name,
        author,
        text,
        postedAt,
      });
    }
    channelRanges.push({
      id: target.id, name: target.name, quote_from: from, quote_to: quoted.length,
    });
  }

  stats.quoted = quoted.length;
  stats.contentLooksDisabled = warnIfContentLooksDisabled({
    humanCount: humanTotal, emptyCount: emptyTotal, pickedCount: quoted.length,
  });

  // カーソルは「Claudeに渡したかどうか」に関係なく進める。
  // Botの投稿しか無かったチャンネルを毎回読み直しても意味が無いため。
  await advanceCursors(cursorUpdates, generated);

  if (quoted.length === 0) {
    logger.info('[Scan] 新しい発言がありませんでした（候補なし）');
    // ⚠ 空で上書きしない。同じ日に既に判断済みの候補があれば必ず残す
    await persistCandidates(date, generated, [], stats);
    return { ok: true, date, candidates: [], stats };
  }

  // ---- ② claude-runner に1本だけ投げる ----
  const openTasks = await listOpenTasks();
  const runner = createRunnerClient({ queueDir: config.scan.runnerQueueDir, bot: 'pm' });

  const job = {
    kind: 'digest.extract',
    outputSchema: 'digest.v1',
    model: config.scan.runnerModel,
    timeoutSec: Math.floor(config.scan.jobTimeoutMs / 1000),
    input: {
      scan_date: date,
      guild_id: config.discord.guildId,
      // 引用[n] がどのチャンネルの発言かの対応表。channel_id はここから選ぶこと
      channels: channelRanges,
      // 既に登録済みのタスク。これと同じ内容は候補にしない
      existing_tasks: openTasks.map((t) => ({ title: t.title, assignee_name: t.assigneeName })),
      notes: [
        'channels[] の quote_from / quote_to は、引用ブロックの [n] 番号の範囲です。',
        'candidates[].channel_id / channel_name は、その発言が属するチャンネルのものを使ってください。',
        'evidence.text は引用の文言をそのまま写してください（依頼側が発言を特定するのに使います）。',
        'evidence.message_url は null のままで構いません（依頼側が組み立てます）。',
        'existing_tasks と同じ内容は候補にしないでください。',
      ],
    },
    quoted,
  };

  stats.jobs = 1;
  logger.info(`[Scan] runner にジョブを1本投げます（引用 ${quoted.length} 件 / ${channelRanges.length}ch）`);

  const result = await runner.runJob(job, {
    timeoutMs: config.scan.jobTimeoutMs,
    intervalMs: config.scan.jobPollIntervalMs,
  });

  if (result.status !== 'ok' || !result.output) {
    const reason = `${result.errorCode || result.status}: ${String(result.logTail || '').slice(0, 300)}`;
    logger.error(`[Scan] runner のジョブが失敗しました — ${reason}`);
    return { ok: false, date, candidates: [], stats, error: reason };
  }

  // ---- ③ 結果を契約の形に整える ----
  const raw = Array.isArray(result.output.candidates) ? result.output.candidates : [];
  stats.rawCandidates = raw.length;

  const ignored = await readIgnoredFingerprints();

  // 根拠の発言を突き止めて「契約の形の一歩手前」まで整える。
  // ⚠ チャンネル・発言URL・投稿時刻は **Claudeの出力を信用せず** こちらで付け直す。
  const shapedList = [];
  const seen = new Set();

  for (const item of raw) {
    const title = String(item?.title ?? '').trim();
    if (!title) continue;

    const source = matchSource(item, sources);
    if (!source) {
      stats.droppedUnmatched += 1;
      logger.warn(`[Scan] 根拠の発言を特定できない候補を捨てました: ${title.slice(0, 60)}`);
      continue;
    }

    const assigneeName = nullableString(item?.assignee_name);
    const fp = fingerprint(title, assigneeName);
    if (ignored[fp]) { stats.droppedIgnored += 1; continue; }
    if (seen.has(fp)) { stats.droppedIgnored += 1; continue; }

    const shaped = {
      title,
      assignee_name: assigneeName,
      assignee_id: nullableString(item?.assignee_id),
      due: validDate(item?.due),
    };
    if (duplicatesExistingTask(shaped, openTasks)) { stats.droppedDuplicate += 1; continue; }

    seen.add(fp);
    shapedList.push({ ...shaped, fp, source });
  }

  const candidates = await persistCandidates(date, generated, shapedList, stats);
  logger.info(
    `[Scan] ${date} 候補 ${candidates.length} 件`
    + `（Claudeの出力 ${stats.rawCandidates} 件 / 重複 ${stats.droppedDuplicate} / 却下済み ${stats.droppedIgnored} / 根拠不明 ${stats.droppedUnmatched}）`,
  );

  return { ok: true, date, candidates, stats };
}

// ---- 書き出し -------------------------------------------------------

/**
 * 走査結果を scans/YYYY-MM-DD.json に書く。
 *
 * ⚠ 同じ日に2回走った場合（手動再実行・日をまたぐ復旧など）に、
 *    **既に判断済み／タスク化済みの候補を消さない**。
 *    ポータルが decision を入れた候補を上書きで消すと、判断がやり直しになるうえ
 *    task_id を失って二重作成の危険が出る。
 * ⚠ 既存ファイルがある場合はハッシュ照合つきで書く（ポータルが同時に触っている可能性）。
 *
 * @returns {Promise<any[]>} 今回新しく足した候補
 */
async function persistCandidates(date, generated, shapedList, stats) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const existing = await readScanFile(date);
    const kept = existing
      ? existing.data.candidates.filter((c) => c && (c.decision !== null || c.task_id))
      : [];
    const keptFps = new Set(kept.map((c) => fingerprint(c.title, c.assignee_name)));

    let seq = kept.reduce((max, c) => Math.max(max, seqOf(c.id)), 0);
    const fresh = [];
    for (const shaped of shapedList) {
      if (keptFps.has(shaped.fp)) continue; // 既に判断済みの候補と同じ内容は足さない
      seq += 1;
      fresh.push(makeCandidate({
        id: `cand-${date.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`,
        channelId: shaped.source.channelId,
        channelName: shaped.source.channelName,
        assigneeName: shaped.assignee_name,
        assigneeId: shaped.assignee_id,
        due: shaped.due,
        title: shaped.title,
        evidence: {
          text: shaped.source.text,
          author: shaped.source.author,
          postedAt: shaped.source.postedAt,
          messageUrl: buildMessageUrl(
            config.discord.guildId, shaped.source.channelId, shaped.source.messageId,
          ),
        },
      }));
    }

    const data = { date, generated, candidates: [...kept, ...fresh] };

    if (!existing) {
      await writeScanFile(date, data);
      return fresh;
    }
    const result = await writeScanFileIfUnchanged(date, data, existing.hash);
    if (result.ok) return fresh;
    if (result.reason === 'missing') {
      await writeScanFile(date, data);
      return fresh;
    }
    logger.warn(`[Scan] scans/${date}.json の書き出しが競合しました（${attempt}回目）。読み直してやり直します`);
  }
  throw new Error(`scans/${date}.json への書き出しが3回とも競合しました（ポータルが書き換え続けています）`);
}

/** "cand-20260922-03" → 3 */
function seqOf(id) {
  const m = String(id || '').match(/-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// ---- helpers --------------------------------------------------------

/**
 * Claudeが書いた evidence.text から、元の発言を突き止める。
 * スキーマで「そのまま写すこと」と指示しているので、まず完全一致を見る。
 * 多少の表記ゆれ（前後の空白・改行）まで許すが、当て推量はしない。
 */
function matchSource(item, sources) {
  const text = String(item?.evidence?.text ?? '').trim();
  if (!text) return null;

  const author = String(item?.evidence?.author ?? '').trim();
  const norm = normalizeTitle(text);

  let looseHit = null;
  for (const source of sources.values()) {
    if (source.text === text) return source;
    const sourceNorm = normalizeTitle(source.text);
    if (!sourceNorm || !norm) continue;
    if (sourceNorm === norm || sourceNorm.includes(norm)) {
      // 投稿者まで一致するものを優先する（同じ文言が複数チャンネルにある場合の取り違え防止）
      if (author && source.author === author) return source;
      if (!looseHit) looseHit = source;
    }
  }
  return looseHit;
}

function displayNameOf(message) {
  return message.member?.displayName
    || message.member?.nickname
    || message.author?.globalName
    || message.author?.username
    || String(message.author?.id ?? 'unknown');
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** due は "YYYY-MM-DD" だけ受ける。崩れていたら null（勝手に補正しない） */
function validDate(value) {
  const s = nullableString(value);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}
