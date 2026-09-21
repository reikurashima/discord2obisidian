// discord.js のスタブ。
// Botが実際に使っている面（Client / channels.fetch / send / REST.put / 定数）だけを再現する。
// 送信内容は __sentMessages に溜まるので、テスト側が文面とメンションを検証できる。

import { EventEmitter } from 'node:events';

export const __sentMessages = [];
export const __registeredCommands = [];
export const __channels = new Map([
  ['chan-1', { id: 'chan-1', name: '案件A' }],
  ['chan-2', { id: 'chan-2', name: '案件B' }],
]);

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

export class Client extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.user = null;
    this.channels = {
      fetch: async (id) => {
        const meta = __channels.get(id);
        if (!meta) throw new Error(`Unknown channel ${id}`);
        return {
          ...meta,
          send: async (payload) => {
            __sentMessages.push({ channelId: id, ...payload });
            return { id: `msg-${__sentMessages.length}` };
          },
        };
      },
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
