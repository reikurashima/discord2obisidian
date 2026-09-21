/**
 * 実接続なしの状態遷移テスト。
 *   node test/scenarios.js
 *
 * 25分/5分のまま回すと待てないので、FakeClock で時間を進める。
 * 分数はテスト側で短く差し替えている（本体のロジックは同じ）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

import { FakeClock, StubGateway, createLogger } from './stubs.js';
import { MuteRegistry } from '../src/pomodoro/muteRegistry.js';
import { PhaseDisplay } from '../src/pomodoro/display.js';
import { PomodoroManager } from '../src/pomodoro/manager.js';
import { CallScheduler } from '../src/call/scheduler.js';
import { parseEndTime, unixSeconds, relativeTag, formatLocal } from '../src/utils/time.js';

const VC = 'vc-pomodoro';
const WORK_MS = 25 * 60 * 1000;
const BREAK_MS = 5 * 60 * 1000;

let failures = 0;
let stateDir;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  OK   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildHarness({ clock, statePath, logger }) {
  const gateway = new StubGateway({ vcChannelId: VC });
  const registry = new MuteRegistry(statePath, logger);
  const display = new PhaseDisplay({
    gateway, vcChannelId: VC, labels: { work: '🍅作業中', break: '☕休憩中' }, logger,
  });
  const pomodoro = new PomodoroManager({
    gateway, registry, display, logger,
    vcChannelId: VC, workMs: WORK_MS, breakMs: BREAK_MS,
    timers: clock.timerApi, now: clock.now,
  });
  return { gateway, registry, display, pomodoro };
}

/** VCへの入室イベント（スタブの在室者も動かす） */
async function join(h, userId) {
  h.gateway.join(userId);
  await h.pomodoro.handleVoiceStateUpdate({ userId, oldChannelId: null, newChannelId: VC });
}

async function leave(h, userId) {
  h.gateway.leave(userId);
  await h.pomodoro.handleVoiceStateUpdate({ userId, oldChannelId: VC, newChannelId: null });
}

// ---------------------------------------------------------------------------

async function scenarioBasicCycle() {
  section('1. 1人入室 → 開始 → 作業→休憩→作業');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const statePath = path.join(stateDir, 'basic.json');
  const h = buildHarness({ clock, statePath, logger });

  await join(h, 'alice');
  check('入室で作業フェーズが始まる', h.pomodoro.phase === 'work', `phase=${h.pomodoro.phase}`);
  check('aliceがサーバーミュートされる', h.gateway.serverMuted.has('alice'));
  check('告知に <t:...:R> が入っている', /<t:\d+:R>/.test(h.gateway.announcements[0]));
  console.log(`    告知: ${h.gateway.announcements[0].replace(/\n/g, ' / ')}`);

  await clock.advance(WORK_MS);
  check('25分後に休憩へ', h.pomodoro.phase === 'break', `phase=${h.pomodoro.phase}`);
  check('休憩でミュート解除', h.gateway.serverMuted.size === 0, `muted=${[...h.gateway.serverMuted]}`);
  check('台帳も空になる', h.registry.size === 0);
  console.log(`    告知: ${h.gateway.announcements[1].replace(/\n/g, ' / ')}`);

  await clock.advance(BREAK_MS);
  check('5分後に作業へ戻る', h.pomodoro.phase === 'work', `phase=${h.pomodoro.phase}`);
  check('再びミュートされる', h.gateway.serverMuted.has('alice'));
  check('2セット目になっている', h.pomodoro.cycle === 2, `cycle=${h.pomodoro.cycle}`);
  console.log(`    VCステータス履歴: ${JSON.stringify(h.gateway.voiceStatuses)}`);
}

async function scenarioLateJoiner() {
  section('2. 作業中に2人目が入室 → 即ミュート');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'late.json'), logger });

  await join(h, 'alice');
  await clock.advance(10 * 60 * 1000); // 作業中の途中
  await join(h, 'bob');

  check('フェーズは作業のまま', h.pomodoro.phase === 'work');
  check('bobが即ミュートされる', h.gateway.serverMuted.has('bob'));
  check('台帳に2人', h.registry.size === 2, `entries=${h.registry.list()}`);
}

async function scenarioLeaverUnmuted() {
  section('3. 作業中に1人退出 → その人のミュートが解除される');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'leave.json'), logger });

  await join(h, 'alice');
  await join(h, 'bob');
  check('2人ともミュート', h.gateway.serverMuted.size === 2);

  await leave(h, 'bob');
  check('bobのミュートが解除される', !h.gateway.serverMuted.has('bob'));
  check('aliceはミュートのまま', h.gateway.serverMuted.has('alice'));
  check('台帳からbobが消える', !h.registry.has('bob') && h.registry.has('alice'));
  check('ポモドーロは続行', h.pomodoro.phase === 'work');
}

