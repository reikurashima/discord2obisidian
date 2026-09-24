// 検証用のスタブ executor。
//
// claude の認証が無い環境では `claude -p` を実行できないため、
// 「claude がこう返してきたら runner はどう振る舞うか」だけをここで作り分ける。
//
// ジョブの input.__stub に書いた指示で挙動を切り替える:
//   { mode: 'ok',      stdout }   正常終了（claude の封筒を模した JSON を返す）
//   { mode: 'raw',     stdout, stderr, code }  任意の生出力
//   { mode: 'timeout' }           タイムアウトしたことにする
//   { mode: 'slow', ms }          ms だけ掛かる（SIGTERM の検証用）
//   { mode: 'throw' }             executor 自体が例外を投げる
//
// 実行されたことの記録は RUNNER_STUB_LOG（JSON Lines）に残す。

import { promises as fs } from 'fs';

export function createExecutor(config) {
  return async function stubExecutor(task) {
    const spec = task.job?.input?.__stub || { mode: 'ok' };

    await record({
      jobId: task.jobId,
      cwd: task.cwd,
      outDir: task.outDir,
      model: task.model,
      timeoutSec: task.timeoutSec,
      tools: task.kindDef.tools,
      schema: task.schema.name,
      promptLength: task.prompt.length,
      mode: spec.mode,
      // 子プロセスに渡るはずの env から APIキーが消えているかを記録する
      apiKeyInParent: process.env.ANTHROPIC_API_KEY ?? null,
      // 実行時点で作業ディレクトリに何があったか（添付のコピーの確認用）
      cwdFiles: await listWithSizes(task.cwd),
      attachments: (task.attachments || []).map((a) => ({ name: a.name, path: a.path, size: a.size })),
    });

    if (spec.mode === 'throw') throw new Error('stub executor exploded');

    if (spec.mode === 'timeout') {
      return {
        code: null, signal: 'SIGKILL', stdout: '', stderr: 'stub: timed out', timedOut: true, argv: ['stub'],
      };
    }

    if (spec.mode === 'slow') {
      await new Promise((r) => { setTimeout(r, spec.ms ?? 3000); });
    }

    if (spec.mode === 'raw') {
      return {
        code: spec.code ?? 0,
        signal: null,
        stdout: spec.stdout ?? '',
        stderr: spec.stderr ?? '',
        timedOut: false,
        argv: ['stub'],
      };
    }

    // 既定: claude -p --output-format json の封筒を模して返す
    const body = spec.body !== undefined ? spec.body : { echo: 'ping' };
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: typeof body === 'string' ? body : JSON.stringify(body),
    };
    return {
      code: 0, signal: null, stdout: JSON.stringify(envelope), stderr: '', timedOut: false, argv: ['stub'],
    };
  };
}

async function listWithSizes(dir) {
  try {
    const names = (await fs.readdir(dir)).sort();
    const out = {};
    for (const n of names) {
      const st = await fs.stat(`${dir}/${n}`);
      out[n] = st.isDirectory() ? 'dir' : st.size;
    }
    return out;
  } catch { return null; }
}

async function record(entry) {
  const logPath = process.env.RUNNER_STUB_LOG;
  if (!logPath) return;
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}
