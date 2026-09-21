import { relativeTag } from '../utils/time.js';

const UNMUTE_RETRIES = 3;
const UNMUTE_RETRY_DELAY_MS = 1500;

/**
 * ポモドーロの状態遷移。
 *
 * 設計方針:
 *   - コマンドは無い。ポモドーロ専用VCに誰かが入った瞬間に始まり、空になったら終わる
 *   - Discordへの操作はすべて gateway 経由。テストではスタブに差し替える
 *   - タイマーも注入する（timers）。テストで25分待ちたくないため
 *   - 「ミュート解除」は最優先。解除漏れ＝人が喋れないまま取り残される、が最悪の事故なので
 *     台帳(registry)への記録 → 実際のミュート、の順で必ず書く
 */
export class PomodoroManager {
  constructor({
    gateway,
    registry,
    display,
    logger,
    vcChannelId,
    workMs,
    breakMs,
    timers = { setTimeout, clearTimeout },
    now = () => Date.now(),
  }) {
    this.gateway = gateway;
    this.registry = registry;
    this.display = display;
    this.logger = logger;
    this.vcChannelId = vcChannelId;
    this.workMs = workMs;
    this.breakMs = breakMs;
    this.timers = timers;
    this.now = now;

    /** @type {'idle'|'work'|'break'} */
    this.phase = 'idle';
    this.phaseEndsAt = null;
    this.cycle = 0;
    this.timer = null;

    // voiceStateUpdate は短時間に連続で飛んでくる。並行に走らせると
    // 「入室→即退室」で解除の取りこぼしが起きるため、1本の鎖に直列化する
    this.queue = Promise.resolve();
  }

