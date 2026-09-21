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

/** VCへの入室イベント（スタブの接続状態も動かす） */
async function join(h, userId, channelId = VC) {
  const from = h.gateway.connections.get(userId) ?? null;
  h.gateway.join(userId, channelId);
  await h.pomodoro.handleVoiceStateUpdate({ userId, oldChannelId: from, newChannelId: channelId });
}

/** VCから完全に切断する（以後この人への setMute は 40032 になる） */
async function leave(h, userId) {
  const from = h.gateway.connections.get(userId) ?? null;
  h.gateway.leave(userId);
  await h.pomodoro.handleVoiceStateUpdate({ userId, oldChannelId: from, newChannelId: null });
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
  check('仕様の注意書きが1行入っている',
    h.gateway.announcements[0].includes('作業中に抜けるとミュートが残ります')
    && h.gateway.announcements[0].includes('次にVCに入ると自動で解除されます'));
  console.log(`    告知: ${h.gateway.announcements[0].replace(/\n/g, ' / ')}`);

  await clock.advance(WORK_MS);
  check('25分後に休憩へ', h.pomodoro.phase === 'break', `phase=${h.pomodoro.phase}`);
  check('休憩でミュート解除', h.gateway.serverMuted.size === 0, `muted=${[...h.gateway.serverMuted]}`);
  check('台帳も空になる', h.registry.size === 0);
  check('休憩の解除が「成功」としてログに出る',
    logger.lines.some((l) => l.includes('解除成功: alice') && l.includes('休憩開始')));
  check('休憩の解除結果の内訳が出る',
    logger.lines.some((l) => l.includes('休憩開始の解除結果') && l.includes('解除 1人')));
  console.log(`    ${logger.lines.filter((l) => l.includes('休憩開始')).join('\n    ')}`);

  // ⚠ 今回の変更点: フェーズが変わっても新規投稿は増えず、同じ1本が編集される
  check('新規投稿は増えていない（1本のまま）', h.gateway.announcements.length === 1,
    `新規投稿=${h.gateway.announcements.length}件 / 編集=${h.gateway.edits.length}回`);
  check('編集で休憩の内容に差し替わる', h.gateway.liveTexts()[0].includes('☕ 休憩タイムです'));
  console.log(`    編集後の本文: ${h.gateway.liveTexts()[0].replace(/\n/g, ' / ')}`);

  await clock.advance(BREAK_MS);
  check('5分後に作業へ戻る', h.pomodoro.phase === 'work', `phase=${h.pomodoro.phase}`);
  check('再びミュートされる', h.gateway.serverMuted.has('alice'));
  check('2セット目になっている', h.pomodoro.cycle === 2, `cycle=${h.pomodoro.cycle}`);

  // 何サイクル回しても投稿が増えないこと（長時間やっても埋まらない）
  await clock.advance((WORK_MS + BREAK_MS) * 3);
  check('計5サイクル回しても新規投稿は1本のまま', h.gateway.announcements.length === 1,
    `新規投稿=${h.gateway.announcements.length}件 / 編集=${h.gateway.edits.length}回`);
  check('5セット目になっている', h.pomodoro.cycle === 5, `cycle=${h.pomodoro.cycle}`);
  console.log(`    チャットに見えるメッセージ: ${h.gateway.messages.size}本 / 編集 ${h.gateway.edits.length}回`);
  console.log(`    VCステータス履歴: ${JSON.stringify(h.gateway.voiceStatuses)}`);
}

async function scenarioEditFallback() {
  section('1-b. 告知の編集に失敗したら新規投稿へフォールバックする');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'edit.json'), logger });

  await join(h, 'alice');
  check('最初は新規投稿', h.gateway.announcements.length === 1);

  h.gateway.failEdit = true; // メッセージが消された・権限が変わった等を再現
  await clock.advance(WORK_MS);

  check('編集に失敗したら新規投稿に落ちる', h.gateway.announcements.length === 2,
    `新規投稿=${h.gateway.announcements.length}件`);
  check('フェーズ遷移は止まらない', h.pomodoro.phase === 'break', `phase=${h.pomodoro.phase}`);
  check('ミュート制御は通常どおり', h.gateway.serverMuted.size === 0);
  check('警告ログが出る', logger.lines.some((l) => l.includes('新規投稿に切り替えます')));
  console.log(`    ${logger.lines.find((l) => l.includes('新規投稿に切り替えます'))}`);

  // 復旧したら、また1本を編集し続ける
  h.gateway.failEdit = false;
  await clock.advance(BREAK_MS);
  check('復旧後はまた編集に戻る',
    h.gateway.announcements.length === 2 && h.gateway.edits.length >= 1,
    `新規投稿=${h.gateway.announcements.length}件 / 編集=${h.gateway.edits.length}回`);
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

