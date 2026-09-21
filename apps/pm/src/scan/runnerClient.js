import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

// claude-runner へジョブを投げるための薄いクライアント。
//
// ⚠ これは `apps/claude-runner/src/client/index.js` の写し（必要な部分だけ）。
//    runner 側は本番稼働中なので編集せず、依頼側である PM Bot に同等の実装を置いている。
//    プロトコル（ディレクトリ構成・ジョブJSONの形・tmp→rename）を変えないこと。
//
// ⚠ runner は副作用を持たない。
//    タスクの作成も Discord への投稿も、結果を見た依頼側（このBot）が行う。

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;

export function createRunnerClient({ queueDir, bot = 'pm' } = {}) {
  if (!queueDir) throw new Error('createRunnerClient: queueDir is required');

  const dirs = {
    inbox: path.join(queueDir, bot, 'inbox'),
    result: path.join(queueDir, bot, 'result'),
  };
  const healthPath = path.join(queueDir, 'health.json');

  /** `<日時>-<bot>-<乱数4桁>`。時刻が先頭なので inbox を名前順に読めば投入順になる */
  function newJobId(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    return `${stamp}-${bot}-${crypto.randomBytes(2).toString('hex')}`;
  }

  /**
   * ジョブを inbox に置く。
   * ⚠ 一時ファイルに書き切ってから rename する。直接書くと runner が
   *   「書き込み途中のJSON」を拾って壊れたジョブとして弾く。
   *   一時ファイルの拡張子は .json 以外にする（runner は .json しか拾わない）。
   */
  async function submitJob({
    kind, input = {}, quoted = [], outputSchema, model, timeoutSec,
  }) {
    if (!kind) throw new Error('submitJob: kind is required');
    if (!outputSchema) throw new Error('submitJob: outputSchema is required');

    const jobId = newJobId();
    const job = {
      jobId,
      bot,
      kind,
      createdAt: isoWithOffset(new Date()),
      timeoutSec: clamp(timeoutSec),
      input,
      quoted,
      outputSchema,
    };
    if (model) job.model = model;

    await fs.mkdir(dirs.inbox, { recursive: true });
    const finalPath = path.join(dirs.inbox, `${jobId}.json`);
    const tmpPath = path.join(dirs.inbox, `.${jobId}.${process.pid}.writing`);
    await fs.writeFile(tmpPath, `${JSON.stringify(job, null, 2)}\n`, 'utf-8');
    await fs.rename(tmpPath, finalPath);

    return { jobId, job, path: finalPath };
  }

  /** 結果があれば返す。まだなら null（例外にしない） */
  async function getResult(jobId) {
    try {
      return JSON.parse(await fs.readFile(path.join(dirs.result, `${jobId}.json`), 'utf-8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // 壊れていたら「まだ無い」扱いにして次のポーリングに任せる
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /**
   * 結果が出るまでポーリングする。
   * ⚠ ファイル監視は使わない。NAS上の watch は ETIMEDOUT で落ちた実績があるため。
   */
  async function waitForResult(jobId, { timeoutMs = 10 * 60 * 1000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await getResult(jobId);
      if (result) return result;
      if (Date.now() >= deadline) {
        return {
          jobId,
          status: 'error',
          output: null,
          errorCode: 'CLIENT_TIMEOUT',
          logTail: `依頼側が ${timeoutMs}ms 待っても result/${jobId}.json が現れませんでした。health.json を確認してください。`,
        };
      }
      await sleep(intervalMs);
    }
  }

  async function runJob(spec, waitOptions) {
    const { jobId } = await submitJob(spec);
    return waitForResult(jobId, waitOptions);
  }

  /** runner が生きているか。死んでいれば updatedAt が古いままになる */
  async function readHealth() {
    try {
      return JSON.parse(await fs.readFile(healthPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  return { bot, dirs, healthPath, submitJob, getResult, waitForResult, runJob, readHealth };
}

function clamp(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.floor(n), MAX_TIMEOUT_SEC);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** createdAt はローカル（JST）のオフセット付きで書く。ログを読むときに迷わないため */
function isoWithOffset(d) {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}
