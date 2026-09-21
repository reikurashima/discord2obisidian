/**
 * プロセスをまたぐ検証。
 *   node test/lifecycle.js
 *
 * 1) クラッシュ（ミュートしたまま強制終了）→ 再起動で自動解除されるか
 * 2) SIGTERM → 全解除してから終了するか
 *
 * ⚠ Windows では SIGTERM を実際には配送できない（Node.jsの制約）。
 *    その場合はハンドラを直接叩いて同じ経路を通す。Linuxコンテナ上では本物の信号で通る。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'lifecycleWorker.js');
let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function run(mode, stateDir, { killWith = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, mode, stateDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (killWith && out.includes('READY')) {
        killWith(child);
        killWith = null;
      }
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
}

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niceworker-lifecycle-'));
  console.log(`state dir: ${stateDir}\n`);

  try {
    console.log('=== A. クラッシュ → 再起動（VC接続中の人は解除できる） ===');
    const crashed = await run('crash', stateDir);
    console.log(indent(crashed.out));
    check('異常終了している', crashed.code === 137, `exit=${crashed.code}`);

    const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'muted-members.json'), 'utf-8'));
    check('台帳に2人残っている', onDisk.muted.length === 2, JSON.stringify(onDisk.muted.map((m) => m.userId)));
    const stillMuted = JSON.parse(fs.readFileSync(path.join(stateDir, 'server-mute-state.json'), 'utf-8'));
    check('Discord側はミュートされたまま', stillMuted.length === 2, JSON.stringify(stillMuted));

    // aliceだけVCに繋がったまま再起動したケース
    const recovered = await run('recover', stateDir, { env: { CONNECTED: 'alice' } });
    console.log(indent(recovered.out));
    check('接続中のaliceは解除される', /SERVER_MUTED_AFTER_RECOVER=\["bob"\]/.test(recovered.out));
    check('⚠ 未接続のbobは台帳に残る', /REGISTRY_AFTER_RECOVER=\["bob"\]/.test(recovered.out));
    check('bobが解除待ちとして保持される', /PENDING_AFTER_RECOVER=\["bob"\]/.test(recovered.out));
    check('起動時に前回のVCステータスを消しにいく', /VOICE_STATUS_AFTER_RECOVER=""/.test(recovered.out),
      recovered.out.match(/VOICE_STATUS_AFTER_RECOVER=.*/)?.[0] ?? '(無し)');

    console.log('\n=== A-2. もう一度再起動しても解除待ちは失われない → 入室で解消 ===');
    // 誰もVCに繋がっていない状態で起動（＝今は誰も解除できない）
    const again = await run('recover', stateDir);
    console.log(indent(again.out));
    check('解除待ちが再起動をまたいで保持される', /PENDING_AFTER_RECOVER=\["bob"\]/.test(again.out));
    check('ミュートはまだ残ったまま', /SERVER_MUTED_AFTER_RECOVER=\["bob"\]/.test(again.out));

    const rejoined = await run('rejoin', stateDir);
    console.log(indent(rejoined.out));
    check('一般VCへの入室で解除される', /SERVER_MUTED_AFTER_REJOIN=\[\]/.test(rejoined.out));
    check('解除待ちが空になる', /PENDING_AFTER_REJOIN=\[\]/.test(rejoined.out));

    const finalLedger = JSON.parse(fs.readFileSync(path.join(stateDir, 'muted-members.json'), 'utf-8'));
    check('台帳が空で終わる', finalLedger.muted.length === 0, JSON.stringify(finalLedger.muted));

    console.log('\n=== B. SIGTERM → 全解除してから終了 ===');
    const stateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'niceworker-lifecycle-'));
    const onWindows = process.platform === 'win32';
    if (onWindows) {
      console.log('  (win32: 外部からの SIGTERM は配送できないため、子プロセス側で同じハンドラを踏ませる)');
    }

    const term = await run('sigterm', stateDir2, {
      env: onWindows ? { SELF_SIGTERM: '1' } : {},
      killWith: onWindows ? null : (child) => child.kill('SIGTERM'),
    });
    console.log(indent(term.out));

    check('SIGTERMで終了処理が走る', /SHUTDOWN_START/.test(term.out));
    check('全員解除してから終了', /SERVER_MUTED_AFTER_SHUTDOWN=\[\]/.test(term.out));
    check('解除→終了の順である', term.out.indexOf('SERVER_MUTED_AFTER_SHUTDOWN') < term.out.indexOf('SHUTDOWN_DONE'));
    // ★ 表示の後始末: 作業中は終了時刻つきのステータスが出ており、SIGTERMで空になる
    check('作業中はステータスに終了時刻が出ている',
      /VOICE_STATUS="🍅 作業中 〜\d{2}:\d{2}"/.test(term.out),
      term.out.match(/VOICE_STATUS=.*/)?.[0] ?? '(無し)');
    check('SIGTERMでVCステータスが空になる', /VOICE_STATUS_AFTER_SHUTDOWN=""/.test(term.out),
      term.out.match(/VOICE_STATUS_AFTER_SHUTDOWN=.*/)?.[0] ?? '(無し)');
    check('終了コード0', term.code === 0, `exit=${term.code} signal=${term.signal}`);

    const leftover = JSON.parse(fs.readFileSync(path.join(stateDir2, 'muted-members.json'), 'utf-8'));
    check('台帳が空で終わる', leftover.muted.length === 0, JSON.stringify(leftover.muted));

    fs.rmSync(stateDir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    console.log(`\ncleaned up (exists=${fs.existsSync(stateDir)})`);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

function indent(text) {
  return text.trimEnd().split('\n').map((line) => `    | ${line}`).join('\n');
}

main();
