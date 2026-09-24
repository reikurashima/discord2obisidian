// 本物の `claude` の代わりに起動する偽物（検証用）。
//
//   node fake-claude.mjs <claude に渡るはずの引数...>
//
// 本物の runProcess（executor.js）から子プロセスとして起動され、
// 「実際にどんな引数・cwd・プロンプトで起動されたか」「cwd から添付PDFが読めたか」を
// FAKE_CLAUDE_LOG（JSON Lines）に記録し、claude -p --output-format json の封筒を模して返す。
// 返す本文は FAKE_CLAUDE_BODY（JSON文字列）。

import { appendFileSync, readdirSync, readFileSync } from 'fs';

let prompt = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const cwd = process.cwd();
  const pdfs = readdirSync(cwd).filter((n) => n.endsWith('.pdf'));
  const readable = {};
  for (const n of pdfs) {
    // cwd 相対（./<名前>）で開けること＝「作業ディレクトリの中だけで完結する」ことの確認
    const head = readFileSync(`./${n}`).subarray(0, 5).toString('latin1');
    readable[n] = head;
  }
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({
      argv: process.argv.slice(2),
      cwd,
      cwdFiles: readdirSync(cwd).sort(),
      pdfHeads: readable,
      promptLength: prompt.length,
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    })}\n`);
  }
  const body = process.env.FAKE_CLAUDE_BODY || '{}';
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: body,
  }));
});
