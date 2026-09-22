// 初回バックフィル（全期間走査・ジョブ分割・部分失敗）の検証ハーネス。
//
//   node --import ./test/loader.mjs ./test/scan-backfill.mjs --dir=<作業ディレクトリ>
//
// scan.mjs と同じく discord.js と claude-runner をスタブ化して、本体のコードを
// 1行も変えずに実際に動かす。実際のDiscordにもNASにも一切触らない。
//
// scan.mjs と分けているのは、config.js が環境変数を **起動時に1回だけ** 読むため。
// ここでは SCAN_FIRST_RUN_HOURS=0 / SCAN_MAX_MESSAGES_PER_JOB=5 / SCAN_RUN_ON_BOOT=1 を使う。

import { promises as fs } from 'fs';
import path from 'path';
import { startStubRunner, okResult, errorResult } from './stub/runner.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const workDir = path.resolve(args.dir || './test/.tmp-backfill');
const stateDir = path.join(workDir, 'data');
const queueDir = path.join(workDir, 'runner-queue');

const OWNER = 'owner-1';
const GUILD = 'guild-1';
const PER_JOB = 5;

process.env.DISCORD_TOKEN = 'stub-token';
process.env.GUILD_ID = GUILD;
process.env.OWNER_USER_ID = OWNER;
process.env.STATE_DIR = stateDir;
process.env.SCAN_ENABLED = '1';
// ★ 起動直後に走ることを確かめたいので、走査時刻はまず来ない時刻にしておく
process.env.SCAN_AT = '23:59';
process.env.SCAN_EXCLUDE_CHANNEL_IDS = '';
process.env.SCAN_NOTIFY_CHANNEL_IDS = '';
process.env.SCAN_FIRST_RUN_HOURS = '0';          // ★ 期間の制限なし＝最初から全部
process.env.SCAN_MAX_MESSAGES_PER_CHANNEL = '10'; // ★ 初回はこの上限が外れること
process.env.SCAN_MAX_MESSAGES_PER_JOB = String(PER_JOB);
process.env.SCAN_RUN_ON_BOOT = '1';               // ★ 起動直後に1回走る
process.env.RUNNER_QUEUE_DIR = queueDir;
process.env.SCAN_JOB_TIMEOUT_MS = '20000';
process.env.SCAN_JOB_POLL_INTERVAL_MS = '20';
process.env.SCAN_REPORT_CHANNEL_ID = 'chan-report';
process.env.PORTAL_PM_URL = 'https://me.niceworks.cc/pm';

await fs.rm(workDir, { recursive: true, force: true });
await fs.mkdir(path.join(stateDir, '.state'), { recursive: true });

// 「今日ぶんはもう走らせた」と記録しておく。
// → 時刻でもカレンダーでも走らないはずなのに走ったなら、それは SCAN_RUN_ON_BOOT の働き。
await fs.writeFile(
  path.join(stateDir, '.state', 'scan-state.json'),
  `${JSON.stringify({
    lastScanDate: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
    lastStatus: 'ok',
    lastError: null,
  }, null, 2)}\n`,
  'utf-8',
);

// ---- 検証結果の集計 -------------------------------------------------

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
}

// ---- スタブの用意（Botを起動する前に済ませる） ----------------------

