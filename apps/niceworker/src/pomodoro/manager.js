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
   * 前回のプロセスがミュートしたまま死んだ人を、通常動作に入る前に解除する。
   * コンテナ再作成・クラッシュ・強制終了のいずれでもここが最後の砦。
   *
   * ⚠ 今VCに繋がっている人しか解除できない（Discord仕様）。
   *   繋がっていない人は台帳に「解除待ち」で残し、次の入室で解消する。
   *   ここで消してしまうと、その人は二度と自動解除されない。
   */
  async recoverOnStartup() {
    const leftovers = this.registry.load();
    if (leftovers.length === 0) {
      this.logger.info('[Pomodoro] 前回のミュート記録はありません');
      return;
    }

    this.logger.warn(`[Pomodoro] 前回のミュート記録が ${leftovers.length}件 残っています: ${leftovers.join(', ')}`);
    const result = await this.#unmuteUsers(leftovers, '起動時の自動解除');

    this.logger.info(
      `[Pomodoro] 起動時の解除結果: 解除 ${result.unmuted.length}人`
      + ` / 解除待ち ${result.pending.length}人`
      + ` / 失敗 ${result.failed.length}人`,
    );
    if (result.pending.length > 0) {
      this.logger.warn(
        `[Pomodoro] 解除待ちとして保持します（VC未接続のため今は解除できない）: ${result.pending.join(', ')}`,
      );
    }
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

      const movedChannel = event.oldChannelId !== event.newChannelId;
      const leftPomodoro = event.oldChannelId === this.vcChannelId && movedChannel;
      const joinedPomodoro = event.newChannelId === this.vcChannelId && movedChannel;
      // ⚠ 「どこかのVCに入った」= 解除待ちを解消できる唯一のタイミング。
      //    ポモドーロ専用VCに限定しないこと（一般VCに入っても解消されるべき）
      const joinedAnyVoice = event.newChannelId !== null && movedChannel;

      if (leftPomodoro) await this.#onLeavePomodoro(event.userId);
      if (joinedPomodoro) await this.#onJoinPomodoro(event.userId);

      // 順番が大事: ポモドーロ側の処理で再ミュートされた場合は、
      // registry.add が解除待ちを落としているのでここは何もしない
      if (joinedAnyVoice && this.registry.isPending(event.userId)) {
        this.logger.info(`[Pomodoro] ${event.userId} がVC(${event.newChannelId})へ入室。解除待ちを解消します`);
        await this.#unmuteUser(event.userId, '解除待ちの自動解消（入室検知）');
      }
    });
  }

  async #onJoinPomodoro(userId) {
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

  async #onLeavePomodoro(userId) {
    // ⚠ ここは「解除できたらラッキー」の位置づけになった。
    //    VCから完全に切断した人は Discord の仕様で解除できない（40032）ため、
    //    その場合は解除待ちとして台帳に残し、次の入室で解消する。
    //    別のVCへ移動した場合は接続が続いているので、ここで解除できる。
    //
    // 解除待ちになったことは**告知しない**（通知が冗長になるため）。
    // 作業開始の告知に「抜けるとミュートが残る」と毎回書いてあるので周知はそれで足りる。
    // 運用者が追えるようにログには必ず残し、`/pomo status` でも確認できる。
    if (this.registry.has(userId) && !this.registry.isPending(userId)) {
      await this.#unmuteUser(userId, '退出時の解除');
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

    if (phase === 'work') {
      await this.#muteUsers(members);
    } else {
      // 休憩の解除は全員VCに接続中なので成功するはず。結果を必ずログに残す
      const result = await this.#unmuteUsers(this.registry.list(), '休憩開始');
      this.logger.info(
        `[Pomodoro] 休憩開始の解除結果: 解除 ${result.unmuted.length}人`
        + ` / 解除待ち ${result.pending.length}人 / 失敗 ${result.failed.length}人`,
      );
    }

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

    const result = await this.#unmuteUsers(this.registry.list(), reason);
    // 解除待ちの人は告知に出さない（ログと /pomo status で足りる）
    this.logger.info(
      `[Pomodoro] 終了: ${reason} — 解除 ${result.unmuted.length}人`
      + ` / 解除待ち ${result.pending.length}人 / 失敗 ${result.failed.length}人`,
    );
    await this.display.showFinished(reason);
  }

  /**
   * SIGTERM/SIGINT から呼ぶ。まだVCに接続している人は今のうちに確実に解除する。
   * 接続していない人は解除待ちのまま台帳に残る（次回起動＋入室で解消される）。
   */
  async shutdownUnmuteAll() {
    this.#clearTimer();
    this.phase = 'idle';
    const targets = this.registry.list();
    if (targets.length === 0) {
      this.logger.info('[Pomodoro] 終了処理: 解除対象はありません');
      return;
    }

    this.logger.info(`[Pomodoro] 終了処理: ${targets.length}人のミュート解除を試みます`);
    const result = await this.#unmuteUsers(targets, '停止時の自動解除');
    this.logger.info(
      `[Pomodoro] 終了処理の解除結果: 解除 ${result.unmuted.length}人`
      + ` / 解除待ち ${result.pending.length}人 / 失敗 ${result.failed.length}人`,
    );
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
      const result = await this.gateway.setMute(userId, true, 'ポモドーロ: 作業時間');
      if (result === 'ok') {
        this.logger.info(`[Pomodoro] ${userId} をミュートしました`);
        return;
      }
      // ミュートできなかったのだから、解除すべきものも無い。台帳から外す
      this.registry.remove(userId);
      this.logger.warn(`[Pomodoro] ${userId} をミュートできませんでした（${result}）。台帳から外します`);
    } catch (error) {
      // 失敗しても記録は残す（残骸解除は空振りしても無害、解除漏れは有害）
      this.logger.error(`[Pomodoro] ${userId} のミュートに失敗しました（台帳には残します）`, error);
    }
  }

  /**
   * まとめて解除。
   * @returns {Promise<{unmuted: string[], pending: string[], failed: string[]}>}
   */
  async #unmuteUsers(userIds, reason) {
    const result = { unmuted: [], pending: [], failed: [] };
    for (const userId of userIds) {
      const outcome = await this.#unmuteUser(userId, reason);

      if (outcome === 'unmuted' || outcome === 'gone') result.unmuted.push(userId);
      else if (outcome === 'failed') result.failed.push(userId);
      else result.pending.push(userId);
    }
    return result;
  }

  /**
   * 1人ぶんの解除。リトライ込み。
   *
   * ⚠ 結果を必ずログに出すこと。以前は「解除します」とだけ出して結果を出していなかったため、
   *   実機で解除に失敗していたことに気づけなかった（2026-09-22）。
   *
   * @returns {Promise<'unmuted'|'pending'|'gone'|'failed'>}
   *   'pending' … VCに居ないため解除できなかった。台帳に解除待ちとして残す
   */
  async #unmuteUser(userId, reason) {
    let lastError = null;

    for (let attempt = 1; attempt <= UNMUTE_RETRIES; attempt += 1) {
      try {
        const result = await this.gateway.setMute(userId, false, reason);

        if (result === 'not-connected') {
          // ⚠ ここを成功扱いにしてはいけない。ミュートは残ったまま
          this.registry.markPending(userId);
          this.logger.warn(
            `[Pomodoro] 解除できませんでした: ${userId} — VCに接続していないため（Discord仕様 40032）。`
            + `解除待ちとして台帳に残します。次にVCへ入った時点で自動解除します（${reason}）`,
          );
          return 'pending';
        }

        if (result === 'gone') {
          this.registry.remove(userId);
          this.logger.warn(`[Pomodoro] 解除不要: ${userId} — サーバーに居ないため台帳から外しました（${reason}）`);
          return 'gone';
        }

        this.registry.remove(userId);
        this.logger.info(`[Pomodoro] 解除成功: ${userId}（${reason}）`);
        return 'unmuted';
      } catch (error) {
        lastError = error;
        this.logger.warn(`[Pomodoro] 解除失敗: ${userId} (${attempt}/${UNMUTE_RETRIES}) — ${error?.message ?? error}`);
        if (attempt < UNMUTE_RETRIES) await this.#sleep(UNMUTE_RETRY_DELAY_MS);
      }
    }

    // 40032 以外で最後まで駄目だったケース。台帳に残したまま告知する
    this.logger.error(`[Pomodoro] 解除に失敗したまま残っています: ${userId}（${reason}）`);
    try {
      await this.display.warnUnmuteFailure([userId], lastError?.message ?? lastError);
    } catch (error) {
      this.logger.error('[Pomodoro] 解除失敗の告知も出せませんでした', error);
    }
    return 'failed';
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
    const pending = this.registry.pendingList();
    const pendingLine = pending.length > 0
      ? `\n⏳ 解除待ち: ${pending.map((id) => `<@${id}>`).join(' ')}（VCに入ると自動で解除されます）`
      : '';

    if (this.phase === 'idle') {
      return `## 🍅 ポモドーロ\n停止中です。専用VCに入ると自動で始まります！${pendingLine}`;
    }
    const label = this.phase === 'work' ? '🍅 作業中' : '☕ 休憩中';
    return `## ${label}\n${this.cycle}セット目 / 切り替わりまで ${relativeTag(this.phaseEndsAt)}\n`
      + `ミュート中: ${this.registry.size - pending.length}人${pendingLine}`;
  }
}
