import { spawn } from 'child_process';
import { buildToolArgs } from './kinds.js';
import { logger } from './utils/logger.js';

/**
 * `claude -p` を実際に叩く executor。
 *
 * ⚠ この関数は差し替え可能にしてある（runner に注入する）。
 *    認証が無い環境では実行できないため、検証はスタブ executor で行う。
 *
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, argv:string[]}>}
 */
export function createClaudeExecutor(config) {
  return async function claudeExecutor(task) {
    const { prompt, cwd, timeoutSec } = task;

    return runProcess({
      bin: config.claudeBin,
      args: buildClaudeArgs(task),
      cwd,
      stdin: prompt,
      timeoutMs: timeoutSec * 1000,
      killGraceMs: config.killGraceMs,
      env: buildChildEnv(process.env),
    });
  };
}

/**
 * `claude` に渡す引数（プロンプトは stdin なので含まない）。
 * 検証で「実際にどういうツール制限で起動するか」を出力できるよう切り出してある。
 */
export function buildClaudeArgs({
  cwd, outDir, kindDef, model,
}) {
  const args = ['-p', '--output-format', 'json'];
  // cwd = /work/<jobId>。tools: 'workdir-read' の許可範囲はここに絞られる
  args.push(...buildToolArgs(kindDef, outDir, cwd));
  // model はジョブ任意。未指定ならモデル指定なし（既定に任せる）
  if (model) args.push('--model', model);
  return args;
}

/**
 * 子プロセスに渡す環境変数を作る。
 *
 * ⚠⚠ ANTHROPIC_API_KEY を必ず消す。
 *    この runner は**サブスク認証（/root/.claude の資格情報）で動かす**のが前提。
 *    APIキーが環境に紛れていると claude はそちらを優先し、
 *    気づかないうちに従量課金が発生する。
 *    ANTHROPIC_AUTH_TOKEN も同じ理由で消す（APIプロキシ経由の課金経路になるため）。
 */
export function buildChildEnv(sourceEnv) {
  const env = { ...sourceEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/**
 * 子プロセスを起動して、タイムアウトなら SIGTERM → 5秒後 SIGKILL で落とす。
 * Docker と同じ順序にしてある（いきなり KILL しない）。
 */
export function runProcess({
  bin, args, cwd, stdin, timeoutMs, killGraceMs, env,
  // ⚠ 検証用の差し込み口。Windows には本物のシグナルが無く、
  //   child.kill('SIGTERM') が即座にプロセスを消してしまうため、
  //   「SIGTERM を送ってから5秒後に SIGKILL」の順序をテストできない。
  //   既定は本物の kill。
  killFn = (child, signal) => child.kill(signal),
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    let settled = false;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(`[Exec] timeout (${timeoutMs}ms) → SIGTERM ${bin}`);
      try { killFn(child, 'SIGTERM'); } catch { /* 既に死んでいる */ }
      // 猶予を過ぎても生きていたら SIGKILL
      killTimer = setTimeout(() => {
        logger.warn('[Exec] still alive after SIGTERM → SIGKILL');
        try { killFn(child, 'SIGKILL'); } catch { /* 既に死んでいる */ }
      }, killGraceMs);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.on('error', (error) => {
      // 実行ファイルが無い等。握りつぶさず呼び出し元へ返す
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      finish({
        code, signal, stdout, stderr, timedOut, argv: [bin, ...args],
      });
    });

    // プロンプトは argv ではなく stdin で渡す。
    // 長文でも ARG_MAX に当たらず、ps に引用文が丸見えにならない
    if (stdin !== undefined && stdin !== null) {
      child.stdin.on('error', () => { /* 相手が先に死んだ場合の EPIPE は無視 */ });
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}
