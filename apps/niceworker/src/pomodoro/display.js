import { relativeTag as relative, timeTag as time, jstClock } from '../utils/time.js';

/**
 * 「今どのフェーズか」をDiscord上に見せる係。表示は2か所だけ。
 *
 *   (a) 告知チャンネルのメッセージ1本  … <t:...:R> 付き。カウントダウンはDiscord任せ
 *   (b) VCチャンネルのステータス       … 「🍅 作業中 〜01:39」。空文字で消える
 *
 * ⚠ **VCチャンネル名は変更しない**（本人の指示・2026-09-22）。
 *   以前は (b) が失敗したときのフォールバックとして改名する案があったが、
 *   ・戻し損ねるとサーバーのチャンネル名が壊れたまま残る
 *   ・10分に2回というレート制限がある
 *   の2点が割に合わない。ステータスが出せなかったときは**警告ログだけ**にして、
 *   残り時間は告知メッセージの <t:...:R> に任せる。実用上それで困らない。
 *   → `gateway` に改名用のメソッドは存在しない。足さないこと。
 *
 * (b) は「失敗しても機能全体を止めない」。ポモドーロ本体（ミュート制御）は
 * 表示に一切依存させない。
 *
 * ⚠ 告知は「1ポモドーロにつき1メッセージ」。
 *   フェーズが変わるたびに新規投稿すると、25分ごとにチャットが告知で埋まる。
 *   そこで最初の1本だけ投稿し、以後はそれを編集して書き換える。
 *   <t:...:R> は編集しても自動カウントダウンが効くので、これで困らない。
 *   編集に失敗したら（メッセージが消された等）新規投稿に落として機能は止めない。
 */
export class PhaseDisplay {
  constructor({ gateway, vcChannelId, logger }) {
    this.gateway = gateway;
    this.vcChannelId = vcChannelId;
    this.logger = logger;
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
    // 「状態の右に何時に終了か」を出す。ステータスは残り時間を自動で数えてくれないので、
    // 相対ではなく**終了時刻**を書く（1分ごとに書き換えるのは論外。APIを無駄に叩くだけ）
    await this.setStatus(`${isWork ? '🍅 作業中' : '☕ 休憩中'} 〜${jstClock(endsAt)}`);
  }

  async showFinished(reason) {
    // 最後の1回も編集で済ませる。終わったらメッセージを手放し、次のポモドーロは新しい1本を立てる
    await this.#publish(`## ✅ ポモドーロを終了しました\n${reason}\nおつかれさまでした！`);
    this.liveMessageId = null;
    await this.clearStatus();
  }

  /**
   * VCステータスを書く。**ここが唯一のVC側への書き込み**。
   * 失敗しても false が返るだけで例外は投げない（gateway側で握って警告ログを出す）。
   */
  async setStatus(text) {
    return this.gateway.setVoiceStatus(this.vcChannelId, text);
  }

  /**
   * ステータスを消す。空文字を入れるとDiscord側の表示が消える（実測204）。
   * ポモドーロ終了・SIGTERM・起動時（前回の残骸の掃除）から呼ぶ。
   */
  async clearStatus() {
    return this.gateway.setVoiceStatus(this.vcChannelId, '');
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
}