const stub = await import('./stub/discord.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

function snowflake(ms) {
  return ((BigInt(Math.floor(ms)) - 1420070400000n) << 22n).toString();
}

let msgSeq = 0;
function msg(channelId, text, atMs) {
  msgSeq += 1;
  const ms = atMs + msgSeq;
  const m = {
    id: snowflake(ms),
    content: text,
    createdTimestamp: ms,
    author: { id: OWNER, username: 'Rei', globalName: 'Rei', bot: false },
    member: { displayName: 'Rei' },
  };
  stub.__addMessage(channelId, m);
  return m;
}

stub.__channels.clear();
stub.__addChannel({ id: 'cat-active', name: '進行中', type: stub.ChannelType.GuildCategory });
stub.__addChannel({ id: 'cat-archive', name: 'archive', type: stub.ChannelType.GuildCategory });
stub.__addChannel({ id: 'chan-a', name: '案件A', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-b', name: '案件B', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-c', name: '案件C', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-d', name: '大量投稿', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-old', name: '終了案件', parentId: 'cat-archive' });
stub.__addChannel({ id: 'chan-report', name: 'pm', parentId: 'cat-active' });

// 500時間前（≒3週間前）の発言。24時間の制限があれば絶対に読まれない
const ANCIENT = 'ずっと昔の発言。全期間走査なら読まれるはず';
msg('chan-a', ANCIENT, NOW - 500 * HOUR);
for (let i = 2; i <= 6; i += 1) msg('chan-a', `A-${i}`, NOW - (200 - i) * HOUR);
for (let i = 1; i <= 4; i += 1) msg('chan-b', `B-${i}`, NOW - (100 - i) * HOUR);
for (let i = 1; i <= 3; i += 1) msg('chan-c', `C-${i}`, NOW - (50 - i) * HOUR);
// 1チャンネルの取得上限(10)より多い。初回バックフィルでは全部読まれるはず
for (let i = 1; i <= 25; i += 1) msg('chan-d', `D-${String(i).padStart(2, '0')}`, NOW - (40 * HOUR) + i * 1000);
msg('chan-old', 'archive カテゴリ配下。読まれてはいけない', NOW - 300 * HOUR);
msg('chan-report', '走査レポートの投稿先。読まれてはいけない', NOW - 10 * HOUR);

const TOTAL_ITEMS = 6 + 4 + 3 + 25; // 38
const TOTAL_JOBS = Math.ceil(TOTAL_ITEMS / PER_JOB); // 8

// ---- スタブ runner（Botより先に動かしておく） -----------------------

let jobSeq = 0;
let failAtJob = 0;      // この本数目のジョブを失敗させる（0なら失敗しない）
let phaseLabel = 'p1';

const runner = startStubRunner(queueDir, {
  respond: async (job) => {
    jobSeq += 1;
    if (failAtJob && jobSeq === failAtJob) {
      return errorResult(job.jobId, 'AUTH', 'claude のログインが切れています');
    }
    // 毎ジョブ1件ずつ候補を返す。根拠はそのジョブの引用の1件目（＝実在する発言）
    const first = job.quoted[0];
    return okResult(job.jobId, [{
      channel_id: null,
      channel_name: null,
      assignee_name: null,
      assignee_id: null,
      due: null,
      title: `候補 ${phaseLabel}-${jobSeq}`,
      evidence: {
        text: first.text, author: first.author, posted_at: null, message_url: null,
      },
    }]);
  },
});

// ---- Bot を起動（ここで起動直後の走査が走る） -----------------------

console.log('\n===== 1. SCAN_RUN_ON_BOOT=1: 起動直後に全期間バックフィルが走る =====\n');

await import('../src/index.js');
const { discordClient } = await import('../src/discord/client.js');
const { runScanTick, __resetScanning, __resetBootScan } = await import('../src/scan/tick.js');
const { stopReminderLoop } = await import('../src/reminders/tick.js');
const { jstDateString } = await import('../src/utils/datetime.js');

await waitFor(() => stub.__sentMessages.some((m) => m.channelId === 'chan-report'), '起動直後の走査レポート', 30000);
stopReminderLoop();

const TODAY = jstDateString(Date.now());
const scanPath = path.join(stateDir, 'scans', `${TODAY}.json`);
const boot = runner.jobs.slice();
const bootReport = takeReports();

check(
  'SCAN_RUN_ON_BOOT=1 なら、走査時刻(23:59)を待たず・「今日は実行済み」でも起動直後に走る',
  boot.length > 0,
  `jobs=${boot.length}`,
);

const bootQuotes = boot.flatMap((j) => j.quoted.map((q) => q.text));
check(
  'SCAN_FIRST_RUN_HOURS=0 なら期間の制限なし（500時間前の発言まで読む）',
  bootQuotes.includes(ANCIENT),
  `最古の引用: ${bootQuotes[0]}`,
);
check(
  '初回は1チャンネルの取得上限（10件）も外れる（25件すべて読む）',
  bootQuotes.filter((t) => t.startsWith('D-')).length === 25,
  `chan-d の引用 ${bootQuotes.filter((t) => t.startsWith('D-')).length} 件`,
);
check(
  'archive カテゴリとレポート投稿先は全期間走査でも除外される',
  !bootQuotes.some((t) => t.includes('archive カテゴリ配下'))
    && !bootQuotes.some((t) => t.includes('走査レポートの投稿先')),
  bootQuotes.filter((t) => t.includes('読まれてはいけない')).join(' | ') || '(除外できています)',
);
check(
  `発言 ${TOTAL_ITEMS} 件が 1ジョブ ${PER_JOB} 件ずつ ${TOTAL_JOBS} 本のジョブに分割される`,
  boot.length === TOTAL_JOBS
    && boot.slice(0, -1).every((j) => j.quoted.length === PER_JOB)
    && bootQuotes.length === TOTAL_ITEMS,
  `jobs=${boot.length} / 各ジョブの件数=${boot.map((j) => j.quoted.length).join(',')}`,
);
check(
  '分割したジョブは1本ずつ順番に投げる（runnerは直列実行なので重ねない）',
  boot.every((j, i) => i === 0 || j.createdAt >= boot[i - 1].createdAt)
    && new Set(boot.map((j) => j.jobId)).size === boot.length,
  boot.map((j) => `${j.jobId} (${j.quoted.length}件)`).join('\n'),
);
check(
  'ジョブごとの channels[] の quote_from / quote_to はそのジョブ内の番号になっている',
  boot.every((j) => {
    const first = j.input.channels[0];
    const last = j.input.channels[j.input.channels.length - 1];
    return first.quote_from === 1 && last.quote_to === j.quoted.length;
  }),
  JSON.stringify(boot.map((j) => j.input.channels), null, 2).slice(0, 600),
);

const bootJson = JSON.parse(await fs.readFile(scanPath, 'utf-8'));
check(
  `ジョブをまたいだ候補が1つの scans/${TODAY}.json にマージされる`,
  bootJson.candidates.length === TOTAL_JOBS
    && bootJson.candidates.every((c, i) => c.title === `候補 p1-${i + 1}`)
    && new Set(bootJson.candidates.map((c) => c.id)).size === TOTAL_JOBS,
  bootJson.candidates.map((c) => `${c.id} ${c.title} (#${c.channel_name})`).join('\n'),
);
check(
  'マージしてもチャンネル名・発言URLは発言ごとに正しく付く（ジョブ番号に引きずられない）',
  bootJson.candidates.some((c) => c.channel_name === '案件A')
    && bootJson.candidates.some((c) => c.channel_name === '大量投稿')
    && bootJson.candidates.every((c) => /^https:\/\/discord\.com\/channels\/guild-1\/chan-[abcd]\/\d+$/.test(c.evidence.message_url)),
  bootJson.candidates.map((c) => `${c.channel_name} ${c.evidence.message_url}`).join('\n'),
);
check(
  'バックフィルのレポートも pm チャンネルに1通だけ（DMは送らない・ジョブ本数を書く）',
  bootReport.length === 1
    && bootReport[0].channelId === 'chan-report'
    && stub.__dms.length === 0
    && new RegExp(`\\n使用     Claude Haiku 4\\.5 / ジョブ ${TOTAL_JOBS}本\\n`).test(bootReport[0].content)
    && new RegExp(`\\n対象     4チャンネル / 発言 ${TOTAL_ITEMS}件\\n`).test(bootReport[0].content)
    && bootReport[0].content.includes(`候補     ${TOTAL_JOBS}件（未判断）`)
    && bootReport[0].content.includes('https://me.niceworks.cc/pm/scans'),
  bootReport[0].content,
);

// =====================================================================
//  2. 起動直後の走査は1回だけ
// =====================================================================
console.log('\n===== 2. 起動直後の走査は1回きり（以後は通常どおり1日1回） =====\n');

runner.jobs.length = 0;
__resetScanning();
const second = await runScanTick(discordClient, Date.now()); // forceScan なし
check(
  'SCAN_RUN_ON_BOOT の走査は1回だけ。次のティックでは走らない',
  runner.jobs.length === 0 && !second.scan && takeReports().length === 0,
  `jobs=${runner.jobs.length}`,
);

// =====================================================================
//  3. 2回目以降はカーソル以降だけ
// =====================================================================
console.log('\n===== 3. 2回目以降はカーソル以降だけ（全期間を掘り返さない） =====\n');

phaseLabel = 'p3';
jobSeq = 0;
runner.jobs.length = 0;
msg('chan-a', '2回目の走査で初めて読まれる発言', Date.now());
__resetScanning();
const scan2 = await runScanTick(discordClient, Date.now(), { forceScan: true });
takeReports();
check(
  '2回目の走査はカーソル以降の1件だけ（全期間を読み直さない・ジョブも1本）',
  runner.jobs.length === 1
    && scan2.scan.stats.quoted === 1
    && runner.jobs[0].quoted[0].text === '2回目の走査で初めて読まれる発言',
  `jobs=${runner.jobs.length} quoted=${scan2.scan.stats.quoted}`,
);

// =====================================================================
//  4. 分割の途中で失敗したとき
// =====================================================================
console.log('\n===== 4. 分割の途中で失敗 → そこまでを保存し、カーソルは成功分だけ進める =====\n');

const cursorsBefore = await readCursors();

phaseLabel = 'p4';
jobSeq = 0;
runner.jobs.length = 0;
failAtJob = 2; // 2本目のジョブで失敗させる

// chan-a に5件・chan-b に5件・chan-c に3件 → ちょうど [a×5] [b×5] [c×3] の3ジョブになる
const lastA = [];
for (let i = 1; i <= 5; i += 1) lastA.push(msg('chan-a', `A2-${i}`, Date.now() + i * 1000));
for (let i = 1; i <= 5; i += 1) msg('chan-b', `B2-${i}`, Date.now() + 10_000 + i * 1000);
for (let i = 1; i <= 3; i += 1) msg('chan-c', `C2-${i}`, Date.now() + 20_000 + i * 1000);

__resetScanning();
const partial = await runScanTick(discordClient, Date.now(), { forceScan: true });
const partialReport = takeReports();

check(
  '2本目で失敗したら、そこで打ち切る（3本目は投げない＝無駄なトークンを使わない）',
  runner.jobs.length === 2 && partial.scan.ok === false,
  `jobs=${runner.jobs.length} ok=${partial.scan.ok} error=${partial.scan.error}`,
);
check(
  '失敗しても、成功した1本目ぶんの候補は保存される（全部やり直しにならない）',
  partial.scan.candidates.length === 1
    && JSON.parse(await fs.readFile(scanPath, 'utf-8')).candidates.some((c) => c.title === '候補 p4-1'),
  JSON.parse(await fs.readFile(scanPath, 'utf-8')).candidates.map((c) => c.title).join(', '),
);

const cursorsAfter = await readCursors();
check(
  'カーソルは成功したジョブに入っていたチャンネル（chan-a）だけ進む',
  cursorsAfter['chan-a'].lastMessageId === lastA[lastA.length - 1].id
    && cursorsAfter['chan-a'].lastMessageId !== cursorsBefore['chan-a'].lastMessageId,
  `before=${cursorsBefore['chan-a'].lastMessageId} after=${cursorsAfter['chan-a'].lastMessageId}`,
);
check(
  '失敗したジョブに入っていたチャンネル（chan-b / chan-c）のカーソルは進めない',
  cursorsAfter['chan-b'].lastMessageId === cursorsBefore['chan-b'].lastMessageId
    && cursorsAfter['chan-c'].lastMessageId === cursorsBefore['chan-c'].lastMessageId,
  `b: ${cursorsBefore['chan-b'].lastMessageId} → ${cursorsAfter['chan-b'].lastMessageId}`
  + `\nc: ${cursorsBefore['chan-c'].lastMessageId} → ${cursorsAfter['chan-c'].lastMessageId}`,
);
check(
  '失敗したときは ❌ の見出しで理由とここまでの候補数を出す（メンションなし）',
  partialReport.length === 1
    && partialReport[0].content.startsWith('## ❌ 会話の走査に失敗しました\n```\n')
    && partialReport[0].content.includes('2/3 ジョブ目で失敗')
    && partialReport[0].content.includes('AUTH: claude のログインが切れています')
    && partialReport[0].content.includes('候補     1件（ここまでの分は保存しました）')
    && JSON.stringify(partialReport[0].allowedMentions) === JSON.stringify({ parse: [], users: [] })
    && stub.__dms.length === 0,
  partialReport[0].content,
);

// =====================================================================
//  5. やり直したとき
// =====================================================================
console.log('\n===== 5. 次の走査で、渡せていなかった分だけをやり直す =====\n');

phaseLabel = 'p5';
jobSeq = 0;
failAtJob = 0;
runner.jobs.length = 0;
__resetScanning();
const retry = await runScanTick(discordClient, Date.now(), { forceScan: true });
takeReports();

const retryQuotes = runner.jobs.flatMap((j) => j.quoted.map((q) => q.text));
check(
  '成功済みの chan-a は渡し直さない／未処理の chan-b・chan-c はもう一度渡す',
  !retryQuotes.some((t) => t.startsWith('A2-'))
    && retryQuotes.filter((t) => t.startsWith('B2-')).length === 5
    && retryQuotes.filter((t) => t.startsWith('C2-')).length === 3,
  `引用: ${retryQuotes.join(', ')}`,
);
check(
  'やり直しも上限どおりに分割される（8件 → 2ジョブ）',
  runner.jobs.length === 2 && retry.scan.ok === true,
  `jobs=${runner.jobs.length}`,
);

// ---- 後始末 ---------------------------------------------------------

runner.stop();
stopReminderLoop();
__resetBootScan(false);

const leftoverInbox = await fs.readdir(path.join(queueDir, 'pm', 'inbox')).catch(() => []);
check('キューに書き込み途中の一時ファイルを残さない', leftoverInbox.length === 0, leftoverInbox.join(', '));

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n----- ${results.length - failedChecks.length}/${results.length} passed -----`);

if (!args.keep) await fs.rm(workDir, { recursive: true, force: true });
process.exit(failedChecks.length === 0 ? 0 : 1);

// ---- utils ----------------------------------------------------------

function takeReports() {
  const picked = stub.__sentMessages.filter((m) => m.channelId === 'chan-report');
  const rest = stub.__sentMessages.filter((m) => m.channelId !== 'chan-report');
  stub.__sentMessages.length = 0;
  stub.__sentMessages.push(...rest);
  return picked;
}

async function readCursors() {
  return JSON.parse(await fs.readFile(path.join(stateDir, '.state', 'scan-cursor.json'), 'utf-8'));
}

async function waitFor(fn, what, timeoutMs = 5000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 20); });
  }
}
