/**
 * プロセス単位の検証に使う子プロセス。
 * 本物のDiscordには繋がず、gateway だけスタブに差し替えて index.js と同じ形で動かす。
 *
 *   node test/lifecycleWorker.js crash    <stateDir>  … 2人ミュートして異常終了（解除しない）
 *   node test/lifecycleWorker.js recover  <stateDir>  … 起動時の自動解除だけ実行
 *   node test/lifecycleWorker.js rejoin   <stateDir>  … 起動時の自動解除 → 解除待ちの人が一般VCへ入室
 *   node test/lifecycleWorker.js sigterm  <stateDir>  … 2人ミュート後、SIGTERM待ち
 *
 * 環境変数 CONNECTED=alice,bob で「起動時点でVCに繋がっている人」を指定できる
 * （繋がっていない人はDiscord仕様で解除できないため、解除待ちのまま保持されるのが正しい）。
 */
import fs from 'fs';
import path from 'path';
import { StubGateway, createLogger } from './stubs.js';
import { MuteRegistry } from '../src/pomodoro/muteRegistry.js';
import { PhaseDisplay } from '../src/pomodoro/display.js';
import { PomodoroManager } from '../src/pomodoro/manager.js';

const [mode, stateDir] = process.argv.slice(2);
const VC = 'vc-pomodoro';
const statePath = path.join(stateDir, 'muted-members.json');
// 「Discord側に残っているミュート状態」をプロセスをまたいで共有するための外部ファイル
const serverStatePath = path.join(stateDir, 'server-mute-state.json');

const logger = createLogger(true);
const gateway = new StubGateway({ vcChannelId: VC });

// 前のプロセスが残したミュート状態を引き継ぐ
try {
  for (const id of JSON.parse(fs.readFileSync(serverStatePath, 'utf-8'))) gateway.serverMuted.add(id);
} catch { /* 初回は無い */ }

// 起動時点でVCに繋がっている人
for (const id of (process.env.CONNECTED ?? '').split(',').filter(Boolean)) gateway.join(id);

const originalSetMute = gateway.setMute.bind(gateway);
gateway.setMute = async (userId, mute, reason) => {
  const result = await originalSetMute(userId, mute, reason);
  fs.writeFileSync(serverStatePath, JSON.stringify([...gateway.serverMuted]), 'utf-8');
  return result;
};

const registry = new MuteRegistry(statePath, logger);
const display = new PhaseDisplay({ gateway, vcChannelId: VC, logger });
const pomodoro = new PomodoroManager({
  gateway, registry, display, logger,
  vcChannelId: VC, workMs: 60_000, breakMs: 10_000,
});

// index.js と同じ終了処理
let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('SHUTDOWN_START');
  await pomodoro.shutdownUnmuteAll();
  console.log(`SERVER_MUTED_AFTER_SHUTDOWN=${JSON.stringify([...gateway.serverMuted])}`);
  // index.js と同じく、ミュート解除の**あと**に表示の後始末をする
  await display.clearStatus();
  console.log(`VOICE_STATUS_AFTER_SHUTDOWN=${JSON.stringify(gateway.currentStatus(VC))}`);
  console.log('SHUTDOWN_DONE');
  process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

async function main() {
  if (mode === 'recover' || mode === 'rejoin') {
    await pomodoro.recoverOnStartup();
    // index.js と同じく、起動時に前回の残骸ステータスを消す
    await display.clearStatus();
    console.log(`VOICE_STATUS_AFTER_RECOVER=${JSON.stringify(gateway.currentStatus(VC))}`);
    console.log(`SERVER_MUTED_AFTER_RECOVER=${JSON.stringify([...gateway.serverMuted])}`);
    console.log(`REGISTRY_AFTER_RECOVER=${JSON.stringify(registry.list())}`);
    console.log(`PENDING_AFTER_RECOVER=${JSON.stringify(registry.pendingList())}`);

    if (mode === 'rejoin') {
      // 解除待ちの人が、ポモドーロ専用VCではない一般VCへ入ってくる
      for (const userId of registry.pendingList()) {
        gateway.join(userId, 'vc-zatsudan');
        await pomodoro.handleVoiceStateUpdate({ userId, oldChannelId: null, newChannelId: 'vc-zatsudan' });
      }
      console.log(`SERVER_MUTED_AFTER_REJOIN=${JSON.stringify([...gateway.serverMuted])}`);
      console.log(`PENDING_AFTER_REJOIN=${JSON.stringify(registry.pendingList())}`);
    }
    process.exit(0);
  }

  await pomodoro.recoverOnStartup();
  for (const userId of ['alice', 'bob']) {
    gateway.join(userId, VC);
    await pomodoro.handleVoiceStateUpdate({ userId, oldChannelId: null, newChannelId: VC });
  }
  console.log(`SERVER_MUTED=${JSON.stringify([...gateway.serverMuted])}`);
  console.log(`VOICE_STATUS=${JSON.stringify(gateway.currentStatus(VC))}`);
  console.log('READY');

  if (mode === 'crash') {
    // 解除せずに突然死。台帳だけがディスクに残る
    process.exit(137);
  }

  // ⚠ Windows では外から SIGTERM を配送できない（Nodeの制約）。
  //    その場合だけ、自分で同じハンドラを踏んで経路を検証する。
  //    Linuxコンテナ（本番）では親から本物の信号が届く。
  if (mode === 'sigterm' && process.env.SELF_SIGTERM === '1') {
    setTimeout(() => process.emit('SIGTERM'), 50);
  }
}

main();
