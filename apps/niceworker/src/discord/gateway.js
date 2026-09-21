import { logger } from '../utils/logger.js';

// ⚠ 40032 "Target user is not connected to voice." を成功扱いにしてはいけない。
//
//    実機で確認した事実（2026-09-22）:
//      PATCH /guilds/{guild}/members/{user} {"mute": false}
//        → 400 {"code": 40032, "message": "Target user is not connected to voice."}
//      このときミュートは解除されず、GET すると mute: true のまま残る。
//
//    以前は「対象が居ない＝ミュートも消えている」と誤解して成功扱いにし、台帳からも
//    削除していたため、VCを抜けた人がミュートのまま取り残された。
//    現在は 'not-connected' として呼び出し側に返し、台帳に「解除待ち」で残す。
const NOT_CONNECTED_CODE = 40032;

// こちらは本当に対象が存在しないケース（サーバーを抜けた等）。打つ手が無いので台帳から外す。
// （10007 Unknown Member / 10013 Unknown User）
const GONE_CODES = new Set([10007, 10013]);

/**
 * discord.js への依存をここに閉じ込めるためのアダプタ。
 * ポモドーロの状態遷移側（pomodoro/manager.js）はこのインターフェースだけを見るので、
 * テストではスタブに差し替えられる（test/stubGateway.js）。
 */
export class DiscordGateway {
  /**
   * @param {import('discord.js').Client} client
   * @param {{guildId: string, announceChannelId: string}} options
   */
  constructor(client, { guildId, announceChannelId }) {
    this.client = client;
    this.guildId = guildId;
    this.announceChannelId = announceChannelId;
    // VCステータスAPIが連続で失敗しているか。同じ警告をログに並べないためだけのフラグで、
    // 「以後あきらめる」ためのものではない（毎回ちゃんと試す）
    this.voiceStatusFailing = false;
  }

  async #guild() {
    return this.client.guilds.cache.get(this.guildId)
      ?? await this.client.guilds.fetch(this.guildId);
  }

  async #channel(channelId) {
    return this.client.channels.cache.get(channelId)
      ?? await this.client.channels.fetch(channelId);
  }

  /** VCに今いる人のユーザーID一覧（Botは除く） */
  async listVoiceMemberIds(channelId) {
    const channel = await this.#channel(channelId);
    if (!channel?.members) return [];
    return [...channel.members.values()]
      .filter((member) => !member.user.bot)
      .map((member) => member.id);
  }

  /**
   * サーバーミュートの設定／解除。
   * @returns {Promise<'ok'|'not-connected'|'gone'>}
   *   'ok'            … 反映された
   *   'not-connected' … 相手がVCに居ないため反映できなかった（＝ミュートは残ったまま）
   *   'gone'          … 相手がサーバーに居ない
   * @throws 本当に失敗したとき（権限不足・通信エラーなど）
   */
  async setMute(userId, mute, reason) {
    const guild = await this.#guild();
    try {
      const member = await guild.members.fetch(userId);
      await member.voice.setMute(mute, reason);
      return 'ok';
    } catch (error) {
      if (error?.code === NOT_CONNECTED_CODE) return 'not-connected';
      if (GONE_CODES.has(error?.code)) return 'gone';
      throw error;
    }
  }

  // 「今VCに繋がっているか」を事前に問い合わせる関数は意図的に持たない。
  // 問い合わせてから setMute するまでの間に抜けられると結局ズレるため、
  // 実際に setMute して 'not-connected' が返るかどうかで判断する（唯一の真実）。

  async disconnect(userId, reason) {
    const guild = await this.#guild();
    try {
      const member = await guild.members.fetch(userId);
      await member.voice.disconnect(reason);
      return 'ok';
    } catch (error) {
      // 切断については 40032（VCに居ない）も目的達成なので成功扱いでよい。
      // ミュート解除と違い「やり残し」が発生しない操作のため。
      if (error?.code === NOT_CONNECTED_CODE || GONE_CODES.has(error?.code)) return 'gone';
      throw error;
    }
  }

  /** 告知チャンネルへ投稿。失敗しても本体は止めない（nullを返す） */
  async announce(content) {
    try {
      const channel = await this.#channel(this.announceChannelId);
      const message = await channel.send({ content, allowedMentions: { parse: [] } });
      return message.id;
    } catch (error) {
      logger.error('[Gateway] 告知チャンネルへ投稿できませんでした', error);
      return null;
    }
  }

  /**
   * 既存の告知を書き換える。フェーズが変わるたびに新規投稿しないための仕組み。
   * メッセージが消されている等で失敗したら false を返し、呼び出し側が新規投稿に落ちる。
   * @returns {Promise<boolean>} 編集できたか
   */
  async editAnnouncement(messageId, content) {
    try {
      const channel = await this.#channel(this.announceChannelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit({ content, allowedMentions: { parse: [] } });
      return true;
    } catch (error) {
      logger.warn(`[Gateway] 告知メッセージを編集できませんでした: ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * VC名の下に出る「ステータス」。discord.js に専用メソッドが無いので REST を直接叩く。
   *
   * ⚠ ここが唯一の「VC側の表示」手段。**VC名は絶対に変更しない**（本人の指示）。
   *   チャンネル名を書き換える実装は、戻し損ねるとサーバーの名前が壊れたまま残るうえ
   *   10分2回のレート制限にも当たる。ステータスにはその制限が無く、空文字で消せる。
   *
   * 実測（2026-09-22・本番トークン）:
   *   PUT /channels/{id}/voice-status  → 204
   *   GET /channels/{id}               → status は null で返る（**読み返せない**）
   *   そのため「今なにが出ているか」を問い合わせる実装にはしない。書くだけ。
   *
   * 失敗しても機能は止めない。残り時間は告知メッセージの <t:...:R> 側で分かるため、
   * ステータスが出せなくても実用上は困らない。
   *
   * @param {string} status 空文字 "" を渡すとステータスが消える
   * @returns {Promise<boolean>} 成功したか
   */
  async setVoiceStatus(channelId, status) {
    try {
      await this.client.rest.put(`/channels/${channelId}/voice-status`, {
        body: { status: String(status ?? '').slice(0, 500) },
      });
      if (this.voiceStatusFailing) {
        this.voiceStatusFailing = false;
        logger.info('[Gateway] VCステータスの設定が復旧しました');
      }
      return true;
    } catch (error) {
      // 権限不足・API未対応・一時的な通信エラーなど理由は色々あるが、どれも機能全体を
      // 止める理由にはならない。一時的な失敗のために恒久的に諦めることもしない
      // （以前は一度失敗すると二度と試さない作りだった）。
      // ただし25分ごとに同じ警告が並ぶとログが読めなくなるので、連続失敗は1回だけ出す。
      if (!this.voiceStatusFailing) {
        this.voiceStatusFailing = true;
        logger.warn(
          '[Gateway] VCステータスを設定できませんでした（表示だけの機能なので処理は続けます。'
          + `復旧するまで同じ警告は繰り返しません）: ${error?.message ?? error}`,
        );
      }
      return false;
    }
  }
}
