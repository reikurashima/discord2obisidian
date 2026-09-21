// inbox → processing の取得が本当に排他的かを確かめるための子プロセス。
//
//   node race-child.mjs <queueDir> <label> <outFile>
//
// 2つ同時に起動して、同じ inbox を全力で取り合う。
// 取れたジョブIDを outFile に書き出し、親が「重複が無いこと」を確認する。

import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { claimNextJob } from '../src/queue.js';

const [queueDir, label, outFile] = process.argv.slice(2);
const config = loadConfig({ QUEUE_DIR: queueDir, WORK_DIR: `${queueDir}/../work` });

const got = [];
const deadline = Date.now() + 10_000;
let misses = 0;

// inbox が空になる（＝空振りが続く）まで取り続ける。
// 親は子を起動する前に inbox を満たしてあるので、空振り = 取り合いが終わった合図
for (;;) {
  const claimed = await claimNextJob(config);
  if (claimed) {
    misses = 0;
    got.push(claimed.fileName);
    continue;
  }
  misses += 1;
  if (misses > 50 || Date.now() > deadline) break;
  await new Promise((r) => { setTimeout(r, 1); });
}

await fs.writeFile(outFile, JSON.stringify({ label, got }, null, 2), 'utf-8');