async function scenarioLeaverPending() {
  section('3. 作業中に1人が完全に退出 → 40032 で解除できず「解除待ち」として台帳に残る');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'leave.json'), logger });

  await join(h, 'alice');
  await join(h, 'bob');
  check('2人ともミュート', h.gateway.serverMuted.size === 2);

  await leave(h, 'bob');
  check('bobはミュートされたまま（Discord仕様で解除不可）', h.gateway.serverMuted.has('bob'));
  check('⚠ 台帳から消えない', h.registry.has('bob'));
  check('bobが解除待ちになる', h.registry.isPending('bob'), `pending=${h.registry.pendingList()}`);
  check('aliceは解除待ちではない', !h.registry.isPending('alice'));
  check('ポモドーロは続行', h.pomodoro.phase === 'work');
  check('40032のログが結果を明示している',
    logger.lines.some((l) => l.includes('解除できませんでした: bob') && l.includes('40032')));
  // 通知が冗長になるため、解除待ちの告知は出さない（ログと /pomo status に残す方針）
  check('「ミュートが残っています」の告知は出さない',
    !h.gateway.announcements.some((m) => m.includes('ミュートが残っています'))
    && !h.gateway.liveTexts().some((m) => m.includes('ミュートが残っています')));
  check('退出しても告知は増えない（1本のまま）', h.gateway.announcements.length === 1,
    `新規投稿=${h.gateway.announcements.length}件`);
  check('ログには残っている', logger.lines.some((l) => l.includes('解除待ちとして台帳に残します')));
  check('/pomo status で解除待ちが分かる', h.pomodoro.statusText().includes('解除待ち'));
  console.log(`    ログ: ${logger.lines.find((l) => l.includes('解除できませんでした: bob'))}`);
  console.log(`    status: ${h.pomodoro.statusText().replace(/\n/g, ' / ')}`);

  // ディスクにも解除待ちが載っていること（再起動しても失われない）
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'leave.json'), 'utf-8'));
  check('解除待ちがディスクに保存される',
    onDisk.muted.find((m) => m.userId === 'bob')?.pendingUnmute === true,
    JSON.stringify(onDisk.muted));

  section('3-b. その人が別のVCに入る → 即座に解除され台帳から消える');
  await join(h, 'bob', 'vc-zatsudan'); // ポモドーロ専用VCではない一般VC
  check('bobのミュートが解除される', !h.gateway.serverMuted.has('bob'));
  check('台帳から消える', !h.registry.has('bob'));
  check('解除待ちが0件になる', h.registry.pendingSize === 0);
  check('解除成功がログに出る', logger.lines.some((l) => l.includes('解除成功: bob')));
  check('aliceは影響を受けない', h.gateway.serverMuted.has('alice') && h.registry.has('alice'));
  console.log(`    ログ: ${logger.lines.filter((l) => l.includes('bob')).slice(-2).join(' / ')}`);
}

async function scenarioMoveToAnotherVc() {
  section('4. 作業中に別のVCへ移動 → 接続が続いているのでその場で解除できる');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'move.json'), logger });

  await join(h, 'alice');
  await join(h, 'bob');
  await join(h, 'bob', 'vc-zatsudan'); // 移動（切断していない）

  check('bobのミュートはその場で解除される', !h.gateway.serverMuted.has('bob'));
  check('解除待ちにはならない', !h.registry.has('bob'));
  check('解除成功のログ', logger.lines.some((l) => l.includes('解除成功: bob') && l.includes('退出時の解除')));
  console.log(`    ログ: ${logger.lines.find((l) => l.includes('解除成功: bob'))}`);
}

