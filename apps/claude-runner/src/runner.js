import path from 'path';
import { detectAuthError } from './authDetect.js';
import { getKind, validateJobShape } from './kinds.js';
import { extractOutputJson } from './parseOutput.js';
import { buildPrompt } from './prompt.js';
import { getSchema } from './schemas/index.js';
import {
  claimNextJob, clearProcessing, moveToFailed, writeResult,
} from './queue.js';
import {
  atomicWriteFile, ensureDir, readJson, rmrf, writeJson,
} from './utils/fsx.js';
import { logger } from './utils/logger.js';

/**
 * ジョブ1件を処理するワーカー。
 *
 * ⚠ executor を**注入**する形にしてある。
 *   claude の認証が無い環境では実行できないため、検証はスタブ executor で行う。
 *   （本番は executor.js の createClaudeExecutor）
 */
export function createRunner({ config, executor, onJobFinished = () => {} }) {
  // 処理中のジョブ。SIGTERM のときに failed/ へ落とすために持っておく。
  // ⚠ 1プロセス・直列実行なので、ここは常に0件か1件。
  let current = null;

  /**
   * inbox から1件取って処理する。
   * @returns {Promise<object|null>} 処理した結果JSON（何も無ければ null）
   */
  async function runOnce() {
    const claimed = await claimNextJob(config);
    if (!claimed) return null;
    return processClaimed(claimed);
  }

  async function processClaimed({ bot, fileName, processingPath }) {
    const jobId = fileName.replace(/\.json$/, '');
    const startedAt = new Date().toISOString();
    current = {
      bot, fileName, jobId, startedAt, jobWorkDir: null, abandoned: false,
    };
    logger.info(`[Job] start ${bot}/${jobId}`);

    let job = null;
    try {
      job = await readJson(processingPath);
    } catch (error) {
      return finishFailure({
        bot, fileName, jobId, startedAt,
        status: 'rejected',
        errorCode: 'BAD_JOB',
        logTail: `ジョブJSONを読めませんでした: ${error.message}`,
        rawError: { readError: error.message },
      });
    }

    // ---- bot / kind / outputSchema のホワイトリスト照合（外れたら即 failed）----
    const shape = validateJobShape(job, fileName, bot);
    if (shape.errorCode) {
      return finishFailure({
        bot, fileName, jobId, startedAt,
        status: 'rejected',
        errorCode: shape.errorCode,
        logTail: shape.errors.join('\n'),
        rawError: { rejected: shape.errors, job },
      });
    }

    const kindDef = getKind(job.kind);
    const schema = getSchema(job.outputSchema);
    const timeoutSec = clampTimeout(job.timeoutSec, config);

    // ---- ジョブ専用の作業ディレクトリ ----
    // ⚠ ジョブごとに新規作成 → 終わったら丸ごと削除。
    //    セッション・履歴・前のジョブのファイルを持ち越さないため。
    const jobWorkDir = path.join(config.workDir, jobId);
    const outDir = path.join(jobWorkDir, 'out');
    current.jobWorkDir = jobWorkDir;
    let prompt = '';
    let exec = null;

    try {
      await rmrf(jobWorkDir); // 前回の残骸があっても確実に新品から始める
      await ensureDir(outDir);
      await writeJson(path.join(jobWorkDir, 'job.json'), job);
      await writeJson(path.join(jobWorkDir, 'input.json'), job.input ?? {});

      prompt = buildPrompt(job, kindDef, schema, { workDir: jobWorkDir, outDir });
      await atomicWriteFile(path.join(jobWorkDir, 'prompt.txt'), prompt);

      exec = await executor({
        jobId, prompt, cwd: jobWorkDir, outDir, kindDef, schema,
        model: job.model || null,
        timeoutSec,
        job,
      });
    } catch (error) {
      logger.error(`[Job] executor threw for ${jobId}`, error);
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'error',
        errorCode: 'EXEC_FAILED',
        logTail: `${error.message}`,
        rawError: { execThrow: error.message, stack: error.stack },
      });
    }

    const logTail = tail(`${exec.stdout || ''}\n${exec.stderr || ''}`, config.logTailChars);

    // ---- タイムアウト ----
    if (exec.timedOut) {
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'timeout',
        errorCode: 'TIMEOUT',
        logTail,
        rawError: rawDump(exec, timeoutSec),
      });
    }

    // ---- 認証切れ（判定は暫定。生の出力は必ず残す）----
    const auth = detectAuthError(exec);
    if (auth.isAuthError) {
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'error',
        errorCode: 'AUTH',
        logTail,
        rawError: { ...rawDump(exec, timeoutSec), authMatched: auth.matched },
        authSuspected: true,
      });
    }

    // ---- 異常終了 ----
    if (exec.code !== 0) {
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'error',
        errorCode: 'EXEC_FAILED',
        logTail,
        rawError: rawDump(exec, timeoutSec),
      });
    }

    // ---- 出力の取り出し ----
    const extracted = extractOutputJson(exec.stdout);
    if (!extracted.ok) {
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'error',
        errorCode: 'SCHEMA',
        logTail,
        rawError: { ...rawDump(exec, timeoutSec), parseReason: extracted.reason },
      });
    }

    // ---- スキーマ検証（★全か無か。部分的に採用しない）----
    const verdict = schema.validate(extracted.value);
    if (!verdict.ok) {
      logger.warn(`[Job] ${jobId} schema mismatch (${schema.name}): ${verdict.errors.join(' / ')}`);
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'error',
        errorCode: 'SCHEMA',
        // ⚠ output は null。「一部だけ合っているので使う」は絶対にしない。
        //    依頼側が半端なデータでタスクを作ってしまうため
        logTail: `schema ${schema.name} mismatch:\n${verdict.errors.join('\n')}\n---\n${logTail}`,
        rawError: { ...rawDump(exec, timeoutSec), schemaErrors: verdict.errors, parsed: extracted.value },
      });
    }

    // ---- 成功 ----
    // SIGTERM で既に failed/ へ落とされていたら、結果を上書きしない
    if (current?.abandoned) return null;

    const result = {
      jobId,
      status: 'ok',
      output: extracted.value,
      errorCode: null,
      logTail,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeResult(config, bot, jobId, result);
    await clearProcessing(config, bot, fileName);
    await rmrf(jobWorkDir);
    current = null;
    logger.info(`[Job] ok ${bot}/${jobId}`);
    onJobFinished({ bot, jobId, result, authSuspected: false });
    return result;
  }

  async function finishFailure({
    bot, fileName, jobId, startedAt, jobWorkDir, status, errorCode, logTail, rawError, authSuspected = false,
  }) {
    if (current?.abandoned) return null;

    const result = {
      jobId,
      status,
      output: null,
      errorCode,
      logTail: tail(logTail || '', config.logTailChars),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeResult(config, bot, jobId, result);
    // ⚠ 失敗したジョブ本体は failed/ に残すだけ。再実行しない（二重実行を避ける）
    await moveToFailed(config, bot, fileName, rawError);
    if (jobWorkDir) await rmrf(jobWorkDir);
    current = null;
    logger.warn(`[Job] ${status}/${errorCode} ${bot}/${jobId}`);
    onJobFinished({ bot, jobId, result, authSuspected });
    return result;
  }

  /**
   * SIGTERM 用。処理中のジョブを failed/ へ落としてから終われるようにする。
   *
   * ⚠ 中途半端に終わったジョブを processing/ に置き去りにすると、
   *   次の起動で回収されるまで依頼側が永久に result を待つことになる。
   *   ここで結果（status: error / INTERRUPTED）まで書いておけば、
   *   依頼側は「失敗した」と分かって投げ直せる。
   */
  async function abandonCurrent() {
    if (!current || current.abandoned) return null;
    current.abandoned = true;
    const {
      bot, fileName, jobId, startedAt, jobWorkDir,
    } = current;

    const result = {
      jobId,
      status: 'error',
      output: null,
      errorCode: 'INTERRUPTED',
      logTail: 'SIGTERM を受けたため中断しました。再実行はしていません（二重実行を避けるため）。',
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    try {
      await writeResult(config, bot, jobId, result);
      await moveToFailed(config, bot, fileName, { interrupted: 'SIGTERM' });
      if (jobWorkDir) await rmrf(jobWorkDir);
    } catch (error) {
      logger.error(`[Job] failed to abandon ${jobId} cleanly`, error);
    }
    logger.warn(`[Job] interrupted ${bot}/${jobId} → failed/`);
    current = null;
    return result;
  }

  function currentJob() {
    return current;
  }

  return {
    runOnce, processClaimed, abandonCurrent, currentJob,
  };
}

/** 既定300秒・上限900秒。ジョブ側の指定が壊れていても必ず範囲内に収める */
export function clampTimeout(value, config) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return config.defaultTimeoutSec;
  return Math.min(Math.floor(n), config.maxTimeoutSec);
}

function tail(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(s.length - max);
}

/** 実機で認証切れの出方を確かめるための生ダンプ（判定ロジックより先にこれを残す） */
function rawDump(exec, timeoutSec) {
  return {
    exitCode: exec.code,
    signal: exec.signal,
    timedOut: exec.timedOut,
    timeoutSec,
    argv: exec.argv || null,
    stdout: exec.stdout || '',
    stderr: exec.stderr || '',
  };
}
