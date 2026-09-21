/**
 * Discordのタイムスタンプ記法ユーティリティ。
 *
 * <t:UNIX秒:R> と書いておくと、閲覧者のクライアント側が勝手に「あと13分」と
 * 数え続けてくれる。Botがメッセージを編集し続ける必要がなく、レート制限とも無縁。
 * 注意: 渡すのはミリ秒ではなく「秒」。1000倍ずれると西暦5万年などになる。
 */

/** @param {number} ms epoch ミリ秒 */
export function unixSeconds(ms) {
  return Math.floor(ms / 1000);
}

/** 相対表示（例: あと 5 分） */
export function relativeTag(ms) {
  return `<t:${unixSeconds(ms)}:R>`;
}

/** 時刻表示（例: 23:00） */
export function timeTag(ms) {
  return `<t:${unixSeconds(ms)}:t>`;
}

/**
 * `/call end-at` の time 引数を解釈する。
 *
 * 受け付ける形式:
 *   "23:00" / "23:00:00" / "9:5"  → 今日のその時刻。既に過ぎていれば翌日
 *   "+90m" / "+1h" / "+1h30m"     → 今からの相対
 *
 * タイムゾーンについて:
 *   ここでは new Date(...) のローカル時刻を使う。コンテナは TZ=Asia/Tokyo で動かす前提
 *   （docker-compose.yaml で必ず設定すること）。UTCで動くと9時間ずれる。
 *
 * @param {string} input
 * @param {number} nowMs
 * @returns {{ok: true, at: number} | {ok: false, reason: string}}
 */
export function parseEndTime(input, nowMs = Date.now()) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: '時刻が空です' };

  const relative = text.match(/^\+\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i);
  if (relative && (relative[1] || relative[2])) {
    const hours = Number(relative[1] ?? 0);
    const minutes = Number(relative[2] ?? 0);
    const deltaMs = (hours * 60 + minutes) * 60 * 1000;
    if (deltaMs <= 0) return { ok: false, reason: '0分後は指定できません' };
    if (deltaMs > 24 * 60 * 60 * 1000) return { ok: false, reason: '24時間より先は指定できません' };
    return { ok: true, at: nowMs + deltaMs };
  }

  const absolute = text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (absolute) {
    const hour = Number(absolute[1]);
    const minute = Number(absolute[2]);
    const second = Number(absolute[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) {
      return { ok: false, reason: '時刻の範囲がおかしいです（00:00〜23:59）' };
    }

    const base = new Date(nowMs);
    const target = new Date(
      base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, second, 0,
    );
    // 「23:00」と打った時点で既に23:10なら、意図は翌日の23:00のはず
    if (target.getTime() <= nowMs) target.setDate(target.getDate() + 1);
    return { ok: true, at: target.getTime() };
  }

  return { ok: false, reason: '形式が違います（例: `23:00` または `+90m`）' };
}

/** ログ・確認メッセージ用。ローカルタイム（=JST想定）で "2026-09-22 23:00" にする */
export function formatLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
