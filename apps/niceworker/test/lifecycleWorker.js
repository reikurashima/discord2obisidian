/**
 * プロセス単位の検証に使う子プロセス。
 * 本物のDiscordには繋がず、gateway だけスタブに差し替えて index.js と同じ形で動かす。
 *
 *   node test/lifecycleWorker.js crash    <stateDir>  … 2人ミュートして異常終了（解除しない）
 *   node test/lifecycleWorker.js recover  <stateDir>  … 起動時の自動解除だけ実行
 *   node test/lifecycleWorker.js sigterm  <stateDir>  … 2人ミュート後、SIGTERM待ち
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

const originalSetMute = gateway.setMute.bind(gateway);
gateway.setMute = async (userId, mute, reason) => {
  const result = await originalSetMute(userId, mute, reason);
  fs.writeFileSync(serverStatePath, JSON.stringify([...gateway.serverMuted]), 'utf-8');
  return result;
};

const registry = new MuteRegistry(statePath, logger);
const display = new PhaseDisplay({
  gateway, vcChannelId: VC, labels: { work: '🍅作業中', break: '☕休憩中' }, logger,
});
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
  console.log('SHUTDOWN_DONE');
  process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

async function main() {
  if (mode === 'recover') {
    await pomodoro.recoverOnStartup();
    console.log(`SERVER_MUTED_AFTER_RECOVER=${JSON.stringify([...gateway.serverMuted])}`);
    console.log(`REGISTRY_AFTER_RECOVER=${JSON.stringify(registry.list())}`);
    process.exit(0);
  }

  await pomodoro.recoverOnStartup();
  gateway.join('alice');
  await pomodoro.handleVoiceStateUpdate({ userId: 'alice', oldChannelId: null, newChannelId: VC });
  gateway.join('bob');
  await pomodoro.handleVoiceStateUpdate({ userId: 'bob', oldChannelId: null, newChannelId: VC });
  console.log(`SERVER_MUTED=${JSON.stringify([...gateway.serverMuted])}`);
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
