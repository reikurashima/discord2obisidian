import { relativeTag as relative, timeTag as time } from '../utils/time.js';

/**
 * 「今どのフェーズか」をDiscord上に見せる係。3段構えで、上から順に試す。
 *
 *   (a) 告知チャンネルのメッセージ1本  … <t:...:R> 付き。カウントダウンはDiscord任せ
 *   (b) VCチャンネルのステータス       … 権限/API次第。駄目なら一度警告して以後スキップ
 *   (c) VCチャンネル名の変更           … (b)が使えないときだけ。レート制限に当たったら黙って諦める
 *
 * (b)(c) はどちらも「失敗しても機能全体を止めない」。ポモドーロ本体（ミュート制御）は
 * 表示に一切依存させない。
 *
 * ⚠ 告知は「1ポモドーロにつき1メッセージ」。
 *   フェーズが変わるたびに新規投稿すると、25分ごとにチャットが告知で埋まる。
 *   そこで最初の1本だけ投稿し、以後はそれを編集して書き換える。
 *   <t:...:R> は編集しても自動カウントダウンが効くので、これで困らない。
 *   編集に失敗したら（メッセージが消された等）新規投稿に落として機能は止めない。
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
    /** 今のポモドーロで使い回している告知メッセージのID。終了したら手放す */
    this.liveMessageId = null;
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

    await this.#publish(`${heading}\n${body}${footer}${caveat}`);
    await this.#applyChannelIndicator(isWork ? '🍅 作業中' : '☕ 休憩中', isWork ? this.labels.work : this.labels.break);
  }

  async showFinished(reason) {
    // 最後の1回も編集で済ませる。終わったらメッセージを手放し、次のポモドーロは新しい1本を立てる
    await this.#publish(`## ✅ ポモドーロを終了しました\n${reason}\nおつかれさまでした！`);
    this.liveMessageId = null;
    await this.#clearChannelIndicator();
  }

  /**
   * 告知を1本に保つ。既存があれば編集、無ければ（または編集に失敗したら）新規投稿。
   * 編集の失敗理由は「メッセージが消された」「権限が変わった」など様々だが、
   * どれも機能を止める理由にはならないので必ず投稿側へ落ちる。
   */
  async #publish(content) {
    if (this.liveMessageId) {
      const edited = await this.gateway.editAnnouncement(this.liveMessageId, content);
      if (edited) return;
      this.logger.warn('[Display] 告知メッセージを編集できませんでした。新規投稿に切り替えます');
      this.liveMessageId = null;
    }
    // announce は失敗すると null を返す。その場合は次回また新規投稿を試みる
    this.liveMessageId = await this.gateway.announce(content);
  }

  /** 解除に失敗した人が出たとき。埋もれては困るので、これだけは常に新規投稿にする */
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
