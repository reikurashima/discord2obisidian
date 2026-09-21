/**
 * テスト用のスタブ一式。
 * 実際のDiscordには繋がないので、gateway と タイマー を差し替えて状態遷移だけを動かす。
 */

const flush = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** 時間を進められる偽タイマー。25分待たずに遷移を確認するため */
export class FakeClock {
  constructor(startMs) {
    this.nowMs = startMs;
    this.seq = 0;
    this.timers = new Map();

    this.now = () => this.nowMs;
    this.setTimeout = (fn, delay) => {
      const id = ++this.seq;
      this.timers.set(id, { at: this.nowMs + Math.max(0, delay || 0), fn });
      return id;
    };
    this.clearTimeout = (id) => { this.timers.delete(id); };
  }

  get timerApi() {
    return { setTimeout: this.setTimeout, clearTimeout: this.clearTimeout };
  }

  async advance(ms) {
    const target = this.nowMs + ms;
    for (;;) {
      await flush();
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowMs = due[1].at;
      due[1].fn();
      await flush();
    }
    this.nowMs = target;
    await flush();
  }
}

/** ログを溜めるだけのロガー（必要なら echo で標準出力にも出す） */
export function createLogger(echo = false) {
  const lines = [];
  const make = (level) => (msg, err) => {
    const text = `[${level}] ${msg}${err ? ` :: ${err.message ?? err}` : ''}`;
    lines.push(text);
    if (echo) console.log(`    ${text}`);
  };
  return { lines, info: make('INFO'), warn: make('WARN'), error: make('ERROR') };
}

/**
 * Discordの代わり。**本物のAPIの挙動を再現する**ことが目的。
 *
 *  - connections: userId → 今いるVCのID（サーバー全体。ポモドーロVCに限らない）
 *  - serverMuted: サーバーミュートされている人（＝Botが正しく解除できたかの答え合わせ）
 *
 * ⚠ 最重要の再現ポイント:
 *   VCに接続していない相手への setMute は **'not-connected' を返し、ミュート状態を変えない**。
 *   実機の 400 / code 40032 "Target user is not connected to voice." と同じ振る舞い。
 */
export class StubGateway {
  constructor({ vcChannelId, channelName = '作業部屋' } = {}) {
    this.vcChannelId = vcChannelId;
    this.channelName = channelName;
    /** @type {Map<string, string>} userId → channelId */
    this.connections = new Map();
    this.serverMuted = new Set();
    /** 新規投稿された本文（＝チャットに増えたメッセージの数） */
    this.announcements = [];
    /** 編集された本文（チャットは増えない） */
    this.edits = [];
    /** @type {Map<string, string>} messageId → 現在の本文 */
    this.messages = new Map();
    this.messageSeq = 0;
    this.voiceStatuses = [];
    this.renames = [];
    this.disconnected = [];

    // 失敗注入用
    this.failVoiceStatus = false;
    this.failRename = false;
    this.failEdit = false;
    this.failUnmuteFor = new Set();
    this.voiceStatusDisabled = false;
    this.voiceStatusWarnCount = 0;
  }

  /** 今チャットに見えている本文（編集後の最新） */
  liveTexts() {
    return [...this.messages.values()];
  }

  /** @param {string} channelId 既定はポモドーロVC。別のVCも指定できる */
  join(userId, channelId = this.vcChannelId) { this.connections.set(userId, channelId); }

  /** VCから完全に切断する（＝以後 setMute は 40032 になる） */
  leave(userId) { this.connections.delete(userId); }

  isConnected(userId) { return this.connections.has(userId); }

  async listVoiceMemberIds(channelId = this.vcChannelId) {
    return [...this.connections.entries()]
      .filter(([, cid]) => cid === channelId)
      .map(([userId]) => userId);
  }

  async setMute(userId, mute) {
    if (this.failUnmuteFor.has(userId) && !mute) {
      throw new Error(`stub: unmute failed for ${userId}`);
    }
    // ⚠ 実機と同じ: VCに繋がっていない相手には反映できない（ミュートは残ったまま）
    if (!this.connections.has(userId)) return 'not-connected';

    if (mute) this.serverMuted.add(userId);
    else this.serverMuted.delete(userId);
    return 'ok';
  }

  async disconnect(userId) {
    this.disconnected.push(userId);
    this.connections.delete(userId);
    return 'ok';
  }

  async announce(content) {
    const id = `msg-${++this.messageSeq}`;
    this.announcements.push(content);
    this.messages.set(id, content);
    return id;
  }

  async editAnnouncement(messageId, content) {
    // メッセージが消された／権限が無い等を再現する
    if (this.failEdit || !this.messages.has(messageId)) return false;
    this.messages.set(messageId, content);
    this.edits.push(content);
    return true;
  }

  async setVoiceStatus(channelId, status) {
    if (this.voiceStatusDisabled) return false;
    if (this.failVoiceStatus) {
      // 実装と同じく「一度だけ警告して以後スキップ」を再現する
      this.voiceStatusDisabled = true;
      this.voiceStatusWarnCount += 1;
      return false;
    }
    this.voiceStatuses.push(status);
    return true;
  }

  async getChannelName() {
    return this.channelName;
  }

  async setChannelName(channelId, name) {
    if (this.failRename) {
      // 実装側が握りつぶす（落ちない）ことの確認用。gateway実体も false を返す設計
      this.renames.push(`RATE_LIMITED(${name})`);
      return false;
    }
    this.channelName = name;
    this.renames.push(name);
    return true;
  }
}