async function scenarioEmptyVc() {
  section('5. 全員退出 → 終了。解除待ちとして保持され、再入室で解消される');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const statePath = path.join(stateDir, 'empty.json');
  const h = buildHarness({ clock, statePath, logger });

  await join(h, 'alice');
  await join(h, 'bob');
  await leave(h, 'alice');
  await leave(h, 'bob');

  check('idleに戻る', h.pomodoro.phase === 'idle', `phase=${h.pomodoro.phase}`);
  check('2人とも解除待ちで保持される', h.registry.pendingSize === 2, `pending=${h.registry.pendingList()}`);
  check('ミュートはまだ残っている（解除不能なので当然）', h.gateway.serverMuted.size === 2);
  check('終了の表示になる', h.gateway.liveTexts().some((m) => m.includes('終了しました')));
  check('終了も編集で済ませる（投稿は1本のまま）', h.gateway.announcements.length === 1,
    `新規投稿=${h.gateway.announcements.length}件 / 編集=${h.gateway.edits.length}回`);
  check('終了告知に解除待ちを列挙しない（冗長なので削除）',
    !h.gateway.liveTexts().some((m) => m.includes('<@alice>')));
  console.log(`    最終的な本文: ${h.gateway.liveTexts()[0].replace(/\n/g, ' / ')}`);

  // 次のフェーズタイマーが残っていないこと（空のVCで勝手に再開しない）
  await clock.advance(WORK_MS * 2);
  check('空のまま時間が経っても再開しない', h.pomodoro.phase === 'idle');

  // 2人が戻ってくる → 1人目の入室で新しいポモドーロが始まるが、解除待ちは解消される
  await join(h, 'alice', 'vc-zatsudan');
  check('aliceが一般VCに入ると解除される', !h.gateway.serverMuted.has('alice') && !h.registry.has('alice'));
  await join(h, 'bob', 'vc-zatsudan');
  check('bobも解除される', !h.gateway.serverMuted.has('bob') && !h.registry.has('bob'));
  check('解除待ちが0件', h.registry.pendingSize === 0);
  check('一般VCへの入室では告知しない', h.gateway.announcements.length === 1,
    `新規投稿=${h.gateway.announcements.length}件`);

  // 次のポモドーロは新しい1本を立てる（前回の「終了しました」を書き換えない）
  await join(h, 'alice');
  check('新しいポモドーロは新規投稿になる', h.gateway.announcements.length === 2,
    `新規投稿=${h.gateway.announcements.length}件`);
  check('前回の終了メッセージは残る',
    h.gateway.liveTexts()[0].includes('終了しました') && h.gateway.liveTexts()[1].includes('作業開始'));
}

async function scenarioCrashRecovery() {
  section('6. プロセスを落として再起動 → 記録に残っていた人が解除される');
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

  // --- 再起動(1): aliceはVCに残っている / bobは切断済み ---
  const clock2 = new FakeClock(Date.parse('2026-09-22T20:30:00+09:00'));
  const logger2 = createLogger();
  const h2 = buildHarness({ clock: clock2, statePath, logger: logger2 });
  // 新プロセスから見ても、2人はまだサーバーミュートされている状態を引き継ぐ
  h2.gateway.serverMuted = h1.gateway.serverMuted;
  h2.gateway.join('alice'); // aliceだけVCに繋がったまま

  await h2.pomodoro.recoverOnStartup();
  check('接続中のaliceは起動時に解除される', !h2.gateway.serverMuted.has('alice'));
  check('未接続のbobは解除できない', h2.gateway.serverMuted.has('bob'));
  check('⚠ bobは解除待ちとして保持される（消さない）',
    h2.registry.has('bob') && h2.registry.isPending('bob'), `registry=${JSON.stringify(h2.registry.entries.get('bob'))}`);
  check('内訳がログに出る', logger2.lines.some((l) => l.includes('起動時の解除結果')));
  console.log(`    ${logger2.lines.filter((l) => l.includes('起動時') || l.includes('解除待ち')).join('\n    ')}`);

  // --- 再起動(2): さらにもう一度落ちても、解除待ちは失われない ---
  const clock3 = new FakeClock(Date.parse('2026-09-22T21:00:00+09:00'));
  const logger3 = createLogger();
  const h3 = buildHarness({ clock: clock3, statePath, logger: logger3 });
  h3.gateway.serverMuted = h2.gateway.serverMuted;

  await h3.pomodoro.recoverOnStartup();
  check('2回目の再起動でも解除待ちが残る', h3.registry.isPending('bob'), `pending=${h3.registry.pendingList()}`);

  // 再起動を挟んだあと、bobが一般VCに入る → 解除される
  await join(h3, 'bob', 'vc-zatsudan');
  check('再起動を挟んでも入室で解除される', !h3.gateway.serverMuted.has('bob'));
  check('台帳から消える', !h3.registry.has('bob'));
  console.log(`    ${logger3.lines.filter((l) => l.includes('bob')).slice(-2).join('\n    ')}`);
}

