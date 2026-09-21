import { relativeTag, timeTag, formatLocal } from '../utils/time.js';

// 事前告知のタイミング。ここを増やしても実装は変えなくてよい
const WARN_OFFSETS_MS = [5 * 60 * 1000, 60 * 1000];

/**
 * 通話の終了予約（`/call end-at`）。
 * 予約は同時に1件だけ。オーナー専用コマンドなので取り合いは起きない。
 */
export class CallScheduler {
  constructor({ gateway, logger, timers = { setTimeout, clearTimeout }, now = () => Date.now() }) {
    this.gateway = gateway;
    this.logger = logger;
    this.timers = timers;
    this.now = now;

    /** @type {{channelId: string, endsAt: number, requestedBy: string}|null} */
    this.reservation = null;
    this.timerIds = [];
  }

  /**
   * @returns {{ok: true, endsAt: number} | {ok: false, reason: string}}
   */
  schedule({ channelId, endsAt, requestedBy }) {
    const remaining = endsAt - this.now();
    if (remaining <= 0) return { ok: false, reason: '過去の時刻は予約できません' };

    this.cancel({ silent: true });
    this.reservation = { channelId, endsAt, requestedBy };

    for (const offset of WARN_OFFSETS_MS) {
      const delay = remaining - offset;
      // 予約が5分以内なら「5分前告知」はもう打てない。黙って飛ばす
      if (delay <= 0) continue;
      this.timerIds.push(this.timers.setTimeout(() => {
        this.#announceWarning(offset).catch((error) => {
          this.logger.error('[Call] 事前告知に失敗', error);
        });
      }, delay));
    }

    this.timerIds.push(this.timers.setTimeout(() => {
      this.#finish().catch((error) => {
        this.logger.error('[Call] 切断処理に失敗', error);
      });
    }, remaining));

    this.logger.info(`[Call] 終了予約: ${formatLocal(endsAt)} (VC: ${channelId}, 依頼: ${requestedBy})`);
    return { ok: true, endsAt };
  }

  cancel({ silent = false } = {}) {
    const had = this.reservation !== null;
    for (const id of this.timerIds) this.timers.clearTimeout(id);
    this.timerIds = [];
    this.reservation = null;
    if (had && !silent) this.logger.info('[Call] 終了予約を取り消しました');
    return had;
  }

  statusText() {
    if (!this.reservation) return null;
    return `<#${this.reservation.channelId}> は ${timeTag(this.reservation.endsAt)}（${relativeTag(this.reservation.endsAt)}）に終了予定です`;
  }

  async #announceWarning(offsetMs) {
    if (!this.reservation) return;
    const minutes = Math.round(offsetMs / 60000);
    await this.gateway.announce(
      `## 🔔 あと${minutes}分で通話を終了します\n`
      + `<#${this.reservation.channelId}> / 終了 ${timeTag(this.reservation.endsAt)}（${relativeTag(this.reservation.endsAt)}）`,
    );
  }

  async #finish() {
    const reservation = this.reservation;
    if (!reservation) return;
    // 先にクリアしておく。切断中に例外が出ても予約が残り続けないように
    this.cancel({ silent: true });

    let members = [];
    try {
      members = await this.gateway.listVoiceMemberIds(reservation.channelId);
    } catch (error) {
      this.logger.error('[Call] 在室者を取得できませんでした', error);
    }

    const failed = [];
    for (const userId of members) {
      try {
        await this.gateway.disconnect(userId, '通話の終了予約');
      } catch (error) {
        failed.push(userId);
        this.logger.error(`[Call] ${userId} を切断できませんでした`, error);
      }
    }

    const note = failed.length > 0
      ? `\n⚠️ ${failed.length}人を切断できませんでした（権限をご確認ください）`
      : '';
    await this.gateway.announce(
      `## 🔚 通話を終了しました\n<#${reservation.channelId}> の ${members.length}人を切断しました。おつかれさまでした！${note}`,
    );
  }
}
