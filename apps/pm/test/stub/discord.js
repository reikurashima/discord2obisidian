// discord.js のスタブ。
// Botが実際に使っている面（Client / channels.fetch / send / REST.put / 定数）だけを再現する。
// 送信内容は __sentMessages に溜まるので、テスト側が文面とメンションを検証できる。
//
// 会話走査の検証のために、ギルド・カテゴリ・メッセージ履歴・DM も再現している。
//   __guild      : guilds.fetch() が返すギルド（チャンネル一覧つき）
//   __messages   : channelId → メッセージ配列（古い順に push しておく）
//   __dms        : users.fetch().send() の送信内容
//   __fetchCalls : messages.fetch の呼び出し記録（ページングの検証用）

import { EventEmitter } from 'node:events';

export const __sentMessages = [];
export const __dms = [];
export const __registeredCommands = [];
export const __fetchCalls = [];

export const ChannelType = {
  GuildText: 0,
  GuildVoice: 2,
  GuildCategory: 4,
};

/** チャンネル定義。parentId でカテゴリにぶら下げる */
export const __channels = new Map([
  ['chan-1', { id: 'chan-1', name: '案件A', type: ChannelType.GuildText, parentId: 'cat-active' }],
  ['chan-2', { id: 'chan-2', name: '案件B', type: ChannelType.GuildText, parentId: 'cat-active' }],
]);

/** channelId → メッセージ配列（古い順） */
export const __messages = new Map();

export function __resetStub() {
  __sentMessages.length = 0;
  __dms.length = 0;
  __fetchCalls.length = 0;
  __messages.clear();
}

/** テストからチャンネルを足す */
export function __addChannel(def) {
  __channels.set(def.id, { type: ChannelType.GuildText, parentId: null, ...def });
}

/**
 * テストからメッセージを足す。
 * id は Snowflake 風の数値文字列（大小比較がそのまま時系列になる形）。
 */
export function __addMessage(channelId, message) {
  if (!__messages.has(channelId)) __messages.set(channelId, []);
  __messages.get(channelId).push(message);
}

export const GatewayIntentBits = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  MessageContent: 1 << 15,
};

export const MessageFlags = {
  Ephemeral: 1 << 6,
};

export const Routes = {
  applicationGuildCommands: (appId, guildId) => `/applications/${appId}/guilds/${guildId}/commands`,
};

export class REST {
  constructor(options) { this.options = options; }

  setToken(token) { this.token = token; return this; }

  async put(route, { body }) {
    __registeredCommands.length = 0;
    __registeredCommands.push(...body);
    return body;
  }
}

function sendable(id, meta) {
  return {
    ...meta,
    send: async (payload) => {
      __sentMessages.push({ channelId: id, ...payload });
      return { id: `msg-${__sentMessages.length}` };
    },
    messages: {
      // 実物と同じく「新しい順」の Collection 風オブジェクトを返す
      fetch: async (options = {}) => {
        __fetchCalls.push({ channelId: id, ...options });
        const all = [...(__messages.get(id) || [])].sort((a, b) => cmp(b.id, a.id));
        let list = all;
        if (options.before) list = list.filter((m) => cmp(m.id, options.before) < 0);
        if (options.after) list = list.filter((m) => cmp(m.id, options.after) > 0);
        return new Map(list.slice(0, options.limit ?? 50).map((m) => [m.id, m]));
      },
    },
  };
}

function cmp(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

export class Client extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.user = null;

    this.channels = {
      fetch: async (id) => {
        const meta = __channels.get(id);
        if (!meta) throw new Error(`Unknown channel ${id}`);
        return sendable(id, meta);
      },
    };

    this.users = {
      fetch: async (id) => ({
        id,
        send: async (payload) => {
          __dms.push({ userId: id, ...payload });
          return { id: `dm-${__dms.length}` };
        },
      }),
    };

    this.guilds = {
      fetch: async (guildId) => ({
        id: guildId,
        members: { me: { id: this.user?.id } },
        channels: {
          // discord.js の GuildChannelManager#fetch() と同じく Collection を返す
          fetch: async () => new Map(
            [...__channels.entries()].map(([id, meta]) => [id, sendable(id, meta)]),
          ),
        },
      }),
    };
  }

  async login() {
    this.user = { id: 'app-0001', tag: 'PM Bot#0001' };
    // 実物と同じく非同期に ready が来る
    setImmediate(() => this.emit('ready'));
    return 'stub-token';
  }

  async destroy() { this.removeAllListeners(); }
}
