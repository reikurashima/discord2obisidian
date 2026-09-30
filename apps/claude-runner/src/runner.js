import path from 'path';
import { cleanupNames, deleteAttachments, stageAttachments } from './attachments.js';
import { detectAuthError } from './authDetect.js';
import { getKind, isRedactedKind, validateJobShape } from './kinds.js';
import { extractOutputJson } from './parseOutput.js';
import { buildPrompt } from './prompt.js';
import { getSchema } from './schemas/index.js';
import {
  claimNextJob, clearProcessing, moveToFailed, pickSafeRawError, writeResult,
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
      bot,
      fileName,
      jobId,
      startedAt,
      jobWorkDir: null,
      abandoned: false,
      // ジョブが終わったら（成功・失敗・中断とも）files/ から消す添付の名前（<jobId>.pdf だけ）。
      // JSONが読めなくても消せるよう、読む前に入れておく
      attachmentNames: cleanupNames(jobId),
      // redactLogs の kind か（生の出力を result / failed に残さない）。JSONを読んでから決まる
      redact: false,
    };
    logger.info(`[Job] start ${bot}/${jobId}`);

    let job = null;
    try {
      job = await readJson(processingPath);
      // ⚠ rejected になるジョブでも kind 名で判定する（pm から invoice.extract が来た場合も伏せる）
      current.redact = isRedactedKind(job?.kind);
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
    let attachments = [];

    // ---- 添付を files/ から作業ディレクトリへコピーする ----
    // ⚠ claude に読ませるのは作業ディレクトリ内のコピーだけ。files/ の原本は終了時に消す
    try {
      await rmrf(jobWorkDir); // 前回の残骸があっても確実に新品から始める
      await ensureDir(outDir);
      const names = Array.isArray(job.attachments) ? job.attachments : [];
      if (names.length > 0) {
        const staged = await stageAttachments(config, bot, names, jobWorkDir);
        if (!staged.ok) {
          return finishFailure({
            bot, fileName, jobId, startedAt, jobWorkDir,
            status: staged.status,
            errorCode: staged.errorCode,
            logTail: staged.message,
            rawError: { attachment: staged.message, attachments: names },
          });
        }
        attachments = staged.files;
      }
    } catch (error) {
      logger.error(`[Job] could not prepare work dir for ${jobId}`, error);
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'error',
        errorCode: 'EXEC_FAILED',
        logTail: `作業ディレクトリの準備に失敗しました: ${error.message}`,
        rawError: { prepareThrow: error.message, stack: error.stack },
      });
    }

    try {
      await writeJson(path.join(jobWorkDir, 'job.json'), job);
      await writeJson(path.join(jobWorkDir, 'input.json'), job.input ?? {});

      prompt = buildPrompt(job, kindDef, schema, { workDir: jobWorkDir, outDir, attachments });
      await atomicWriteFile(path.join(jobWorkDir, 'prompt.txt'), prompt);

      exec = await executor({
        jobId, prompt, cwd: jobWorkDir, outDir, kindDef, schema,
        // kind 側でモデルを固定しているもの（task.triage = sonnet）はジョブの指定より優先する。
        // 固定していない kind は従来どおりジョブの指定（無ければモデル指定なし）
        model: kindDef.model || job.model || null,
        timeoutSec,
        attachments,
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

    // ⚠ safeDetail … redactLogs の kind で logTail の代わりに残す短い理由。
    //   生の出力（stdout / stderr）を含めないこと。値ではなく「何が起きたか」だけを書く

    // ---- タイムアウト ----
    if (exec.timedOut) {
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'timeout',
        errorCode: 'TIMEOUT',
        logTail,
        safeDetail: `timed out after ${timeoutSec}s`,
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
        // 生の出力は health.json の lastAuthProbe（echo.ping での疎通確認）で確かめられる
        safeDetail: `auth error suspected (exit=${exec.code}, matched=${JSON.stringify(auth.matched ?? null)})`,
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
        safeDetail: `claude exited with code ${exec.code} (signal=${exec.signal ?? 'none'})`,
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
        safeDetail: `could not parse output: ${extracted.reason}`,
        rawError: { ...rawDump(exec, timeoutSec), parseReason: extracted.reason },
      });
    }

    // ---- スキーマ検証（★全か無か。部分的に採用しない）----
    // normalize はスキーマが持っていれば1回だけ通す（例: invoice.v1 の登録番号の形式違い → null）。
    // ⚠ キーの過不足・型違いは normalize では直さない。validate で全部捨てる
    // 第2引数の { job } は、ジョブの入力と突き合わせるスキーマ用（tasks.v1 の projectId など）。
    // 使わないスキーマ（digest / echo / invoice）は受け取らないだけなので挙動は変わらない
    const schemaCtx = { job };
    const output = typeof schema.normalize === 'function' ? schema.normalize(extracted.value, schemaCtx) : extracted.value;
    const verdict = schema.validate(output, schemaCtx);
    if (!verdict.ok) {
      logger.warn(`[Job] ${jobId} schema mismatch (${schema.name}): ${verdict.errors.join(' / ')}`);
      return finishFailure({
        bot, fileName, jobId, startedAt, jobWorkDir,
        status: 'error',
        errorCode: 'SCHEMA',
        // ⚠ output は null。「一部だけ合っているので使う」は絶対にしない。
        //    依頼側が半端なデータでタスクを作ってしまうため
        logTail: `schema ${schema.name} mismatch:\n${verdict.errors.join('\n')}\n---\n${logTail}`,
        // どの項目で落ちたかだけ（スキーマのエラー文には値を入れない作りにしてある）
        safeDetail: `schema ${schema.name} mismatch:\n${verdict.errors.join('\n')}`,
        rawError: { ...rawDump(exec, timeoutSec), schemaErrors: verdict.errors, parsed: extracted.value },
      });
    }

    // ---- 成功 ----
    // SIGTERM で既に failed/ へ落とされていたら、結果を上書きしない
    if (current?.abandoned) return null;

    const result = {
      jobId,
      status: 'ok',
      output,
      errorCode: null,
      // ⚠ redactLogs の kind は空。生の出力（= output と同じ請求書の値）を二重に残さない
      logTail: current?.redact ? '' : logTail,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeResult(config, bot, jobId, result);
    await clearProcessing(config, bot, fileName);
    await rmrf(jobWorkDir);
    await deleteAttachments(config, bot, current?.attachmentNames);
    current = null;
    logger.info(`[Job] ok ${bot}/${jobId}`);
    onJobFinished({ bot, jobId, result, authSuspected: false });
    return result;
  }

  async function finishFailure({
    bot, fileName, jobId, startedAt, jobWorkDir, status, errorCode, logTail, safeDetail, rawError, authSuspected = false,
  }) {
    if (current?.abandoned) return null;

    // ⚠ redactLogs の kind（invoice.extract）は生の出力を残さない。
    //   logTail は「エラーコード＋短い理由（safeDetail）」だけ、failed/*.error.json も値を含まないキーだけ。
    //   safeDetail が無い失敗（名前・サイズ・形の検証など）は、logTail 自体が生の出力を含まないのでそのまま使う
    const redact = !!current?.redact;
    const finalTail = redact
      ? `[${errorCode}] ${safeDetail ?? logTail ?? ''}\n（${REDACTED_NOTE}）`
      : logTail;
    const finalRaw = redact && rawError
      ? pickSafeRawError({ ...rawError, errorCode, detail: safeDetail ?? logTail ?? null })
      : rawError;

    const result = {
      jobId,
      status,
      output: null,
      errorCode,
      logTail: tail(finalTail || '', config.logTailChars),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeResult(config, bot, jobId, result);
    // ⚠ 失敗したジョブ本体は failed/ に残すだけ。再実行しない（二重実行を避ける）
    await moveToFailed(config, bot, fileName, finalRaw);
    if (jobWorkDir) await rmrf(jobWorkDir);
    // ⚠ 失敗しても添付（機微情報）は残さない。依頼側が投げ直すときは置き直す約束
    await deleteAttachments(config, bot, current?.attachmentNames);
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
      bot, fileName, jobId, startedAt, jobWorkDir, attachmentNames,
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
      await deleteAttachments(config, bot, attachmentNames);
    } catch (error) {
      logger.error(`[Job] failed to abandon ${jobId} cleanly`, error);
    }
    logger.warn(`[Job] interrupted ${bot}/${jobId} → failed/`);
    // ⚠ current は null に戻さない（abandoned: true のまま残す）。
    //   null にすると、中断後に executor が戻ってきたとき成功・失敗側の
    //   `current?.abandoned` の確認がすり抜け、INTERRUPTED の結果を上書きしてしまう
    //   （2026-09-24 に検証で発覚。本番は中断直後に process.exit するので表面化していなかった）。
    //   次のジョブを取った時点で processClaimed が current を作り直す。
    return result;
  }

  function currentJob() {
    return current;
  }

  return {
    runOnce, processClaimed, abandonCurrent, currentJob,
  };
}

const REDACTED_NOTE = '機微情報を含む kind のため、生の出力は残していません';

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
