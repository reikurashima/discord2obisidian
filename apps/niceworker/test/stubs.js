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
 * Discordの代わり。
 *  - voiceMembers: VCに今いる人（テストから出し入れする）
 *  - serverMuted : サーバーミュートされている人（＝Botが正しく解除できたかの答え合わせ）
 */
export class StubGateway {
  constructor({ vcChannelId, channelName = '作業部屋' } = {}) {
    this.vcChannelId = vcChannelId;
    this.channelName = channelName;
    this.voiceMembers = new Set();
    this.serverMuted = new Set();
    this.announcements = [];
    this.voiceStatuses = [];
    this.renames = [];
    this.disconnected = [];

    // 失敗注入用
    this.failVoiceStatus = false;
    this.failRename = false;
    this.failUnmuteFor = new Set();
    this.voiceStatusDisabled = false;
    this.voiceStatusWarnCount = 0;
  }

  join(userId) { this.voiceMembers.add(userId); }
  leave(userId) { this.voiceMembers.delete(userId); }

  async listVoiceMemberIds() {
    return [...this.voiceMembers];
  }

  async setMute(userId, mute) {
    if (!mute && this.failUnmuteFor.has(userId)) {
      throw new Error(`stub: unmute failed for ${userId}`);
    }
    if (mute) this.serverMuted.add(userId);
    else this.serverMuted.delete(userId);
    return 'ok';
  }

  async disconnect(userId) {
    this.disconnected.push(userId);
    this.voiceMembers.delete(userId);
    return 'ok';
  }

  async announce(content) {
    this.announcements.push(content);
    return `msg-${this.announcements.length}`;
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
