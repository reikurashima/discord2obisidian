import 'dotenv/config';

// ---- Validate required env vars ----
// 足りないまま起動すると「コンテナは生きているのに何も動かない」状態になるので、
// 起動時に落とす（既存Botと同じ方針）。
const required = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'OWNER_USER_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// NiceCraft Production の #pm チャンネル。走査レポートの既定の送り先。
// ⚠ .env に SCAN_REPORT_CHANNEL_ID が無いまま動かしても通知が止まらないよう、既定値を持たせている。
const DEFAULT_REPORT_CHANNEL_ID = '1551615960320974951';

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.GUILD_ID,
  },

  // AIに指示できるのはこの1人だけ。ロールでは判定しない（ロールは付け外しできてしまうため）
  ownerUserId: process.env.OWNER_USER_ID,

  // タスクの .md 置き場。マイポータル（別プロセス）が同じ場所を読み書きする
  stateDir: (process.env.STATE_DIR || '/data').replace(/[/\\]+$/, '') || '/data',

  reminders: {
    // 1分ごとに判定する（cron依存を足さないための素朴なティック）
    tickIntervalMs: 60 * 1000,

    // 停止していた間に過ぎてしまった「期限ちょうど」の通知を、
    // 再起動後どこまで遡って送るか。これを過ぎたものは送らずに送信済み扱いにする。
    // （期限を過ぎた未完了タスクはポータル側で赤字表示するので、Discordでは追撃しない）
    dueCatchUpWindowMs: 60 * 60 * 1000,
  },

  // 毎日の会話走査（タスク候補の自動抽出）。
  // ⚠ 既定は「無効」。SCAN_ENABLED=1 を明示したときだけ動く。
  //    本番稼働中のBotに後から足す機能なので、.env を更新し忘れたままデプロイしても
  //    今までどおりの動きのままになるほうが安全なため。
  scan: {
    enabled: process.env.SCAN_ENABLED === '1',

    // JSTの何時に走らせるか。既存の1分ティックに相乗りするので cron は足さない
    at: parseHHmmOrDefault(process.env.SCAN_AT, { hour: 9, minute: 0 }),

    // 明示的に走査から外すチャンネル（カンマ区切り）
    excludeChannelIds: csv(process.env.SCAN_EXCLUDE_CHANNEL_IDS),

    // PM Bot の通知先チャンネル。
    // ⚠ このBotは「タスクが登録されたチャンネル」へ通知を返す作りなので、
    //    通知先＝案件チャンネルそのもの。そこを丸ごと除外すると走査の意味が無くなる。
    //    フィードバックループは「Bot自身の投稿を読まない」で塞いであるので、
    //    ここは "専用の通知チャンネルを作った場合の受け皿" として残してある。
    notifyChannelIds: csv(process.env.SCAN_NOTIFY_CHANNEL_IDS),

    // カーソルが無いチャンネルを初めて読むとき、何時間ぶんまで遡るか。
    // ★ 0 **または未設定** で「期間の制限なし＝チャンネルの最初から」読む（初回バックフィル）。
    //   本人指示「基本は直近24時間でいいけど、初回は全部やるようにして」。
    //   ⚠ 効くのは **カーソルが無いチャンネル（＝一度も読んでいないチャンネル）だけ**。
    //     2回目以降はカーソル以降しか読まないので、ここを変えても過去は掘り返さない。
    firstRunHours: nonNegativeInt(process.env.SCAN_FIRST_RUN_HOURS, 0),

    // 1回の走査で1チャンネルから取る上限。超えたら新しい方を優先してカーソルは進める。
    // ⚠ カーソルが無いチャンネル（＝初回）だけはこの上限を外す。
    //    代わりに maxMessagesPerJob でジョブを分割し、1本が膨らまないようにする。
    maxMessagesPerChannel: positiveInt(process.env.SCAN_MAX_MESSAGES_PER_CHANNEL, 200),

    // 1ジョブに詰める発言数の上限。超えたぶんはジョブを分けて順番に投げる。
    // ⚠ runner は直列実行なので、1本ずつ結果を待ってから次を投げること。
    maxMessagesPerJob: positiveInt(process.env.SCAN_MAX_MESSAGES_PER_JOB, 300),

    // claude-runner のキュー（compose でマウントする）
    runnerQueueDir: (process.env.RUNNER_QUEUE_DIR || '/runner-queue').replace(/[/\\]+$/, '') || '/runner-queue',
    runnerModel: process.env.SCAN_RUNNER_MODEL || 'haiku',

    // 結果待ちの上限。超えたら「今日は失敗」として記録し、翌日に持ち越さない
    jobTimeoutMs: positiveInt(process.env.SCAN_JOB_TIMEOUT_MS, 10 * 60 * 1000),
    jobPollIntervalMs: positiveInt(process.env.SCAN_JOB_POLL_INTERVAL_MS, 2000),

    // 走査レポートの投稿先チャンネル（NiceCraft Production の #pm）。
    // ★ 候補が0件でも毎日ここに投稿する。オーナーへのDMは廃止した。
    // ⚠ このチャンネルは走査対象から自動で外す（自分の通知を読み返さないため。collect.js 参照）。
    reportChannelId: (process.env.SCAN_REPORT_CHANNEL_ID || DEFAULT_REPORT_CHANNEL_ID).trim(),

    // 1 で起動直後に1回走査する（初回バックフィルを手で走らせるための口）。
    // 既定は 0。使い終わったら .env から外す。
    runOnBoot: process.env.SCAN_RUN_ON_BOOT === '1',

    // レポートに載せるポータルのURL（任意）
    portalUrl: process.env.PORTAL_PM_URL || '',
  },
};

function csv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 0 を「意味のある値（＝制限なし）」として受け取りたい設定用。未設定・壊れた値は fallback */
function nonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** "HH:mm" を読む。壊れていても起動は止めない（走査の時刻は起動を諦めるほどの設定ではない） */
function parseHHmmOrDefault(value, fallback) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return fallback;
  return { hour, minute };
}
