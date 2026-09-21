// SIGTERM の挙動を確かめるための起動ラッパー。
//
//   node test/sigterm-child.mjs
//
// ⚠ なぜラッパーが要るか:
//   Windows には本物のシグナルが無く、親から child.kill('SIGTERM') を送ると
//   ハンドラが一切走らないままプロセスが消える（TerminateProcess のため）。
//   それでは「SIGTERM を受けたときに failed/ へ落としてから終わる」ことを検証できない。
//   そこで、本物の src/index.js をそのまま起動したうえで、
//   ジョブを掴んだ瞬間に自分自身へ process.emit('SIGTERM') する。
//   Linux（本番）では docker stop が送る SIGTERM が**まったく同じハンドラ**を叩く。

import { promises as fs } from 'fs';
import path from 'path';

// 本物の runner を起動する（executor だけ RUNNER_EXECUTOR_MODULE でスタブに差し替え済み）
await import('../src/index.js');

const processingDir = path.join(process.env.QUEUE_DIR, 'pm', 'processing');
const deadline = Date.now() + 15_000;

for (;;) {
  const names = await fs.readdir(processingDir).catch(() => []);
  if (names.some((n) => n.endsWith('.json'))) break;
  if (Date.now() > deadline) {
    console.error('sigterm-child: runner がジョブを掴まなかった');
    process.exit(2);
  }
  await new Promise((r) => { setTimeout(r, 20); });
}

console.log('sigterm-child: ジョブを掴んだので SIGTERM を送る');
process.emit('SIGTERM');
