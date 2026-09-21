import { relativeTag as relative, timeTag as time } from '../utils/time.js';

/**
 * 「今どのフェーズか」をDiscord上に見せる係。3段構えで、上から順に試す。
 *
 *   (a) 告知チャンネルへ <t:...:R> 付きのメッセージ  … 必ず出す。カウントダウンはDiscord任せ
 *   (b) VCチャンネルのステータス                     … 権限/API次第。駄目なら一度警告して以後スキップ
 *   (c) VCチャンネル名の変更                         … (b)が使えないときだけ。レート制限に当たったら黙って諦める
 *
 * (b)(c) はどちらも「失敗しても機能全体を止めない」。ポモドーロ本体（ミュート制御）は
 * 表示に一切依存させない。
 */
export class PhaseDisplay {
  constructor({ gateway, vcChannelId, labels, logger }) {
    this.gateway = gateway;
    this.vcChannelId = vcChannelId;
    this.labels = labels; // { work, break } — VC名に使う文字列
    this.logger = logger;
    /** VC名を戻すために、最初に見た名前を覚えておく */
    this.originalName = null;
    this.renameActive = false;
  }

  /**
   * フェーズ開始を知らせる。
   * @param {'work'|'break'} phase
   * @param {number} endsAt epoch ms
   */
  async showPhase(phase, endsAt, { memberCount } = {}) {
    const isWork = phase === 'work';
    const heading = isWork ? '## 🍅 作業開始です！' : '## ☕ 休憩タイムです！';
    const body = isWork
      ? `全員サーバーミュートにしました。終了まで ${relative(endsAt)}（${time(endsAt)}）`
      : `ミュートを解除しました。再開まで ${relative(endsAt)}（${time(endsAt)}）`;
    const footer = typeof memberCount === 'number' ? `\n参加 ${memberCount}人` : '';
    // Discordの仕様で「VCを抜けた人のミュートは解除できない」ため、参加者が驚かないよう
    // 作業開始のたびに仕様を1行添える
    const caveat = isWork
      ? '\n-# ⚠ 作業中に抜けるとミュートが残ります。次にVCに入ると自動で解除されます。'
      : '';

    // メッセージは出しっぱなしにする。Discordが <t:...:R> を勝手に数えるので編集も再送もしない
    await this.gateway.announce(`${heading}\n${body}${footer}${caveat}`);
    await this.#applyChannelIndicator(isWork ? '🍅 作業中' : '☕ 休憩中', isWork ? this.labels.work : this.labels.break);
  }

  async showFinished(reason, { pending = [] } = {}) {
    const pendingLine = pending.length > 0
      ? `\n⏳ ${pending.map((id) => `<@${id}>`).join(' ')} はVCを抜けているためミュートが残っています。次にVCに入ると自動で解除されます！`
      : '';
    await this.gateway.announce(`## ✅ ポモドーロを終了しました\n${reason}${pendingLine}`);
    await this.#clearChannelIndicator();
  }

  /**
   * 「抜けたのでミュートが残った」人への案内。
   * Discordの仕様上ここで解除する手段は無いので、せめて理由と解消方法を伝える。
   */
  async notifyPendingUnmute(userId) {
    await this.gateway.announce(
      `## ⏳ ミュートが残っています\n<@${userId}> さん — VCから抜けたため、Discordの仕様でこの場では解除できません。\n`
      + '**次にどこかのVCに入った瞬間に自動で解除します！**',
    );
  }

  /** 解除に失敗した人が出たとき。黙って終わらせないための告知 */
  async warnUnmuteFailure(userIds, detail) {
    const mentions = userIds.map((id) => `<@${id}>`).join(' ');
    await this.gateway.announce(
      `## ⚠️ ミュート解除に失敗しました\n${mentions}\n`
      + '`` ' + String(detail).slice(0, 300) + ' ``\n'
      + 'お手数ですが、サーバー設定からミュートを解除してください。',
    );
  }

  async #applyChannelIndicator(statusText, fallbackName) {
    const ok = await this.gateway.setVoiceStatus(this.vcChannelId, statusText);
    if (ok) return;

    // ここから先はフォールバック。元の名前を1回だけ控える
    if (this.originalName === null) {
      this.originalName = await this.gateway.getChannelName(this.vcChannelId);
    }
    const renamed = await this.gateway.setChannelName(this.vcChannelId, fallbackName);
    if (renamed) this.renameActive = true;
  }

  async #clearChannelIndicator() {
    // ステータスは空文字でクリアできる
    await this.gateway.setVoiceStatus(this.vcChannelId, '');

    if (this.renameActive && this.originalName) {
      const restored = await this.gateway.setChannelName(this.vcChannelId, this.originalName);
      if (restored) this.renameActive = false;
      else this.logger.warn('[Display] VC名を元に戻せませんでした（レート制限の可能性。次回の終了時に再試行します）');
    }
  }
}
