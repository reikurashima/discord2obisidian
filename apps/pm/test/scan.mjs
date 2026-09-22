// 会話走査（毎日のタスク候補抽出）の検証ハーネス。
//
//   node --import ./test/loader.mjs ./test/scan.mjs --dir=<作業ディレクトリ>
//
// discord.js と claude-runner をスタブ化して、本体のコードを1行も変えずに実際に動かす。
// 実際のDiscordにもNASにも一切触らない。

import { promises as fs } from 'fs';
import path from 'path';
import { startStubRunner, okResult, errorResult } from './stub/runner.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const workDir = path.resolve(args.dir || './test/.tmp-scan');
const stateDir = path.join(workDir, 'data');
const queueDir = path.join(workDir, 'runner-queue');

const OWNER = 'owner-1';
const GUILD = 'guild-1';

process.env.DISCORD_TOKEN = 'stub-token';
process.env.GUILD_ID = GUILD;
process.env.OWNER_USER_ID = OWNER;
process.env.STATE_DIR = stateDir;
process.env.SCAN_ENABLED = '1';
process.env.SCAN_AT = '09:00';
process.env.SCAN_EXCLUDE_CHANNEL_IDS = 'chan-excluded';
process.env.SCAN_NOTIFY_CHANNEL_IDS = 'chan-notify';
process.env.SCAN_FIRST_RUN_HOURS = '24';
process.env.SCAN_MAX_MESSAGES_PER_CHANNEL = '200';
process.env.RUNNER_QUEUE_DIR = queueDir;
process.env.SCAN_JOB_TIMEOUT_MS = '20000';
process.env.SCAN_JOB_POLL_INTERVAL_MS = '30';
process.env.SCAN_REPORT_CHANNEL_ID = 'chan-report';
process.env.SCAN_RUN_ON_BOOT = '0';
process.env.PORTAL_PM_URL = 'https://portal.example/pm';

await fs.rm(workDir, { recursive: true, force: true });
await fs.mkdir(stateDir, { recursive: true });

// ⚠ 起動直後のティックで「今日ぶんの走査」が勝手に走り出さないようにしておく。
//    実行した実時刻が SCAN_AT(09:00) を過ぎているかどうかでテスト結果が変わってしまうため。
//    このテストは走査を forceScan で明示的に呼ぶ。
await fs.mkdir(path.join(stateDir, '.state'), { recursive: true });
await fs.writeFile(
  path.join(stateDir, '.state', 'scan-state.json'),
  `${JSON.stringify({ lastScanDate: todayJst(), lastStatus: 'ok', lastError: null }, null, 2)}\n`,
  'utf-8',
);

function todayJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---- 検証結果の集計 -------------------------------------------------

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
}

// ---- ログを覗く（警告が出たことの確認用） ---------------------------

const capturedWarnings = [];
const realWarn = console.warn;
console.warn = (...a) => { capturedWarnings.push(a.join(' ')); realWarn(...a); };

// ---- Bot を起動 -----------------------------------------------------

const stub = await import('./stub/discord.js');
await import('../src/index.js');

const { discordClient } = await import('../src/discord/client.js');
const { runScanTick, __resetScanning } = await import('../src/scan/tick.js');
const { stopReminderLoop } = await import('../src/reminders/tick.js');
const { listTasks } = await import('../src/storage/tasks.js');
const { jstDateString, jstToMs, jstParts } = await import('../src/utils/datetime.js');
const { writeScanFileIfUnchanged, readScanFile, hashOf } = await import('../src/scan/scanFile.js');

await waitFor(() => discordClient.user, 'login');
stopReminderLoop(); // 自動ティックは止めて、テストから明示的に呼ぶ

// ---- 時刻とメッセージID --------------------------------------------
// 走査時刻はJSTの今日9:00。メッセージIDは Snowflake 風（大小比較＝時系列）。

const NOW = (() => {
  const p = jstParts(Date.now());
  return jstToMs(p.year, p.month, p.day, 9, 0, 0);
})();
const TODAY = jstDateString(NOW);
const HOUR = 60 * 60 * 1000;

function snowflake(ms) {
  return ((BigInt(Math.floor(ms)) - 1420070400000n) << 22n).toString();
}

let msgSeq = 0;
function msg(channelId, { text, author, authorId, bot = false, atMs }) {
  msgSeq += 1;
  const ms = atMs + msgSeq; // 同じ時刻でもIDが単調増加するように
  const m = {
    id: snowflake(ms),
    content: text,
    createdTimestamp: ms,
    author: { id: authorId, username: author, globalName: author, bot },
    member: { displayName: author },
  };
  stub.__addMessage(channelId, m);
  return m;
}

