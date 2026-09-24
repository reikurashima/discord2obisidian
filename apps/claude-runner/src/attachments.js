import { createWriteStream, constants as fsConstants } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { logger } from './utils/logger.js';

// 添付ファイル（請求書PDFなど）の受け渡し。
//
//   依頼側: /queue/<bot>/files/<名前>.pdf を先に置き、そのあとジョブJSONを inbox に置く
//   runner: ジョブの attachments（= ["<jobId>.pdf"] の1件だけ）を /work/<jobId>/ にコピーして claude に読ませる
//           ジョブが終わったら（成功・失敗とも）files/ の原本を消す
//
// ⚠ 添付は機微情報（請求書＝金額・口座・取引先）。
//   「使い終わったら必ず消す」「名前は厳格に絞る」「リンクは辿らない」の3点を守る。

export const FILES_LANE = 'files';

// ⚠ ファイル名はこの形だけ許す。`..` や `/` `\` を含むもの、拡張子違いは即 rejected。
//    files/ の外を指させない（パストラバーサル対策）ための唯一の関門なので、緩めないこと。
export const ATTACHMENT_NAME_RE = /^[A-Za-z0-9_-]+\.pdf$/;

export function filesDir(config, bot) {
  return path.join(config.queueDir, bot, FILES_LANE);
}

/** そのジョブが持てる唯一の添付名。契約: `<jobId>.pdf` */
export function attachmentNameFor(jobId) {
  return `${jobId}.pdf`;
}

/**
 * ジョブJSONの attachments の形だけを見る（ファイルの有無は見ない）。
 *
 * ⚠ 許すのは `["<jobId>.pdf"]` の1要素だけ（空配列・2要素以上・別の名前は不可）。
 *   ジョブAが `B.pdf` を指定できると、Aの終了時に B の原本を消せてしまう（Bは ATTACHMENT_MISSING になる）。
 *   ジョブと添付を1対1に固定して、他のジョブの添付に触れないようにする。
 * @returns {string[]} エラーの一覧（空なら OK）
 */
export function validateAttachmentList(value, jobId) {
  if (value === undefined) return [];
  const expected = attachmentNameFor(jobId);
  if (!Array.isArray(value)) return ['attachments must be an array when present'];
  if (value.length !== 1) {
    return [`attachments must be exactly ["${expected}"] (got ${value.length} entries)`];
  }
  const [name] = value;
  if (typeof name !== 'string' || !ATTACHMENT_NAME_RE.test(name)) {
    return [`attachments[0] ${JSON.stringify(name)} is not allowed (must match ${ATTACHMENT_NAME_RE})`];
  }
  if (name !== expected) {
    return [`attachments[0] "${name}" is not allowed (must be "${expected}" = the job's own id)`];
  }
  return [];
}

/**
 * ジョブ終了時に files/ から消す名前の一覧。**そのジョブ自身の `<jobId>.pdf` だけ。**
 * ⚠ attachments に何が書いてあっても、それ以外の名前は消しにも行かない
 *   （他のジョブの添付を消さないため）。
 *   JSONが壊れていても jobId（＝ファイル名）は分かるので、原本は必ず消せる。
 */
export function cleanupNames(jobId) {
  const name = attachmentNameFor(jobId);
  return ATTACHMENT_NAME_RE.test(name) ? [name] : [];
}

// O_NOFOLLOW はシンボリックリンクを開かない（Linux=本番では有効。Windows には無いので 0）
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
const PDF_MAGIC = Buffer.from('%PDF-');
// PDF の仕様上、%PDF- はファイル先頭 1024 バイト以内に現れればよい
const MAGIC_WINDOW = 1024;

/**
 * 添付を files/ から作業ディレクトリへコピーする。
 *
 * ⚠ 開いたハンドル1本で「種類・サイズ・中身の確認」と「コピー」を行う。
 *   確認と開き直しの間にファイルを差し替えられる隙（TOCTOU）を作らないため。
 * ⚠ シンボリックリンクは辿らない。files/ に /root/.claude の資格情報へのリンクを置かれても、
 *   それを「PDF」として claude に読ませてしまわないようにする。
 *
 * @returns {Promise<{ok:true, files:{name:string, path:string, size:number}[]}
 *                  |{ok:false, status:string, errorCode:string, message:string}>}
 */
