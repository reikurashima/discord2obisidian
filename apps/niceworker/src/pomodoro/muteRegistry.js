import fs from 'fs';
import path from 'path';

/**
 * 「Botがサーバーミュートした人」の一覧をディスクに持つ台帳。
 *
 * なぜメモリだけでは駄目か:
 *   サーバーミュートはメンバー側に残る状態なので、Botがクラッシュ／コンテナ再作成されると
 *   解除する人がいなくなり、ミュートされたまま取り残される。これがこのBotで一番怖い事故。
 *   そのため「ミュートする前に記録 → 解除できたら削除」の順で書き、
 *   起動時に残骸を全員解除してから通常動作に入る。
 *
 * pendingUnmute（解除待ち）について:
 *   ⚠ Discordの仕様上、VCに接続していない相手のミュートは解除できない（40032）。
 *     つまり「VCを抜けた人をその場で解除する」ことは**不可能**。
 *   そこで解除できなかった人は pendingUnmute=true で台帳に残し、
 *   その人が次にどこかのVCへ入った瞬間に解除する。
 *   この情報は再起動をまたいで保持しないと意味がないので、必ずディスクに持つ。
 *
 * 書き込みは同期＋一時ファイル経由のrename。
 *   非同期にすると「記録前にミュートしてクラッシュ」の窓が開く。件数は数人なので同期で十分。
 */
export class MuteRegistry {
  /**
   * @param {string} filePath 台帳JSONの絶対パス
   * @param {{warn: Function, error: Function}} logger
   */
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    /** @type {Map<string, {mutedAt: number, channelId: string|null, pendingUnmute: boolean}>} */
    this.entries = new Map();
  }

  /** 起動時に一度だけ呼ぶ。壊れたファイルは「記録なし」として扱う（起動は止めない）。 */
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const list = Array.isArray(parsed?.muted) ? parsed.muted : [];
      for (const item of list) {
        if (typeof item?.userId !== 'string') continue;
        this.entries.set(item.userId, {
          mutedAt: typeof item.mutedAt === 'number' ? item.mutedAt : 0,
          channelId: typeof item.channelId === 'string' ? item.channelId : null,
          pendingUnmute: item.pendingUnmute === true,
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`[MuteRegistry] 台帳を読めなかったので空として扱います: ${error.message}`);
      }
      this.entries = new Map();
    }
    return this.list();
  }

  list() {
    return [...this.entries.keys()];
  }

  has(userId) {
    return this.entries.has(userId);
  }

  get size() {
    return this.entries.size;
  }

  /** 解除待ちの人だけ */
  pendingList() {
    return [...this.entries.entries()].filter(([, meta]) => meta.pendingUnmute).map(([userId]) => userId);
  }

  isPending(userId) {
    return this.entries.get(userId)?.pendingUnmute === true;
  }

  get pendingSize() {
    return this.pendingList().length;
  }

  add(userId, channelId = null) {
    // ミュートし直したのだから解除待ちは解消される
    this.entries.set(userId, { mutedAt: Date.now(), channelId, pendingUnmute: false });
    this.persist();
  }

  /**
   * 「VCに居ないので解除できなかった」人を解除待ちにする。
   * ⚠ ここで台帳から消してはいけない。消すとミュートが永久に残る。
   */
  markPending(userId) {
    const meta = this.entries.get(userId) ?? { mutedAt: Date.now(), channelId: null, pendingUnmute: false };
    if (meta.pendingUnmute) return false; // 既に解除待ち（重複告知を避けるため差分を返す）
    meta.pendingUnmute = true;
    this.entries.set(userId, meta);
    this.persist();
    return true;
  }

  remove(userId) {
    if (this.entries.delete(userId)) this.persist();
  }

  clear() {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.persist();
  }

  persist() {
    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      muted: [...this.entries.entries()].map(([userId, meta]) => ({ userId, ...meta })),
    });

    const tmpPath = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, payload, 'utf-8');
      // 書き途中のJSONを次回起動で読んでしまわないよう、完成品をrenameで差し替える
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      // 保存に失敗しても動作は続ける。ただし「保険が効いていない」ことは必ず知らせる
      this.logger.error(`[MuteRegistry] 台帳を保存できませんでした（再起動時の自動解除が効きません）: ${error.message}`);
    }
  }
}