async function scenarioEmptyVc() {
  section('4. 全員退出 → 終了して全解除');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const statePath = path.join(stateDir, 'empty.json');
  const h = buildHarness({ clock, statePath, logger });

  await join(h, 'alice');
  await join(h, 'bob');
  await leave(h, 'alice');
  await leave(h, 'bob');

  check('idleに戻る', h.pomodoro.phase === 'idle', `phase=${h.pomodoro.phase}`);
  check('誰もミュートされていない', h.gateway.serverMuted.size === 0);
  check('台帳が空', h.registry.size === 0);
  check('終了の告知が出る', h.gateway.announcements.some((m) => m.includes('終了しました')));

  // 次のフェーズタイマーが残っていないこと（空のVCで勝手に再開しない）
  await clock.advance(WORK_MS * 2);
  check('空のまま時間が経っても再開しない', h.pomodoro.phase === 'idle');
  console.log(`    最後の告知: ${h.gateway.announcements.at(-1).replace(/\n/g, ' / ')}`);
}

async function scenarioCrashRecovery() {
  section('5. プロセスを落として再起動 → 記録に残っていた人が解除される');
  const statePath = path.join(stateDir, 'crash.json');
  const clock1 = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger1 = createLogger();
  const h1 = buildHarness({ clock: clock1, statePath, logger: logger1 });

  await join(h1, 'alice');
  await join(h1, 'bob');
  check('作業中で2人ミュート', h1.gateway.serverMuted.size === 2);

  // ここで「プロセスが落ちた」。ミュートは解除されないままディスクに記録だけ残る
  const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  check('台帳がディスクに残っている', onDisk.muted.length === 2,
    `muted=${onDisk.muted.map((m) => m.userId).join(',')}`);
  console.log(`    ${statePath}: ${JSON.stringify(onDisk.muted.map((m) => m.userId))}`);

  // --- 再起動 ---
  const clock2 = new FakeClock(Date.parse('2026-09-22T20:30:00+09:00'));
  const logger2 = createLogger();
  const h2 = buildHarness({ clock: clock2, statePath, logger: logger2 });
  // 新プロセスから見ても、2人はまだサーバーミュートされている状態を引き継ぐ
  h2.gateway.serverMuted = h1.gateway.serverMuted;

  await h2.pomodoro.recoverOnStartup();
  check('起動時に全員解除される', h2.gateway.serverMuted.size === 0, `muted=${[...h2.gateway.serverMuted]}`);
  check('台帳も空になる', h2.registry.size === 0);
  console.log(`    ${logger2.lines.filter((l) => l.includes('前回')).join(' / ')}`);
}

async function scenarioSigterm() {
  section('6. SIGTERM → 全解除してから終了');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'sigterm.json'), logger });

  await join(h, 'alice');
  await join(h, 'bob');
  await h.pomodoro.shutdownUnmuteAll();

  check('全員解除済み', h.gateway.serverMuted.size === 0);
  check('台帳が空', h.registry.size === 0);
  check('タイマーが残っていない', h.pomodoro.timer === null);
  console.log(`    ${logger.lines.filter((l) => l.includes('終了処理')).join(' / ')}`);
}

async function scenarioUnmuteFailure() {
  section('7. 解除に失敗したら告知が出る（黙って失敗しない）');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'fail.json'), logger });

  await join(h, 'alice');
  h.gateway.failUnmuteFor.add('alice');

  const pending = h.pomodoro.shutdownUnmuteAll();
  await clock.advance(10 * 1000); // リトライ待ちを進める
  await pending;

  check('解除失敗が告知される', h.gateway.announcements.some((m) => m.includes('ミュート解除に失敗')));
  check('台帳に残す（次回起動で再挑戦）', h.registry.has('alice'));
  check('ERRORログが出ている', logger.lines.some((l) => l.startsWith('[ERROR]')));
  console.log(`    告知: ${h.gateway.announcements.at(-1).replace(/\n/g, ' / ')}`);
}

async function scenarioDisplayFallback() {
  section('8. VCステータス失敗 → VC名変更にフォールバック / レート制限でも落ちない');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'display.json'), logger });
  h.gateway.failVoiceStatus = true;

  await join(h, 'alice');
  check('VC名が 🍅作業中 に変わる', h.gateway.renames.at(-1) === '🍅作業中', `renames=${JSON.stringify(h.gateway.renames)}`);
  check('ステータスAPIの警告は1回だけ', h.gateway.voiceStatusWarnCount === 1);

  await clock.advance(WORK_MS);
  check('休憩で ☕休憩中 に変わる', h.gateway.renames.at(-1) === '☕休憩中', `renames=${JSON.stringify(h.gateway.renames)}`);
  check('ステータスAPIは再試行しない', h.gateway.voiceStatusWarnCount === 1);

  // ここからレート制限を再現
  h.gateway.failRename = true;
  let threw = false;
  try {
    await clock.advance(BREAK_MS);
  } catch {
    threw = true;
  }
  check('改名がレート制限でも例外で落ちない', !threw);
  check('作業フェーズには正常に進む', h.pomodoro.phase === 'work', `phase=${h.pomodoro.phase}`);
  check('ミュートは通常どおり効く', h.gateway.serverMuted.has('alice'));
  console.log(`    改名履歴: ${JSON.stringify(h.gateway.renames)}`);
}

