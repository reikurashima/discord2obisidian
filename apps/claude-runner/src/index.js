import { loadConfig } from './config.js';
import { createClaudeExecutor } from './executor.js';
import { createHealthMonitor } from './health.js';
import { createRunner } from './runner.js';
import {
  ensureQueueDirs, purgeOldFiles, purgeOrphanFiles, recoverStaleProcessing,
} from './queue.js';
import { logger } from './utils/logger.js';

const config = loadConfig();

// executor は差し替え可能。
// ⚠ claude の認証が無い環境では本物を実行できないため、
//   RUNNER_EXECUTOR_MODULE にモジュールパスを指定するとそちらを使う
//   （検証用のスタブを差し込むための口。本番では未設定にしておくこと）。
const executor = process.env.RUNNER_EXECUTOR_MODULE
  ? (await import(process.env.RUNNER_EXECUTOR_MODULE)).createExecutor(config)
  : createClaudeExecutor(config);
const health = createHealthMonitor({ config, executor });
const runner = createRunner({
  config,
  executor,
  onJobFinished: (info) => health.recordJob(info),
});

let stopping = false;
let loopPromise = null;

async function main() {
  logger.info('claude-runner starting');
  logger.info(`  queueDir : ${config.queueDir}`);
  logger.info(`  workDir  : ${config.workDir}`);
  logger.info(`  health   : ${config.healthFile}`);
  logger.info(`  webhook  : ${config.webhookUrl ? 'configured' : '(not set — log only)'}`);
  if (process.env.RUNNER_EXECUTOR_MODULE) {
    logger.warn(`  executor : STUB (${process.env.RUNNER_EXECUTOR_MODULE}) — 本番では未設定にすること`);
  }

  await ensureQueueDirs(config);

  // ⚠ 起動時に processing/ の残骸を failed/ へ回収する。**再実行はしない。**
  await recoverStaleProcessing(config);

  await purgeOldFiles(config);
  // ⚠ 添付（請求書PDFなど機微情報）の取り残しを消す。回収処理の後に呼ぶこと
  await purgeOrphanFiles(config);
  const purgeTimer = setInterval(() => {
    purgeOldFiles(config).catch((e) => logger.error('[Queue] purge failed', e));
    purgeOrphanFiles(config).catch((e) => logger.error('[Files] orphan purge failed', e));
  }, config.purgeIntervalMs);
  purgeTimer.unref?.();

  health.start();
  await health.tick(); // 起動直後に1回書く（＋起動時の疎通確認）

  loopPromise = loop();
  await loopPromise;
}

/**
 * ⚠ 1プロセス・直列実行。同時に2つのジョブを走らせない。
 *   claude は1回あたりのコストも実行時間も大きく、NASのCPUも限られるため。
 *   並列化したくなったら「プロセスを増やす」側で対応する（rename で取り合えるので安全）。
 */
async function loop() {
  while (!stopping) {
    let processed = null;
    try {
      processed = await runner.runOnce();
    } catch (error) {
      // 1件の失敗でワーカーを止めない。次のジョブへ進む
      logger.error('[Loop] job processing threw', error);
    }
    // 何も無かったときだけ待つ。詰まっているときは連続で捌く
    if (!processed && !stopping) await sleep(config.pollIntervalMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ---- 堅牢性 -----------------------------------------------------------

process.on('unhandledRejection', (error) => {
  // 握りつぶさない。何が起きたかは必ず残す
  logger.error('Unhandled promise rejection', error);
});

process.on('uncaughtException', (error) => {
  // 状態が壊れている可能性があるので生き残らせない。
  // restart: unless-stopped に任せて作り直す（既存Botと同じ方針）
  logger.error('Uncaught exception, exiting', error);
  shutdown(1);
});

// ⚠ Docker が送るのは SIGTERM。SIGINT しか見ていないと docker stop で即死する
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

let shuttingDown = false;

async function shutdown(exitCode) {
  if (shuttingDown) {
    process.exit(exitCode);
    return;
  }
  shuttingDown = true;
  stopping = true;
  logger.info('Shutting down...');

  health.stop();

  try {
    // 処理中のジョブは failed/ に落としてから終わる。
    // processing/ に置き去りにすると、依頼側が result を永久に待つことになる
    await Promise.race([
      runner.abandonCurrent(),
      sleep(8000), // Docker の既定猶予（10秒）内に必ず抜ける
    ]);
  } catch (error) {
    logger.error('Error while abandoning current job', error);
  }

  try { await health.write(); } catch { /* 終了時の health 更新失敗は無視 */ }

  logger.info('Bye');
  process.exit(exitCode);
}

main().catch((error) => {
  logger.error('Fatal error during startup, exiting', error);
  process.exit(1);
});