async function scenarioSigterm() {
  section('7. SIGTERM → 全解除してから終了');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'sigterm.json'), logger });

  await join(h, 'alice');
  await join(h, 'bob');
  await h.pomodoro.shutdownUnmuteAll();

  check('全員解除済み（接続中なので成功する）', h.gateway.serverMuted.size === 0);
  check('台帳が空', h.registry.size === 0);
  check('タイマーが残っていない', h.pomodoro.timer === null);
  check('1人ずつの成功ログが出る',
    logger.lines.filter((l) => l.includes('解除成功')).length === 2);
  check('内訳のログが出る', logger.lines.some((l) => l.includes('終了処理の解除結果')));
  console.log(`    ${logger.lines.filter((l) => l.includes('解除')).join('\n    ')}`);
}

async function scenarioUnmuteFailure() {
  section('8. 解除に失敗したら告知が出る（黙って失敗しない）');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'fail.json'), logger });

  await join(h, 'alice');
  h.gateway.failUnmuteFor.add('alice');

  const pending = h.pomodoro.shutdownUnmuteAll();
  await clock.advance(10 * 1000); // リトライ待ちを進める
  await pending;

  check('3回リトライしている',
    logger.lines.filter((l) => l.includes('解除失敗: alice')).length === 3,
    logger.lines.filter((l) => l.includes('解除失敗: alice')).length + '回');
  check('解除失敗が告知される', h.gateway.announcements.some((m) => m.includes('ミュート解除に失敗')));
  check('台帳に残す（次回起動で再挑戦）', h.registry.has('alice'));
  check('40032ではないので解除待ちにはしない', !h.registry.isPending('alice'));
  check('ERRORログが出ている', logger.lines.some((l) => l.startsWith('[ERROR]')));
  console.log(`    ${logger.lines.filter((l) => l.includes('alice')).slice(-4).join('\n    ')}`);
  console.log(`    告知: ${h.gateway.announcements.at(-1).replace(/\n/g, ' / ')}`);
}

async function scenarioDisplayFallback() {
  section('9. VCステータス失敗 → VC名変更にフォールバック / レート制限でも落ちない');
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
  section('10. /call end-at の予約・告知・切断');
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
  section('11. 時刻パースと <t:...:R> のUNIX秒検算（JST）');
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
  section('12. /pomo status の文面');
  const clock = new FakeClock(Date.parse('2026-09-22T20:00:00+09:00'));
  const logger = createLogger();
  const h = buildHarness({ clock, statePath: path.join(stateDir, 'status.json'), logger });
  console.log(`    停止中: ${h.pomodoro.statusText().replace(/\n/g, ' / ')}`);
  assert.ok(h.pomodoro.statusText().includes('停止中'));
  return join(h, 'alice').then(async () => {
    const text = h.pomodoro.statusText();
    console.log(`    作業中: ${text.replace(/\n/g, ' / ')}`);
    check('残り時間がタイムスタンプ記法', /<t:\d{10}:R>/.test(text));

    await leave(h, 'alice'); // 解除待ちが発生する
    const pendingText = h.pomodoro.statusText();
    console.log(`    解除待ちあり: ${pendingText.replace(/\n/g, ' / ')}`);
    check('解除待ちが status に出る', pendingText.includes('解除待ち') && pendingText.includes('<@alice>'));
  });
}

// ---------------------------------------------------------------------------

async function main() {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niceworker-test-'));
  console.log(`state dir: ${stateDir}`);

  try {
    await scenarioBasicCycle();
    await scenarioEditFallback();
    await scenarioLateJoiner();
    await scenarioLeaverPending();
    await scenarioMoveToAnotherVc();
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
