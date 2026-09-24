import path from 'path';

// 環境変数は「起動時に1回読んで固める」。
// ⚠ ここでは throw しない（必須の環境変数が無い設計にしてある）。
//    パスだけは既定値を持たせ、compose のマウント先と合わせること。

export const DEFAULT_TIMEOUT_SEC = 300;
export const MAX_TIMEOUT_SEC = 900;

export function loadConfig(env = process.env) {
  const queueDir = stripTrailingSep(env.QUEUE_DIR || '/queue');

  return {
    // <QUEUE_DIR>/<bot>/{inbox,processing,result,failed}
    queueDir,

    // health.json は queue の隣に置く（依頼側が同じマウントから読めるように）
    healthFile: env.HEALTH_FILE || path.join(queueDir, 'health.json'),

    // ジョブごとの使い捨て作業ディレクトリの親。
    // ⚠ /queue の下に作らないこと。依頼側が inbox を漁るときにノイズになる
    workDir: stripTrailingSep(env.WORK_DIR || '/work'),

    // claude 実行ファイル。コンテナ内では npm i -g で入る `claude`
    claudeBin: env.CLAUDE_BIN || 'claude',

    // inbox を見に行く間隔。ファイル監視はNAS上で ETIMEDOUT で落ちた実績があるので
    // 素朴なポーリングにしてある（1〜2秒遅れても困らない用途）
    pollIntervalMs: toInt(env.POLL_INTERVAL_MS, 2000),

    // health.json の更新間隔（要件: 60秒ごと）
    healthIntervalMs: toInt(env.HEALTH_INTERVAL_MS, 60 * 1000),

    // 認証の疎通確認の間隔（要件: 1日1回。加えて AUTH 失敗時にも即実行する）
    authCheckIntervalMs: toInt(env.AUTH_CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000),

    // result / failed の保持日数
    retentionDays: toInt(env.RETENTION_DAYS, 14),
    purgeIntervalMs: toInt(env.PURGE_INTERVAL_MS, 24 * 60 * 60 * 1000),

    defaultTimeoutSec: DEFAULT_TIMEOUT_SEC,
    maxTimeoutSec: MAX_TIMEOUT_SEC,

    // タイムアウト時 SIGTERM を送ってから SIGKILL するまでの猶予
    killGraceMs: toInt(env.KILL_GRACE_MS, 5000),

    // 未設定ならログだけ出して黙る（通知の失敗で本体を止めない方針）
    webhookUrl: env.RUNNER_WEBHOOK_URL || '',

    // logTail に残す文字数（要件: 末尾2000文字まで）
    logTailChars: toInt(env.LOG_TAIL_CHARS, 2000),

    // 添付ファイル（files/）1件あたりの上限。超えたら rejected（既定 20MB）
    maxAttachmentBytes: toInt(env.MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024),

    // 対応するジョブが無い files/ の中身を「孤児」とみなして消すまでの猶予（既定 1時間）。
    // ⚠ 依頼側は「PDFを置く → JSONを置く」の順なので、その隙間で消さないよう猶予を持たせる
    orphanFileAgeMs: toInt(env.ORPHAN_FILE_AGE_MS, 60 * 60 * 1000),
  };
}

function toInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stripTrailingSep(p) {
  return p.replace(/[/\\]+$/, '') || p;
}
