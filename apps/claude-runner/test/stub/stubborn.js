// SIGTERM を握りつぶして居座る子プロセス。
// 「SIGTERM → 5秒後 SIGKILL」の順序が本当に守られているかを、
// 本物の runProcess（executor.js）で確かめるために使う。
//
//   node stubborn.js <markerFile>

import { appendFileSync } from 'fs';

const marker = process.argv[2];

process.on('SIGTERM', () => {
  // ⚠ 意図的に終了しない。SIGKILL が来るかどうかを見るため
  appendFileSync(marker, `SIGTERM received at ${Date.now()}\n`);
});

appendFileSync(marker, `started at ${Date.now()}\n`);
process.stdout.write('I am still here\n');

// 永久に生き続ける
setInterval(() => {}, 1000);