  /** 直列化して実行する。例外はここで握って落とさない（Bot本体を殺さない） */
  #enqueue(label, fn) {
    this.queue = this.queue.then(async () => {
      try {
        await fn();
      } catch (error) {
        this.logger.error(`[Pomodoro] ${label} で例外`, error);
      }
    });
    return this.queue;
  }

  // ---------------------------------------------------------------------------
  // 起動時の保険
  // ---------------------------------------------------------------------------

  /**
   * 前回のプロセスがミュートしたまま死んだ人を、通常動作に入る前に全員解除する。
   * コンテナ再作成・クラッシュ・強制終了のいずれでもここが最後の砦。
   */
  async recoverOnStartup() {
    const leftovers = this.registry.load();
    if (leftovers.length === 0) {
      this.logger.info('[Pomodoro] 前回のミュート記録はありません');
      return;
    }

    this.logger.warn(`[Pomodoro] 前回のミュート記録が ${leftovers.length}件 残っています。解除します: ${leftovers.join(', ')}`);
    await this.#unmuteUsers(leftovers, '起動時の自動解除');
  }

  // ---------------------------------------------------------------------------
  // VCの出入り
  // ---------------------------------------------------------------------------

  /**
   * @param {{userId: string, oldChannelId: string|null, newChannelId: string|null, isBot?: boolean}} event
   */
  handleVoiceStateUpdate(event) {
    return this.#enqueue('voiceStateUpdate', async () => {
      if (event.isBot) return;

      const left = event.oldChannelId === this.vcChannelId && event.newChannelId !== this.vcChannelId;
      const joined = event.newChannelId === this.vcChannelId && event.oldChannelId !== this.vcChannelId;

      if (left) await this.#onLeave(event.userId);
      if (joined) await this.#onJoin(event.userId);
    });
  }

  async #onJoin(userId) {
    if (this.phase === 'idle') {
      this.logger.info(`[Pomodoro] ${userId} の入室で開始します`);
      await this.#enterPhase('work');
      return;
    }

    // 作業中に後から来た人は、その場でミュートして輪に加える
    if (this.phase === 'work') {
      this.logger.info(`[Pomodoro] 作業中に ${userId} が入室。即ミュートします`);
      await this.#muteUser(userId);
    }
  }

  async #onLeave(userId) {
    // ⚠ ここが一番大事。サーバーミュートはVCを抜けても残る可能性があるので、
    //    抜けた本人は必ず解除する（ポモドーロが続いていても関係なく）
    if (this.registry.has(userId)) {
      this.logger.info(`[Pomodoro] ${userId} が退出。ミュートを解除します`);
      await this.#unmuteUsers([userId], '退出時の自動解除');
    }

    const remaining = await this.#safeListMembers();
    if (remaining.length === 0 && this.phase !== 'idle') {
      await this.#stop('VCが空になりました');
    }
  }

  // ---------------------------------------------------------------------------
  // フェーズ
  // ---------------------------------------------------------------------------

  async #enterPhase(phase) {
    this.#clearTimer();

    const durationMs = phase === 'work' ? this.workMs : this.breakMs;
    this.phase = phase;
    this.phaseEndsAt = this.now() + durationMs;
    if (phase === 'work') this.cycle += 1;

    const members = await this.#safeListMembers();
    if (members.length === 0) {
      // 切り替えの瞬間に全員抜けていた場合。開始せずに閉じる
      await this.#stop('VCが空になりました');
      return;
    }

    if (phase === 'work') await this.#muteUsers(members);
    else await this.#unmuteUsers(this.registry.list(), '休憩開始');

    await this.display.showPhase(phase, this.phaseEndsAt, { memberCount: members.length });

    const next = phase === 'work' ? 'break' : 'work';
    this.timer = this.timers.setTimeout(() => {
      this.#enqueue(`${phase}→${next}`, () => this.#enterPhase(next));
    }, durationMs);
  }

  async #stop(reason) {
    this.#clearTimer();
    this.phase = 'idle';
    this.phaseEndsAt = null;
    this.cycle = 0;

    await this.#unmuteUsers(this.registry.list(), reason);
    await this.display.showFinished(reason);
    this.logger.info(`[Pomodoro] 終了: ${reason}`);
  }

  /** SIGTERM/SIGINT から呼ぶ。告知は出さずに、とにかく全員解除する */
  async shutdownUnmuteAll() {
    this.#clearTimer();
    this.phase = 'idle';
    const targets = this.registry.list();
    if (targets.length === 0) return;

    this.logger.info(`[Pomodoro] 終了処理: ${targets.length}人のミュートを解除します`);
    await this.#unmuteUsers(targets, '停止時の自動解除');
  }

  #clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // ミュート
  // ---------------------------------------------------------------------------

  async #muteUsers(userIds) {
    for (const userId of userIds) await this.#muteUser(userId);
  }

  async #muteUser(userId) {
    // ⚠ 記録が先。ミュート直後にクラッシュしても、次回起動で解除できるようにする
    this.registry.add(userId, this.vcChannelId);
    try {
      await this.gateway.setMute(userId, true, 'ポモドーロ: 作業時間');
    } catch (error) {
      // 失敗しても記録は残す（残骸解除は空振りしても無害、解除漏れは有害）
      this.logger.error(`[Pomodoro] ${userId} をミュートできませんでした`, error);
    }
  }

  /**
   * 解除。リトライ込み。最後まで駄目だった人は台帳に残したまま告知する。
   * @param {string[]} userIds
   */
  async #unmuteUsers(userIds, reason) {
    const failed = [];
    let lastError = null;

    for (const userId of userIds) {
      let done = false;
      for (let attempt = 1; attempt <= UNMUTE_RETRIES && !done; attempt += 1) {
        try {
          // 'gone' = もうVCにもサーバーにも居ない → ミュート状態も一緒に消えているので成功扱い
          await this.gateway.setMute(userId, false, reason);
          done = true;
        } catch (error) {
          lastError = error;
          this.logger.warn(`[Pomodoro] ${userId} の解除に失敗 (${attempt}/${UNMUTE_RETRIES}): ${error?.message ?? error}`);
          if (attempt < UNMUTE_RETRIES) await this.#sleep(UNMUTE_RETRY_DELAY_MS);
        }
      }

      if (done) this.registry.remove(userId);
      else failed.push(userId);
    }

    if (failed.length > 0) {
      this.logger.error(`[Pomodoro] ミュート解除に失敗したまま残っています: ${failed.join(', ')}`);
      try {
        await this.display.warnUnmuteFailure(failed, lastError?.message ?? lastError);
      } catch (error) {
        this.logger.error('[Pomodoro] 解除失敗の告知も出せませんでした', error);
      }
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  async #safeListMembers() {
    try {
      return await this.gateway.listVoiceMemberIds(this.vcChannelId);
    } catch (error) {
      this.logger.error('[Pomodoro] VCの在室者を取得できませんでした', error);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // /pomo status
  // ---------------------------------------------------------------------------

  statusText() {
    if (this.phase === 'idle') {
      return '## 🍅 ポモドーロ\n停止中です。専用VCに入ると自動で始まります！';
    }
    const label = this.phase === 'work' ? '🍅 作業中' : '☕ 休憩中';
    return `## ${label}\n${this.cycle}セット目 / 切り替わりまで ${relativeTag(this.phaseEndsAt)}\n`
      + `ミュート中: ${this.registry.size}人`;
  }
}