// ---- チャンネル構成 -------------------------------------------------

stub.__channels.clear();
stub.__addChannel({ id: 'cat-active', name: '進行中', type: stub.ChannelType.GuildCategory });
stub.__addChannel({ id: 'cat-archive', name: 'Archive', type: stub.ChannelType.GuildCategory });
stub.__addChannel({ id: 'chan-1', name: '案件A', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-2', name: '案件B', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-archived', name: '案件Z-終了', parentId: 'cat-archive' });
stub.__addChannel({ id: 'chan-excluded', name: '雑談', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-notify', name: 'pm-通知', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-report', name: 'pm', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-empty', name: '本文が空', parentId: 'cat-active' });
stub.__addChannel({ id: 'voice-1', name: '作業通話', type: stub.ChannelType.GuildVoice, parentId: 'cat-active' });

// ---- 発言（1回目の走査で読まれるぶん） ------------------------------

const TXT_A = '田中さん、修正版データの提出を 2026-10-15 までにお願いできますか？';
const TXT_B = '佐藤さん、絵コンテのチェックを来週金曜（2026-10-03）までにお願いします。';
const TXT_OLD = '48時間前の発言なので初回走査では読まれないはず';

msg('chan-1', { text: TXT_OLD, author: 'Rei', authorId: OWNER, atMs: NOW - 48 * HOUR });
const mA = msg('chan-1', { text: TXT_A, author: 'Rei', authorId: OWNER, atMs: NOW - 3 * HOUR });
msg('chan-1', { text: '📌 **#99** <@user-tanaka> さんに『別件』をお願いしました', author: 'PM Bot', authorId: 'app-0001', bot: true, atMs: NOW - 2 * HOUR });
msg('chan-1', { text: '他のBotの自動投稿です', author: 'Other Bot', authorId: 'bot-9', bot: true, atMs: NOW - 2 * HOUR });
const mB = msg('chan-2', { text: TXT_B, author: 'Rei', authorId: OWNER, atMs: NOW - 4 * HOUR });
msg('chan-archived', { text: 'アーカイブの発言。読まれてはいけない', author: 'Rei', authorId: OWNER, atMs: NOW - HOUR });
msg('chan-excluded', { text: '除外設定のチャンネル。読まれてはいけない', author: 'Rei', authorId: OWNER, atMs: NOW - HOUR });
msg('chan-notify', { text: '通知先チャンネル。読まれてはいけない', author: 'Rei', authorId: OWNER, atMs: NOW - HOUR });
msg('chan-report', { text: '走査レポートの投稿先。読まれてはいけない', author: 'Rei', authorId: OWNER, atMs: NOW - HOUR });
msg('chan-empty', { text: '', author: 'Rei', authorId: OWNER, atMs: NOW - HOUR });
msg('voice-1', { text: 'ボイスチャンネル。対象外', author: 'Rei', authorId: OWNER, atMs: NOW - HOUR });

// ---- スタブ runner -------------------------------------------------

let nextResponse = null;
const runner = startStubRunner(queueDir, {
  respond: async (job) => (nextResponse ? nextResponse(job) : okResult(job.jobId, [])),
});

// =====================================================================
//  1. 初回走査
// =====================================================================
console.log('\n===== 1. 初回走査（対象の絞り込み・1ジョブ・契約どおりのJSON） =====\n');

nextResponse = (job) => okResult(job.jobId, [
  {
    channel_id: 'chan-1',
    channel_name: '案件A',
    assignee_name: '田中',
    assignee_id: null,
    due: '2026-10-15',
    title: '修正版データの提出',
    evidence: {
      text: TXT_A, author: 'Rei', posted_at: null, message_url: null,
    },
  },
  {
    channel_id: 'chan-2',
    channel_name: '案件B',
    assignee_name: '佐藤',
    assignee_id: 'user-sato',
    due: '2026-10-03',
    title: '絵コンテのチェック',
    evidence: {
      text: TXT_B, author: 'Rei', posted_at: null, message_url: null,
    },
  },
  {
    // 根拠の発言がこちらの引用に無い＝Claudeの作り話。捨てられること
    channel_id: 'chan-1',
    channel_name: '案件A',
    assignee_name: '誰か',
    assignee_id: null,
    due: null,
    title: '存在しない発言から作られた候補',
    evidence: {
      text: 'このテキストはBotが渡していない', author: '？', posted_at: null, message_url: null,
    },
  },
]);

const scan1 = await runScanTick(discordClient, NOW, { forceScan: true });

check('走査が成功する', scan1.scan?.ok === true, JSON.stringify(scan1.scan?.stats));

// --- ジョブは1本だけ ---
check(
  '1回の走査で claude-runner に投げたジョブは1本だけ（チャンネル数だけ増えない）',
  runner.jobs.length === 1,
  `jobs=${runner.jobs.length} / 対象チャンネル数=${scan1.scan.stats.channels}`,
);

const job = runner.jobs[0];
check(
  'ジョブの kind / outputSchema / model が要件どおり',
  job.kind === 'digest.extract' && job.outputSchema === 'digest.v1' && job.model === 'haiku' && job.bot === 'pm',
  `kind=${job.kind} schema=${job.outputSchema} model=${job.model} bot=${job.bot}`,
);

// --- 除外の検証 ---
const quotedTexts = job.quoted.map((q) => q.text);
check(
  'archive カテゴリ配下のチャンネルが除外される（カテゴリ名で判定・IDの直書きなし）',
  !quotedTexts.some((t) => t.includes('アーカイブの発言'))
    && !job.input.channels.some((c) => c.id === 'chan-archived'),
  `引用に含まれるチャンネル: ${job.input.channels.map((c) => c.name).join(', ')}`,
);
check(
  'SCAN_EXCLUDE_CHANNEL_IDS のチャンネルが除外される',
  !quotedTexts.some((t) => t.includes('除外設定のチャンネル')),
);
check(
  '通知先チャンネル（SCAN_NOTIFY_CHANNEL_IDS）が除外される',
  !quotedTexts.some((t) => t.includes('通知先チャンネル')),
);
check(
  '走査レポートの投稿先チャンネルが走査対象から除外される（自分の通知を読み返さない）',
  !quotedTexts.some((t) => t.includes('走査レポートの投稿先'))
    && !job.input.channels.some((c) => c.id === 'chan-report'),
  `対象チャンネル: ${job.input.channels.map((c) => c.name).join(', ')}`,
);
check(
  'Bot自身の投稿と他のBotの投稿が除外される',
  !quotedTexts.some((t) => t.includes('別件') || t.includes('他のBotの自動投稿')),
);
check(
  'テキストチャンネル以外（ボイス・カテゴリ）は対象外',
  !quotedTexts.some((t) => t.includes('ボイスチャンネル')),
);
check(
  '初回は直近24時間ぶんだけ（48時間前の発言は渡さない）',
  !quotedTexts.includes(TXT_OLD) && quotedTexts.includes(TXT_A),
  `引用 ${job.quoted.length} 件:\n${job.quoted.map((q) => `[${q.source}] ${q.author}: ${q.text}`).join('\n')}`,
);
check(
  'quoted の形が runner の約束どおり（source は discord:<messageId>）',
  job.quoted.every((q) => /^discord:\d+$/.test(q.source) && q.author && q.text && /^\d{4}-\d{2}-\d{2}T/.test(q.postedAt)),
  JSON.stringify(job.quoted[0]),
);
check(
  'チャンネル名も渡している（どの案件の話か判断させるため）',
  job.input.channels.some((c) => c.name === '案件A') && job.input.channels.some((c) => c.name === '案件B'),
  JSON.stringify(job.input.channels),
);

// --- 本文が空のときの警告 ---
check(
  '本文が空のときに MESSAGE CONTENT Intent の警告ログが出る（チャンネル単位）',
  capturedWarnings.some((w) => w.includes('MESSAGE CONTENT') && w.includes('本文が空')),
  capturedWarnings.find((w) => w.includes('MESSAGE CONTENT')) || '(警告が出ていません)',
);

// --- 結果JSONの契約 ---
const scanPath = path.join(stateDir, 'scans', `${TODAY}.json`);
const scanJson = JSON.parse(await fs.readFile(scanPath, 'utf-8'));
check(
  `scans/${TODAY}.json が契約どおりの形で書かれる`,
  scanJson.date === TODAY
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(scanJson.generated)
    && scanJson.candidates.length === 2,
  JSON.stringify(scanJson, null, 2),
);

const cand1 = scanJson.candidates[0];
check(
  '候補のキーが契約どおり（decision / notify / decided_at / task_id は null で生成）',
  JSON.stringify(Object.keys(cand1)) === JSON.stringify([
    'id', 'channel_id', 'channel_name', 'assignee_name', 'assignee_id',
    'due', 'title', 'evidence', 'decision', 'notify', 'decided_at', 'task_id',
  ])
    && JSON.stringify(Object.keys(cand1.evidence)) === JSON.stringify(['text', 'author', 'posted_at', 'message_url'])
    && cand1.decision === null && cand1.notify === null && cand1.decided_at === null && cand1.task_id === null
    && cand1.id === `cand-${TODAY.replace(/-/g, '')}-01`,
  JSON.stringify(cand1, null, 2),
);
check(
  'message_url が guild/channel/message から正しく組み立てられている',
  cand1.evidence.message_url === `https://discord.com/channels/${GUILD}/chan-1/${mA.id}`
    && scanJson.candidates[1].evidence.message_url === `https://discord.com/channels/${GUILD}/chan-2/${mB.id}`,
  `${cand1.evidence.message_url}\n${scanJson.candidates[1].evidence.message_url}`,
);
check(
  '根拠の発言を特定できない候補は捨てられる（Claudeの作り話を通さない）',
  scanJson.candidates.length === 2
    && !scanJson.candidates.some((c) => c.title.includes('存在しない発言')),
  `droppedUnmatched=${scan1.scan.stats.droppedUnmatched}`,
);
check(
  'evidence の投稿者・投稿時刻はBot側の実データで埋める（Claudeの null を鵜呑みにしない）',
  cand1.evidence.author === 'Rei' && /^\d{4}-\d{2}-\d{2}T/.test(cand1.evidence.posted_at),
  JSON.stringify(cand1.evidence),
);

// --- 走査レポート（pm チャンネルへ。DMは廃止） ---
const report1 = takeReports();
check(
  '走査レポートが pm チャンネルに1通だけ投稿される（オーナーへのDMは送らない）',
  report1.length === 1 && report1[0].channelId === 'chan-report' && stub.__dms.length === 0,
  `reports=${report1.length} dms=${stub.__dms.length}`,
);
check(
  'レポートの文面が指定どおり（🔍見出し・実行/対象/候補/使用・ポータルのリンク・候補の中身は書かない）',
  report1[0].content.startsWith('## 🔍 会話の走査を実行しました\n```\n')
    && /\n実行     \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/.test(report1[0].content)
    && /\n対象     3チャンネル \/ 発言 2件\n/.test(report1[0].content)
    && /\n候補     2件（未判断）\n/.test(report1[0].content)
    && /\n使用     Claude Haiku 4\.5 \/ ジョブ 1本\n/.test(report1[0].content)
    && report1[0].content.includes('; 判断はこちらから\nhttps://portal.example/pm/scans')
    && report1[0].content.endsWith('```')
    && !report1[0].content.includes('修正版データ'),
  report1[0].content,
);
check(
  'レポートはメンションしない（毎日飛ぶので鳴らさない）',
  JSON.stringify(report1[0].allowedMentions) === JSON.stringify({ parse: [], users: [] })
    && !/<@[!&]?\d/.test(report1[0].content)
    && !report1[0].content.includes('@everyone') && !report1[0].content.includes('@here'),
  JSON.stringify(report1[0].allowedMentions),
);

// --- カーソル ---
const cursors = JSON.parse(await fs.readFile(path.join(stateDir, '.state', 'scan-cursor.json'), 'utf-8'));
check(
  'チャンネルごとに最後に読んだメッセージIDが保存される',
  Object.keys(cursors).sort().join(',') === 'chan-1,chan-2,chan-empty'
    && cursors['chan-2'].lastMessageId === mB.id,
  JSON.stringify(cursors, null, 2),
);

// =====================================================================
//  2. 判断の反映
// =====================================================================
console.log('\n===== 2. 判断の反映（decision / notify / task_id 書き戻し） =====\n');

// ポータルが判断を書き込んだ体で書き換える
await patchScan(TODAY, (data) => {
  data.candidates[0].decision = 'task';
  data.candidates[0].notify = true;
  data.candidates[0].assignee_id = 'user-tanaka';
  data.candidates[0].decided_at = `${TODAY}T10:00:00+09:00`;
  data.candidates[1].decision = 'ignore';
  data.candidates[1].decided_at = `${TODAY}T10:00:05+09:00`;
});

stub.__sentMessages.length = 0;
const tick1 = await runScanTick(discordClient, NOW + 60_000);

const tasksAfter = await listTasks();
check(
  'decision:"task" の候補からタスクが作られる（/task と同じ採番）',
  tasksAfter.length === 1 && tasksAfter[0].number === 1 && tasksAfter[0].title === '修正版データの提出'
    && tasksAfter[0].channelId === 'chan-1' && tasksAfter[0].assigneeId === 'user-tanaka'
    && tasksAfter[0].due === '2026-10-15 23:59',
  JSON.stringify(tasksAfter.map((t) => ({ n: t.number, title: t.title, due: t.due, ch: t.channelId })), null, 2),
);
check(
  'notify:true なので公開通知が出る（登録時と同じ文面・担当者メンション）',
  stub.__sentMessages.length === 1
    && stub.__sentMessages[0].channelId === 'chan-1'
    && stub.__sentMessages[0].content.includes('<@user-tanaka> さんに『修正版データの提出』をお願いしました')
    && JSON.stringify(stub.__sentMessages[0].allowedMentions) === JSON.stringify({ parse: [], users: ['user-tanaka'] }),
  JSON.stringify(stub.__sentMessages, null, 2),
);

let current = JSON.parse(await fs.readFile(scanPath, 'utf-8'));
check(
  'task_id が書き戻される',
  current.candidates[0].task_id === tasksAfter[0].id,
  `task_id=${current.candidates[0].task_id}`,
);
check(
  'decision:"ignore" は何もしない（タスクも通知も作らない）',
  current.candidates[1].task_id === null && tasksAfter.length === 1,
);
check(
  'decision:"ignore" の候補は指紋として記録される（次回以降 再提案しない）',
  Object.keys(JSON.parse(await fs.readFile(path.join(stateDir, '.state', 'scan-ignored.json'), 'utf-8')).fingerprints).length === 1
    && tick1.decisions.ignored.length === 1,
  await fs.readFile(path.join(stateDir, '.state', 'scan-ignored.json'), 'utf-8'),
);

// --- 次のティックで二重に作らない ---
stub.__sentMessages.length = 0;
await runScanTick(discordClient, NOW + 120_000);
check(
  '次のティックでタスクが二重に作られない・通知も再送しない',
  (await listTasks()).length === 1 && stub.__sentMessages.length === 0,
  `tasks=${(await listTasks()).length} sent=${stub.__sentMessages.length}`,
);

// =====================================================================
//  3. 競合（ポータルが同時に書き換えた場合）
// =====================================================================
console.log('\n===== 3. ポータルとの競合検出 =====\n');

// --- 低レベル: 古いハッシュでの書き戻しは必ず弾かれる ---
const loaded = await readScanFile(TODAY);
await patchScan(TODAY, (data) => { data.candidates[1].notify = false; });
const stale = await writeScanFileIfUnchanged(TODAY, loaded.data, loaded.hash);
check(
  '読み込み後にファイルが変わっていたら書き戻しを拒否する（ハッシュ照合）',
  stale.ok === false && stale.reason === 'conflict',
  JSON.stringify(stale),
);
check(
  '拒否されたときファイルは一切書き換わっていない',
  JSON.parse(await fs.readFile(scanPath, 'utf-8')).candidates[1].notify === false,
);

// --- 実際の反映ループでの競合 ---
await patchScan(TODAY, (data) => {
  data.candidates[1].decision = 'task';
  data.candidates[1].notify = false;
  data.candidates[1].assignee_id = 'user-sato';
  data.candidates[1].task_id = null;
});

stub.__sentMessages.length = 0;
const conflicted = await runScanTick(discordClient, NOW + 180_000, {
  // タスク作成が終わって書き戻す直前に、ポータルが割り込んで書き換えた状況を再現する
  beforeWriteBack: async (date) => {
    await patchScan(date, (data) => { data.candidates[1].decided_at = `${TODAY}T11:00:00+09:00`; });
  },
});

check(
  'ポータルが同時に書き換えていたら書き戻しをスキップする',
  conflicted.decisions.conflicts.length === 1 && conflicted.decisions.conflicts[0].reason === 'conflict',
  JSON.stringify(conflicted.decisions.conflicts),
);
current = JSON.parse(await fs.readFile(scanPath, 'utf-8'));
const tasksAfterConflict = await listTasks();
check(
  '競合しても タスクは作成済み（台帳に記録済み）で、task_id はまだ null',
  tasksAfterConflict.length === 2 && current.candidates[1].task_id === null
    && current.candidates[1].decided_at === `${TODAY}T11:00:00+09:00`,
  `tasks=${tasksAfterConflict.length} task_id=${current.candidates[1].task_id}`,
);
check(
  'notify:false なので公開通知は出ない',
  stub.__sentMessages.length === 0,
  JSON.stringify(stub.__sentMessages),
);

// --- 次のティックで書き戻しだけやり直す（二重作成しない） ---
await runScanTick(discordClient, NOW + 240_000);
current = JSON.parse(await fs.readFile(scanPath, 'utf-8'));
check(
  '次のティックで書き戻しだけやり直され、タスクは増えない',
  (await listTasks()).length === 2
    && current.candidates[1].task_id === tasksAfterConflict.find((t) => t.number === 2).id,
  `tasks=${(await listTasks()).length} task_id=${current.candidates[1].task_id}`,
);

// =====================================================================
//  4. 2回目の走査（カーソル・重複・0件）
// =====================================================================
console.log('\n===== 4. 2回目の走査（同じ発言を二度渡さない / 候補0件ならDMなし） =====\n');

msg('chan-1', { text: '今日の追加発言です。特にタスクはありません。', author: 'Rei', authorId: OWNER, atMs: NOW + 5 * 60_000 });

nextResponse = (j) => okResult(j.jobId, []);
__resetScanning();
stub.__dms.length = 0;
const scan2 = await runScanTick(discordClient, NOW + 300_000, { forceScan: true });

const job2 = runner.jobs[1];
check(
  '2回目の走査ではカーソル以降の発言だけを渡す（同じ発言を二度Claudeに渡さない）',
  runner.jobs.length === 2
    && job2.quoted.length === 1
    && job2.quoted[0].text === '今日の追加発言です。特にタスクはありません。',
  `引用 ${job2.quoted.length} 件: ${job2.quoted.map((q) => q.text).join(' | ')}`,
);
const report2 = takeReports();
check(
  '候補が0件でも必ずレポートが飛ぶ（「候補 0件」と明記する）',
  scan2.scan.ok === true && scan2.scan.candidates.length === 0
    && report2.length === 1
    && /\n候補     0件（未判断）\n/.test(report2[0].content)
    && stub.__dms.length === 0,
  report2[0]?.content || '(レポートが飛んでいません)',
);
current = JSON.parse(await fs.readFile(scanPath, 'utf-8'));
check(
  '同じ日に走り直しても、判断済み・タスク化済みの候補を消さない',
  current.candidates.length === 2 && current.candidates.every((c) => c.task_id),
  JSON.stringify(current.candidates.map((c) => ({ id: c.id, decision: c.decision, task_id: c.task_id }))),
);

// --- 却下済み・既存タスクと重複する候補は出さない ---
msg('chan-2', { text: '佐藤さん、絵コンテのチェックを 2026-10-03 までにお願いします（再掲）。', author: 'Rei', authorId: OWNER, atMs: NOW + 6 * 60_000 });
msg('chan-1', { text: '田中さん、修正版データの提出の件、よろしくお願いします。', author: 'Rei', authorId: OWNER, atMs: NOW + 7 * 60_000 });

nextResponse = (j) => okResult(j.jobId, [
  {
    channel_id: 'chan-2',
    channel_name: '案件B',
    assignee_name: '佐藤',
    assignee_id: null,
    due: '2026-10-03',
    title: '絵コンテのチェック',
    evidence: {
      text: '佐藤さん、絵コンテのチェックを 2026-10-03 までにお願いします（再掲）。',
      author: 'Rei',
      posted_at: null,
      message_url: null,
    },
  },
  {
    channel_id: 'chan-1',
    channel_name: '案件A',
    assignee_name: '田中',
    assignee_id: null,
    due: null,
    title: '修正版データの提出',
    evidence: {
      text: '田中さん、修正版データの提出の件、よろしくお願いします。',
      author: 'Rei',
      posted_at: null,
      message_url: null,
    },
  },
]);
__resetScanning();
stub.__dms.length = 0;
const scan3 = await runScanTick(discordClient, NOW + 400_000, { forceScan: true });
check(
  '既存タスクと重複する候補は出さない',
  scan3.scan.stats.droppedDuplicate >= 1,
  JSON.stringify(scan3.scan.stats),
);
check(
  '一度 ignore された候補は再提案しない',
  scan3.scan.candidates.length === 0 && takeReports().length === 1 && stub.__dms.length === 0,
  `新しい候補=${scan3.scan.candidates.length} / droppedIgnored=${scan3.scan.stats.droppedIgnored} / droppedDuplicate=${scan3.scan.stats.droppedDuplicate}`,
);

// =====================================================================
//  5. 1日1回・失敗時の扱い
// =====================================================================
console.log('\n===== 5. 1日1回の実行と、失敗したときの通知 =====\n');

__resetScanning();
runner.jobs.length = 0;
const notDue = await runScanTick(discordClient, NOW + 500_000); // forceScan なし
check(
  '同じ日に2回目の自動走査は走らない（1日1ジョブ）',
  runner.jobs.length === 0 && !notDue.scan,
  JSON.stringify(Object.keys(notDue)),
);

// 翌日の9:00 → 走る。runner が失敗を返す
msg('chan-1', { text: '翌日の発言。これが走査のきっかけになる。', author: 'Rei', authorId: OWNER, atMs: NOW + 20 * HOUR });
nextResponse = (j) => errorResult(j.jobId, 'AUTH', 'claude のログインが切れています');
__resetScanning();
stub.__dms.length = 0;
const tomorrow = NOW + 24 * HOUR;
const failed = await runScanTick(discordClient, tomorrow);
check(
  '翌日の走査時刻を過ぎたら自動で走る',
  runner.jobs.length === 1,
  `jobs=${runner.jobs.length}`,
);
const reportFailed = takeReports();
check(
  '走査が失敗したら ❌ の見出しで pm チャンネルに理由を出す（DMは送らない）',
  failed.scan.ok === false
    && reportFailed.length === 1
    && reportFailed[0].channelId === 'chan-report'
    && reportFailed[0].content.startsWith('## ❌ 会話の走査に失敗しました\n```\n')
    && reportFailed[0].content.includes('理由     AUTH: claude のログインが切れています')
    && JSON.stringify(reportFailed[0].allowedMentions) === JSON.stringify({ parse: [], users: [] })
    && stub.__dms.length === 0,
  reportFailed[0]?.content || '(レポートが飛んでいません)',
);
const runState = JSON.parse(await fs.readFile(path.join(stateDir, '.state', 'scan-state.json'), 'utf-8'));
check(
  '失敗しても「その日はもう走らせた」と記録し、翌日に持ち越さない',
  runState.lastScanDate === jstDateString(tomorrow) && runState.lastStatus === 'failed',
  JSON.stringify(runState),
);

// --- 取得した人の発言が全部 空だった場合（= Intent無効の典型） ---
console.log('\n===== 6. 本文がすべて空だったとき =====\n');

// ⚠ 直前の走査は失敗しているので、そのぶんの発言はカーソルが進んでいない＝もう一度渡される。
//    まず成功する走査を1回挟んで、取り残しを解消してから「本文が空だけ」の状況を作る。
nextResponse = (j) => okResult(j.jobId, []);
runner.jobs.length = 0;
__resetScanning();
await runScanTick(discordClient, NOW + 26 * HOUR, { forceScan: true });
takeReports();
check(
  '失敗した走査ぶんの発言は、カーソルを進めていないので次回にもう一度渡される',
  runner.jobs.length === 1
    && runner.jobs[0].quoted.some((q) => q.text === '翌日の発言。これが走査のきっかけになる。'),
  `引用: ${runner.jobs[0]?.quoted.map((q) => q.text).join(' | ')}`,
);

msg('chan-2', { text: '', author: 'Rei', authorId: OWNER, atMs: NOW + 27 * HOUR });
msg('chan-2', { text: '', author: 'Rei', authorId: OWNER, atMs: NOW + 27 * HOUR + 1000 });
capturedWarnings.length = 0;
runner.jobs.length = 0;
__resetScanning();
stub.__dms.length = 0;
const emptyScan = await runScanTick(discordClient, NOW + 48 * HOUR, { forceScan: true });
check(
  '本文がすべて空なら「Intentが無効かもしれない」と強く警告する（黙って0件で終わらない）',
  capturedWarnings.some((w) => w.includes('★') && w.includes('MESSAGE CONTENT'))
    && emptyScan.scan.stats.contentLooksDisabled === true,
  capturedWarnings.join('\n') || '(警告が出ていません)',
);
const reportEmpty = takeReports();
check(
  '本文が空だけのときは runner にジョブを投げない（無駄なトークンを使わない）',
  runner.jobs.length === 0 && stub.__dms.length === 0,
  `jobs=${runner.jobs.length}`,
);
check(
  'ジョブを投げなかった日も「ジョブ 0本・候補 0件」でレポートは飛ぶ',
  reportEmpty.length === 1
    && /\n使用     Claude Haiku 4\.5 \/ ジョブ 0本\n/.test(reportEmpty[0].content)
    && /\n候補     0件（未判断）\n/.test(reportEmpty[0].content),
  reportEmpty[0]?.content || '(レポートが飛んでいません)',
);

// =====================================================================
//  7. 1チャンネルあたりの取得上限
// =====================================================================
console.log('\n===== 7. 取得上限（新しい方を優先し、カーソルは進める） =====\n');

stub.__addChannel({ id: 'chan-bulk', name: '大量投稿', parentId: 'cat-active' });
const BULK_AT = NOW + 60 * HOUR;
let newestBulk = null;
for (let i = 1; i <= 250; i += 1) {
  newestBulk = msg('chan-bulk', { text: `連投 ${String(i).padStart(3, '0')}`, author: 'Rei', authorId: OWNER, atMs: BULK_AT + i * 1000 });
}

nextResponse = (j) => okResult(j.jobId, []);
runner.jobs.length = 0;
__resetScanning();
const bulkScan = await runScanTick(discordClient, NOW + 72 * HOUR, { forceScan: true });
const bulkQuoted = runner.jobs[0].quoted.filter((q) => q.text.startsWith('連投'));
check(
  '1チャンネルあたり 200 件で打ち切る',
  bulkQuoted.length === 200,
  `取得 ${bulkQuoted.length} 件 / truncated=${JSON.stringify(bulkScan.scan.stats.truncatedChannels)}`,
);
check(
  '打ち切るときは新しい方を優先する（古い50件が落ちる）',
  bulkQuoted[0].text === '連投 051' && bulkQuoted[bulkQuoted.length - 1].text === '連投 250',
  `先頭=${bulkQuoted[0].text} / 末尾=${bulkQuoted[bulkQuoted.length - 1].text}`,
);
const bulkCursors = JSON.parse(await fs.readFile(path.join(stateDir, '.state', 'scan-cursor.json'), 'utf-8'));
check(
  '打ち切ってもカーソルは最新まで進む（次回に古い分を掘り返さない）',
  bulkCursors['chan-bulk'].lastMessageId === newestBulk.id,
  `cursor=${bulkCursors['chan-bulk'].lastMessageId} newest=${newestBulk.id}`,
);

runner.jobs.length = 0;
__resetScanning();
await runScanTick(discordClient, NOW + 73 * HOUR, { forceScan: true });
check(
  '次の走査では打ち切られた古い発言を渡し直さない',
  runner.jobs.length === 0 || runner.jobs[0].quoted.every((q) => !q.text.startsWith('連投')),
  `jobs=${runner.jobs.length}`,
);

// ---- 後始末 ---------------------------------------------------------

runner.stop();
stopReminderLoop();
console.warn = realWarn;

const leftoverInbox = await fs.readdir(path.join(queueDir, 'pm', 'inbox')).catch(() => []);
check('キューに書き込み途中の一時ファイルを残さない', leftoverInbox.length === 0, leftoverInbox.join(', '));

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n----- ${results.length - failedChecks.length}/${results.length} passed -----`);

if (!args.keep) await fs.rm(workDir, { recursive: true, force: true });
process.exit(failedChecks.length === 0 ? 0 : 1);

// ---- utils ----------------------------------------------------------

/** pm チャンネルに出た走査レポートを取り出す（取り出したぶんは消す） */
function takeReports() {
  const picked = stub.__sentMessages.filter((m) => m.channelId === 'chan-report');
  const rest = stub.__sentMessages.filter((m) => m.channelId !== 'chan-report');
  stub.__sentMessages.length = 0;
  stub.__sentMessages.push(...rest);
  return picked;
}

/** ポータルが scans/*.json を書き換えた状況を作る（Botのキューを通さず直接書く） */
async function patchScan(date, mutate) {
  const p = path.join(stateDir, 'scans', `${date}.json`);
  const data = JSON.parse(await fs.readFile(p, 'utf-8'));
  mutate(data);
  await fs.writeFile(p, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  return hashOf(`${JSON.stringify(data, null, 2)}\n`);
}

async function waitFor(fn, what, timeoutMs = 5000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 10); });
  }
}
