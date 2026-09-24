// claude-runner クライアント（依頼側=PM Bot / マイポータル が使う薄いモジュール）
//
// ⚠ 依存パッケージを持たない素の Node で書いてある。
//    このファイルだけを相手のリポジトリへコピーしても動く（npm install 不要）。
//
// 使い方:
//   import { createRunnerClient } from './claudeRunnerClient.js';
//   const runner = createRunnerClient({ queueDir: '/queue', bot: 'pm' });
//   const { jobId } = await runner.submitJob({ kind: 'digest.extract', input, quoted, outputSchema: 'digest.v1' });
//   const result = await runner.waitForResult(jobId, { timeoutMs: 6 * 60 * 1000 });
//   if (result.status === 'ok') { /* result.output を使って自分で副作用を起こす */ }
//
// ⚠ runner は副作用を持たない。
//    ファイル作成・Discordへの投稿・タスク登録は、この結果を見て**依頼側が**行うこと。

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;

export function createRunnerClient({ queueDir, bot, healthFile } = {}) {
  if (!queueDir) throw new Error('createRunnerClient: queueDir is required');
  if (!bot) throw new Error('createRunnerClient: bot is required');

  const dirs = {
    inbox: path.join(queueDir, bot, 'inbox'),
    processing: path.join(queueDir, bot, 'processing'),
    result: path.join(queueDir, bot, 'result'),
    failed: path.join(queueDir, bot, 'failed'),
    // 添付ファイル置き場。⚠ ジョブJSONより**先に**置くこと（runner はJSONが見えた時点で読みに来る）
    files: path.join(queueDir, bot, 'files'),
  };
  const healthPath = healthFile || path.join(queueDir, 'health.json');

  /**
   * ジョブIDを作る。`<日時>-<bot>-<乱数4桁>`。
   * 時刻を先頭に置くのは、inbox を名前順に読めば投入順に捌かれるようにするため。
   */
  function newJobId(now = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    return `${stamp}-${bot}-${crypto.randomBytes(2).toString('hex')}`;
  }

  /**
   * ジョブを inbox に置く。
   * ⚠ 一時ファイルに書き切ってから rename する。
   *   直接書くと、runner が「書き込み途中のJSON」を拾って壊れたジョブとして弾いてしまう。
   */
  async function submitJob({
    kind, input = {}, quoted = [], outputSchema, model, timeoutSec, jobId, attachments,
  }) {
    if (!kind) throw new Error('submitJob: kind is required');
    if (!outputSchema) throw new Error('submitJob: outputSchema is required');

    const id = jobId || newJobId();
    const job = {
      jobId: id,
      bot,
      kind,
      createdAt: isoWithOffset(new Date()),
      timeoutSec: clamp(timeoutSec),
      input,
      quoted,
      outputSchema,
    };
    if (model) job.model = model;
    // 添付は files/ に置いたファイル名（例: `<jobId>.pdf`）。置くのは呼び出し側の責任
    if (attachments !== undefined) job.attachments = attachments;

    await fs.mkdir(dirs.inbox, { recursive: true });
    const finalPath = path.join(dirs.inbox, `${id}.json`);
    // ⚠ 拡張子を .json 以外にしておく。runner は .json しか拾わないので、
    //   rename が済むまで絶対に拾われない
    const tmpPath = path.join(dirs.inbox, `.${id}.${process.pid}.writing`);
    await fs.writeFile(tmpPath, `${JSON.stringify(job, null, 2)}\n`, 'utf-8');
    await fs.rename(tmpPath, finalPath);

    return { jobId: id, job, path: finalPath };
  }

  /** 結果があれば返す。まだなら null（例外にしない） */
  async function getResult(jobId) {
    try {
      return JSON.parse(await fs.readFile(path.join(dirs.result, `${jobId}.json`), 'utf-8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // 書き込み途中を読むことは無い（runner が tmp→rename で置く）が、
      // 壊れていたら「まだ無い」扱いにして次のポーリングに任せる
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /**
   * 結果が出るまでポーリングする。
   * ⚠ ファイル監視は使わない。NAS上の watch は ETIMEDOUT で落ちた実績があるため。
   */
  async function waitForResult(jobId, { timeoutMs = 10 * 60 * 1000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await getResult(jobId);
      if (result) return result;
      if (Date.now() >= deadline) {
        // runner 側が死んでいる場合もあるので、待ち切れなかったことを明示して返す
        return {
          jobId,
          status: 'error',
          output: null,
          errorCode: 'CLIENT_TIMEOUT',
          logTail: `依頼側が ${timeoutMs}ms 待っても result/${jobId}.json が現れませんでした。health.json を確認してください。`,
          startedAt: null,
          finishedAt: isoWithOffset(new Date()),
        };
      }
      await sleep(intervalMs);
    }
  }

  /** 投げて結果を待つところまで一気にやる */
  async function runJob(spec, waitOptions) {
    const { jobId } = await submitJob(spec);
    return waitForResult(jobId, waitOptions);
  }

  /** 稼働・認証の状態。runner が死んでいれば updatedAt が古いままになる */
  async function readHealth() {
    try {
      return JSON.parse(await fs.readFile(healthPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** 結果を読んだ後に片付けたいとき用（任意。放っておいても14日で消える） */
  async function deleteResult(jobId) {
    try { await fs.unlink(path.join(dirs.result, `${jobId}.json`)); } catch { /* 無ければ何もしない */ }
  }

  return {
    bot, dirs, healthPath, newJobId, submitJob, getResult, waitForResult, runJob, readHealth, deleteResult,
  };
}

function clamp(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.floor(n), MAX_TIMEOUT_SEC);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** ジョブJSONの createdAt は JST のオフセット付きで書く（ログを読むときに迷わないため） */
function isoWithOffset(d) {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}
