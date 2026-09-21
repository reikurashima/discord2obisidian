import { logger } from '../utils/logger.js';

// Discord側の「もう対象が存在しない／VCに居ない」系エラーコード。
// 解除しようとした相手が既に居ないなら、ミュート状態も一緒に消えているので成功扱いでよい。
// （10007 Unknown Member / 10013 Unknown User / 40032 Target user is not connected to voice）
const GONE_CODES = new Set([10007, 10013, 40032]);

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
    // VCステータスAPIは専用権限(SET_VOICE_CHANNEL_STATUS)が要る上、
    // discord.jsのバージョンによっては未対応。失敗したら一度だけ警告して以後黙って諦める
    this.voiceStatusDisabled = false;
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
   * @returns {Promise<'ok'|'gone'>} 'gone' = 対象がもう居ないため解除不要だった
   * @throws 本当に失敗したとき（権限不足・通信エラーなど）
   */
  async setMute(userId, mute, reason) {
    const guild = await this.#guild();
    try {
      const member = await guild.members.fetch(userId);
      await member.voice.setMute(mute, reason);
      return 'ok';
    } catch (error) {
      if (GONE_CODES.has(error?.code)) return 'gone';
      throw error;
    }
  }

  async disconnect(userId, reason) {
    const guild = await this.#guild();
    try {
      const member = await guild.members.fetch(userId);
      await member.voice.disconnect(reason);
      return 'ok';
    } catch (error) {
      if (GONE_CODES.has(error?.code)) return 'gone';
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
   * VC名の下に出る「ステータス」。discord.js に専用メソッドが無いので REST を直接叩く。
   * @returns {Promise<boolean>} 成功したか
   */
  async setVoiceStatus(channelId, status) {
    if (this.voiceStatusDisabled) return false;

    try {
      await this.client.rest.put(`/channels/${channelId}/voice-status`, {
        body: { status: status.slice(0, 500) },
      });
      return true;
    } catch (error) {
      // 権限不足・API未対応など理由は色々あるが、どれも機能全体を止める理由にはならない。
      // うるさくならないよう一度だけ警告して、以後はVC名変更にフォールバックする
      this.voiceStatusDisabled = true;
      logger.warn(
        `[Gateway] VCステータスを設定できませんでした（以後スキップしVC名変更に切り替えます）: ${error?.message ?? error}`,
      );
      return false;
    }
  }

  async getChannelName(channelId) {
    const channel = await this.#channel(channelId);
    return channel?.name ?? null;
  }

  /**
   * VC名の変更。10分に2回までのレート制限があり、当たると待たされる。
   * 落とす価値はないので黙って諦める（既存の告知メッセージで残り時間は分かる）。
   * @returns {Promise<boolean>} 成功したか
   */
  async setChannelName(channelId, name) {
    try {
      const channel = await this.#channel(channelId);
      // レート制限に当たったとき discord.js は既定で待ち続けてしまうため、
      // 待ち時間が長いリクエストはこちら側で打ち切る
      await channel.setName(name);
      return true;
    } catch (error) {
      logger.warn(`[Gateway] VC名を変更できませんでした（スキップします）: ${error?.message ?? error}`);
      return false;
    }
  }
}