export async function stageAttachments(config, bot, names, destDir) {
  const dir = filesDir(config, bot);
  const staged = [];

  for (const name of names) {
    // validateJobShape で見ているが、ここは files/ の外を開くかどうかの最後の砦なので再確認する
    if (!ATTACHMENT_NAME_RE.test(name)) {
      return fail('rejected', 'BAD_ATTACHMENT', `attachment ${JSON.stringify(name)} is not allowed`);
    }
    const src = path.join(dir, name);

    let fh;
    try {
      fh = await fs.open(src, OPEN_FLAGS);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return fail('error', 'ATTACHMENT_MISSING', `attachment not found: ${bot}/${FILES_LANE}/${name}`);
      }
      // ELOOP = O_NOFOLLOW でシンボリックリンクを開こうとした
      if (error.code === 'ELOOP') {
        return fail('rejected', 'BAD_ATTACHMENT', `attachment ${name} is a symbolic link (not allowed)`);
      }
      // EISDIR = 同名のディレクトリが置かれていた（Windows では open 時点で落ちる）
      if (error.code === 'EISDIR') {
        return fail('rejected', 'BAD_ATTACHMENT', `attachment ${name} is not a regular file`);
      }
      throw error;
    }

    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        return fail('rejected', 'BAD_ATTACHMENT', `attachment ${name} is not a regular file`);
      }
      // Windows では O_NOFOLLOW が効かないので lstat でも見ておく（本番では上で弾かれる）
      const lst = await fs.lstat(src).catch(() => null);
      if (lst && lst.isSymbolicLink()) {
        return fail('rejected', 'BAD_ATTACHMENT', `attachment ${name} is a symbolic link (not allowed)`);
      }
      if (st.size > config.maxAttachmentBytes) {
        return fail(
          'rejected',
          'ATTACHMENT_TOO_LARGE',
          `attachment ${name} is ${st.size} bytes (limit ${config.maxAttachmentBytes} bytes)`,
        );
      }
      if (st.size === 0) {
        return fail('rejected', 'BAD_ATTACHMENT', `attachment ${name} is empty`);
      }

      // 中身が本当に PDF か（拡張子だけでは信用しない）
      const head = Buffer.alloc(Math.min(MAGIC_WINDOW, st.size));
      await fh.read({ buffer: head, position: 0 });
      if (head.indexOf(PDF_MAGIC) === -1) {
        return fail('rejected', 'BAD_ATTACHMENT', `attachment ${name} does not look like a PDF (no %PDF- header)`);
      }

      const dest = path.join(destDir, name);
      // 位置 0 から読み直す。'wx' = 作業ディレクトリに同名があれば失敗（上書きしない）
      await pipeline(
        fh.createReadStream({ start: 0, autoClose: false }),
        createWriteStream(dest, { flags: 'wx' }),
      );
      staged.push({ name, path: dest, size: st.size });
    } finally {
      await fh.close().catch(() => {});
    }
  }

  return { ok: true, files: staged };
}

/**
 * files/ の原本を消す。ジョブが終わったら成功・失敗を問わず呼ぶ。
 * 無いものは黙って飛ばす。消せなかったものはログに残す（処理は止めない）。
 */
export async function deleteAttachments(config, bot, names) {
  const deleted = [];
  for (const name of names || []) {
    if (!ATTACHMENT_NAME_RE.test(name)) continue; // 不正な名前は消しにも行かない
    try {
      await fs.unlink(path.join(filesDir(config, bot), name));
      deleted.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`[Files] could not delete ${bot}/${FILES_LANE}/${name}: ${error.message}`);
    }
  }
  if (deleted.length > 0) logger.info(`[Files] deleted ${bot}/${FILES_LANE}/{${deleted.join(', ')}}`);
  return deleted;
}

function fail(status, errorCode, message) {
  return {
    ok: false, status, errorCode, message,
  };
}