async function scenarioCallEndAt() {
  section('9. /call end-at の予約・告知・切断');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const gateway = new StubGateway({ vcChannelId: 'vc-talk' });
  gateway.join('alice');
  gateway.join('bob');

  const scheduler = new CallScheduler({ gateway, logger, timers: clock.timerApi, now: clock.now });
  const parsed = parseEndTime('23:00', clock.now());
  check('23:00 を解釈できる', parsed.ok && formatLocal(parsed.at).endsWith('23:00'), formatLocal(parsed.at));

  const result = scheduler.schedule({ channelId: 'vc-talk', endsAt: parsed.at, requestedBy: 'owner' });
  check('予約できる', result.ok);

  await clock.advance(3 * 60 * 60 * 1000 - 5 * 60 * 1000); // 20:00 → 22:55
  check('5分前告知', gateway.announcements.some((m) => m.includes('あと5分')), gateway.announcements.at(-1));

  await clock.advance(4 * 60 * 1000); // 22:59
  check('1分前告知', gateway.announcements.some((m) => m.includes('あと1分')), gateway.announcements.at(-1));

  await clock.advance(60 * 1000); // 23:00
  check('全員切断される', gateway.disconnected.length === 2, `disconnected=${gateway.disconnected}`);
  check('終了告知が出る', gateway.announcements.at(-1).includes('通話を終了しました'));
  console.log(`    ${gateway.announcements.map((m) => m.split('\n')[0]).join(' | ')}`);

  // cancel
  const scheduler2 = new CallScheduler({ gateway, logger, timers: clock.timerApi, now: clock.now });
  scheduler2.schedule({ channelId: 'vc-talk', endsAt: clock.now() + 30 * 60 * 1000, requestedBy: 'owner' });
  check('cancelで予約が消える', scheduler2.cancel() === true && scheduler2.reservation === null);
  const before = gateway.disconnected.length;
  await clock.advance(60 * 60 * 1000);
  check('取り消し後は切断されない', gateway.disconnected.length === before);
}

function scenarioTimeParsing() {
  section('10. 時刻パースと <t:...:R> のUNIX秒検算（JST）');
  const base = Date.parse('2026-09-22T20:00:00+09:00');
  console.log(`    基準時刻: ${formatLocal(base)} (epoch ${base}) / TZ=${process.env.TZ ?? '(未設定)'}`);

  const rel = parseEndTime('+90m', base);
  check('+90m は 21:30', rel.ok && rel.at === base + 90 * 60 * 1000, formatLocal(rel.at));

  const relH = parseEndTime('+1h30m', base);
  check('+1h30m も 21:30', relH.ok && relH.at === rel.at, formatLocal(relH.at));

  const past = parseEndTime('19:00', base);
  check('過ぎた時刻は翌日になる', past.ok && past.at === base - 60 * 60 * 1000 + 24 * 60 * 60 * 1000,
    formatLocal(past.at));

  const bad = parseEndTime('あとで', base);
  check('不正な入力は弾く', !bad.ok, bad.reason);

  // UNIX秒の検算: 2026-09-22 23:00 JST = 2026-09-22 14:00 UTC = 1789048800
  const at2300 = parseEndTime('23:00', base);
  const expected = Math.floor(Date.parse('2026-09-22T23:00:00+09:00') / 1000);
  check('23:00 JST の UNIX秒が一致', unixSeconds(at2300.at) === expected,
    `${unixSeconds(at2300.at)} === ${expected} (= ${new Date(expected * 1000).toISOString()})`);
  check('タグの形が正しい', relativeTag(at2300.at) === `<t:${expected}:R>`, relativeTag(at2300.at));
  // ミリ秒をそのまま入れる事故の検出（桁が3つ増えると西暦5万年台になる）
  check('秒であってミリ秒ではない', String(unixSeconds(at2300.at)).length === 10);
}

function scenarioStatusText() {
  section('11. /pomo status の文面');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'status.json'), logger });
  console.log(`    停止中: ${h.pomodoro.statusText().replace(/\n/g, ' / ')}`);
  assert.ok(h.pomodoro.statusText().includes('停止中'));
  return join(h, 'alice').then(() => {
    const text = h.pomodoro.statusText();
    console.log(`    作業中: ${text.replace(/\n/g, ' / ')}`);
    check('残り時間がタイムスタンプ記法', /<t:\d{10}:R>/.test(text));
  });
}

// ---------------------------------------------------------------------------

async function main() {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niceworker-test-'));
  console.log(`state dir: ${stateDir}`);

  try {
    await scenarioBasicCycle();
    await scenarioLateJoiner();
    await scenarioLeaverUnmuted();
    await scenarioEmptyVc();
    await scenarioCrashRecovery();
    await scenarioSigterm();
    await scenarioUnmuteFailure();
    await scenarioDisplayFallback();
    await scenarioCallEndAt();
    scenarioTimeParsing();
    await scenarioStatusText();
  } finally {
    // 後始末: 一時ディレクトリを消す
    fs.rmSync(stateDir, { recursive: true, force: true });
    console.log(`\ncleaned up: ${stateDir} (exists=${fs.existsSync(stateDir)})`);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
