import { getKind } from './kinds.js';
import { notifyDiscord } from './notify.js';
import { detectAuthError } from './authDetect.js';
import { extractOutputJson } from './parseOutput.js';
import { queueDepth } from './queue.js';
import { getSchema } from './schemas/index.js';
import { buildPrompt } from './prompt.js';
import { writeJson } from './utils/fsx.js';
import { logger } from './utils/logger.js';

/**
 * 稼働状態と認証状態を health.json に書き続ける係。
 *
 * - 60秒ごとに updatedAt / queueDepth / lastJob を更新
 * - 1日1回、ごく小さなプロンプトで疎通確認（＝認証が生きているか）
 * - ジョブが AUTH で失敗したときは、その場で疎通確認を前倒しする
 * - 認証が切れていたら Discord webhook へ**1回だけ**通知（復旧したら再び通知できる状態に戻す）
 */
export function createHealthMonitor({ config, executor, now = () => Date.now() }) {
  const state = {
    startedAt: new Date().toISOString(),
    auth: 'unknown', // unknown | ok | expired
    checkedAt: null,
    lastJob: null,
    lastError: null,
    lastAuthProbe: null,
  };

  let lastCheckMs = 0;
  let notifiedExpired = false; // 同じ状態で通知を撒き散らさないためのフラグ
  let timer = null;
  let probing = false;

  async function write() {
    const payload = {
      status: 'running',
      pid: process.pid,
      startedAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      auth: state.auth,
      checkedAt: state.checkedAt,
      queueDepth: await queueDepth(config),
      lastJob: state.lastJob,
      // ⚠ 認証切れの判定が未確定なので、生のエラー出力をここにも残しておく。
      //    「何が起きたか」を実機のログから確かめて判定ロジックを詰めるため
      lastError: state.lastError,
      lastAuthProbe: state.lastAuthProbe,
    };
    try {
      await writeJson(config.healthFile, payload);
    } catch (error) {
      // health が書けないだけで本体を止めない
      logger.error('[Health] could not write health file', error);
    }
    return payload;
  }

  /** ごく小さなプロンプトで claude を叩き、認証が生きているか見る */
  async function probeAuth(reason) {
    if (probing) return state.auth;
    probing = true;
    lastCheckMs = now();
    const kindDef = getKind('echo.ping');
    const schema = getSchema('echo.v1');
    const job = {
      jobId: 'authprobe', bot: 'pm', kind: 'echo.ping',
      input: { text: 'ping' }, quoted: [], outputSchema: 'echo.v1',
    };
    const prompt = buildPrompt(job, kindDef, schema, { workDir: config.workDir, outDir: config.workDir });

    try {
      const exec = await executor({
        jobId: 'authprobe', prompt, cwd: config.workDir, outDir: config.workDir,
        kindDef, schema, model: null, timeoutSec: 60, job,
      });
      const auth = detectAuthError(exec);
      const extracted = extractOutputJson(exec.stdout);
      const ok = !auth.isAuthError && exec.code === 0 && extracted.ok;

      state.auth = ok ? 'ok' : 'expired';
      state.checkedAt = new Date().toISOString();
      state.lastAuthProbe = {
        reason,
        exitCode: exec.code,
        timedOut: exec.timedOut,
        authMatched: auth.matched,
        // 生の出力をそのまま残す（判定ロジックを後から詰めるため）
        stdout: truncate(exec.stdout, 2000),
        stderr: truncate(exec.stderr, 2000),
      };

      if (!ok && !notifiedExpired) {
        notifiedExpired = true;
        await notifyExpired(state.lastAuthProbe);
      }
      if (ok) notifiedExpired = false; // 復旧したら次の切れ目でまた通知できるように戻す

      logger.info(`[Health] auth probe (${reason}) → ${state.auth}`);
    } catch (error) {
      // claude 自体が起動できない（未インストール等）
      state.auth = 'expired';
      state.checkedAt = new Date().toISOString();
      state.lastAuthProbe = { reason, error: error.message };
      if (!notifiedExpired) {
        notifiedExpired = true;
        await notifyExpired(state.lastAuthProbe);
      }
      logger.error('[Health] auth probe failed to run', error);
    } finally {
      probing = false;
      await write();
    }
    return state.auth;
  }

  async function notifyExpired(detail) {
    const text = [
      '## ❌ claude-runner: 認証が切れている可能性があります',
      '```',
      `検出時刻: ${new Date().toISOString()}`,
      `きっかけ: ${detail.reason}`,
      `exitCode: ${detail.exitCode ?? '-'}  match: ${detail.authMatched ?? '-'}`,
      '',
      '; 復旧手順',
      'docker exec -it claude-runner claude',
      '  → 表示されたURLをブラウザで開いてログイン → コードを貼り戻す',
      '',
      '; 状態ファイル',
      config.healthFile,
      '',
      '; 生のエラー出力（末尾）',
      truncate(detail.stderr || detail.error || '(なし)', 600),
      '```',
    ].join('\n');
    await notifyDiscord(config.webhookUrl, text);
  }

  /** ジョブが終わるたびに runner から呼ばれる */
  function recordJob({ bot, jobId, result, authSuspected }) {
    state.lastJob = {
      bot, jobId, status: result.status, errorCode: result.errorCode, finishedAt: result.finishedAt,
    };
    if (result.status !== 'ok') {
      state.lastError = { bot, jobId, errorCode: result.errorCode, logTail: truncate(result.logTail, 2000) };
    }
    // AUTH で落ちたら、日次を待たずにその場で確かめる
    if (authSuspected) probeAuth('job failed with AUTH').catch(() => {});
  }

  async function tick() {
    await write();
    if (now() - lastCheckMs >= config.authCheckIntervalMs) {
      await probeAuth(lastCheckMs === 0 ? 'startup' : 'daily');
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => logger.error('[Health] tick failed', e)); }, config.healthIntervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start, stop, tick, write, probeAuth, recordJob, state,
  };
}

function truncate(s, max) {
  const t = String(s ?? '');
  return t.length <= max ? t : t.slice(t.length - max);
}
