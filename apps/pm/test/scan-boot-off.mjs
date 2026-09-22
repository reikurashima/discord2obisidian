// SCAN_RUN_ON_BOOT が既定（0）なら、起動直後に走査しないことの確認。
//
//   node --import ./test/loader.mjs ./test/scan-boot-off.mjs --dir=<作業ディレクトリ>
//
// config.js は環境変数を起動時に1回だけ読むので、0 のときの確認は別プロセスで行う。

import { promises as fs } from 'fs';
import path from 'path';
import { startStubRunner, okResult } from './stub/runner.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const workDir = path.resolve(args.dir || './test/.tmp-boot-off');
const stateDir = path.join(workDir, 'data');
const queueDir = path.join(workDir, 'runner-queue');

process.env.DISCORD_TOKEN = 'stub-token';
process.env.GUILD_ID = 'guild-1';
process.env.OWNER_USER_ID = 'owner-1';
process.env.STATE_DIR = stateDir;
process.env.SCAN_ENABLED = '1';
process.env.SCAN_AT = '23:59';       // 実行中に来ない時刻
process.env.SCAN_FIRST_RUN_HOURS = '0';
process.env.SCAN_RUN_ON_BOOT = '0';  // ★ ここが本題
process.env.RUNNER_QUEUE_DIR = queueDir;
process.env.SCAN_JOB_POLL_INTERVAL_MS = '20';
process.env.SCAN_REPORT_CHANNEL_ID = 'chan-report';

await fs.rm(workDir, { recursive: true, force: true });
await fs.mkdir(stateDir, { recursive: true });

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

const stub = await import('./stub/discord.js');
stub.__channels.clear();
stub.__addChannel({ id: 'cat-active', name: '進行中', type: stub.ChannelType.GuildCategory });
stub.__addChannel({ id: 'chan-a', name: '案件A', parentId: 'cat-active' });
stub.__addChannel({ id: 'chan-report', name: 'pm', parentId: 'cat-active' });
stub.__addMessage('chan-a', {
  id: ((BigInt(Date.now()) - 1420070400000n) << 22n).toString(),
  content: '走ってしまったら読まれるはずの発言',
  createdTimestamp: Date.now(),
  author: { id: 'owner-1', username: 'Rei', globalName: 'Rei', bot: false },
  member: { displayName: 'Rei' },
});

const runner = startStubRunner(queueDir, { respond: async (job) => okResult(job.jobId, []) });

await import('../src/index.js');
const { discordClient } = await import('../src/discord/client.js');
const { stopReminderLoop } = await import('../src/reminders/tick.js');

await waitFor(() => discordClient.user, 'login');
// 起動直後のティックが走り切るだけの余裕を置く（走るならこの間にジョブが出る）
await new Promise((r) => { setTimeout(r, 800); });
stopReminderLoop();

check(
  'SCAN_RUN_ON_BOOT=0（既定）なら起動直後に走査しない',
  runner.jobs.length === 0 && !stub.__sentMessages.some((m) => m.channelId === 'chan-report'),
  `jobs=${runner.jobs.length} reports=${stub.__sentMessages.filter((m) => m.channelId === 'chan-report').length}`,
);
check(
  '走査結果のファイルも作られない',
  (await fs.readdir(path.join(stateDir, 'scans')).catch(() => [])).length === 0,
);

runner.stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n----- ${results.length - failed.length}/${results.length} passed -----`);
if (!args.keep) await fs.rm(workDir, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);

async function waitFor(fn, what, timeoutMs = 5000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 20); });
  }
}
