// claude-runner のスタブ。
// 実物と同じ約束ごと（inbox の .json を拾う / result に jobId.json を tmp→rename で置く）
// だけを再現する。ジョブJSONは __jobs に溜まるので、テスト側が中身を検証できる。

import { promises as fs } from 'fs';
import path from 'path';

export function startStubRunner(queueDir, { bot = 'pm', respond } = {}) {
  const inbox = path.join(queueDir, bot, 'inbox');
  const result = path.join(queueDir, bot, 'result');
  const jobs = [];
  // ⚠ 共有ドライブ上では unlink が一時的に失敗することがある。
  //    そのまま次のポーリングで同じジョブを拾うと二重処理になるので、jobId で覚えておく。
  const processed = new Set();
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;
    let names = [];
    try { names = await fs.readdir(inbox); } catch { return; }

    for (const name of names) {
      if (!name.endsWith('.json')) continue; // 書き込み途中の一時ファイルは拾わない
      const from = path.join(inbox, name);
      let job;
      try {
        job = JSON.parse(await fs.readFile(from, 'utf-8'));
      } catch { continue; }
      await fs.unlink(from).catch(() => {});
      if (processed.has(job.jobId)) continue; // 消し損ねたファイルを拾い直しただけ
      processed.add(job.jobId);
      jobs.push(job);

      const payload = await respond(job, jobs.length);
      await fs.mkdir(result, { recursive: true });
      const dest = path.join(result, `${job.jobId}.json`);
      const tmp = `${dest}.writing`;
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      await fs.rename(tmp, dest);
    }
  }, 20);

  return {
    jobs,
    stop() { stopped = true; clearInterval(timer); },
  };
}

export function okResult(jobId, candidates) {
  return {
    jobId, status: 'ok', output: { candidates }, errorCode: null, logTail: '',
  };
}

export function errorResult(jobId, errorCode, logTail) {
  return {
    jobId, status: 'error', output: null, errorCode, logTail,
  };
}
