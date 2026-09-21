import { MessageFlags } from 'discord.js';
import { parseEndTime, timeTag, relativeTag } from '../utils/time.js';
import { logger } from '../utils/logger.js';

/**
 * スラッシュコマンドの入口。
 *
 * 権限の考え方:
 *   /call は「オーナーのユーザーID（環境変数 OWNER_USER_ID）と完全一致」でのみ通す。
 *   ロールで見ないのは、ロールは誰かが付け替えられてしまうため（通話の強制切断は影響が大きい）。
 */
export function createInteractionHandler({ pomodoro, callScheduler, gateway, ownerUserId }) {
  return async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'pomo') {
        await handlePomo(interaction, pomodoro);
        return;
      }
      if (interaction.commandName === 'call') {
        await handleCall(interaction, callScheduler, gateway, ownerUserId);
      }
    } catch (error) {
      logger.error(`[Interaction] /${interaction.commandName} の処理で例外`, error);
      // 応答が無いと利用者側に「アプリケーションが応答しませんでした」と出てしまう
      const payload = { content: '⚠️ エラーが発生しました。ログをご確認ください。', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  };
}

async function handlePomo(interaction, pomodoro) {
  if (interaction.options.getSubcommand() !== 'status') return;
  // /pomo status は誰でも使える。隠す情報でもないので公開で返す
  await interaction.reply({ content: pomodoro.statusText() });
}

async function handleCall(interaction, callScheduler, gateway, ownerUserId) {
  if (interaction.user.id !== ownerUserId) {
    await interaction.reply({
      content: '🔒 このコマンドはオーナー専用です。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'cancel') {
    const had = callScheduler.cancel();
    await interaction.reply({
      content: had ? '🗑️ 終了予約を取り消しました！' : '予約はありませんでした。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub !== 'end-at') return;

  const parsed = parseEndTime(interaction.options.getString('time', true));
  if (!parsed.ok) {
    await interaction.reply({ content: `⚠️ ${parsed.reason}`, flags: MessageFlags.Ephemeral });
    return;
  }

  // channel 省略時は「打った本人が今いるVC」。VCに居ない状態で省略されたら聞き返す
  const channel = interaction.options.getChannel('channel')
    ?? interaction.member?.voice?.channel
    ?? null;

  if (!channel) {
    await interaction.reply({
      content: '⚠️ 対象のVCが分かりません。VCに入るか、`channel` を指定してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = callScheduler.schedule({
    channelId: channel.id,
    endsAt: parsed.at,
    requestedBy: interaction.user.id,
  });

  if (!result.ok) {
    await interaction.reply({ content: `⚠️ ${result.reason}`, flags: MessageFlags.Ephemeral });
    return;
  }

  // オーナー向けの確認は ephemeral、みんなへの告知は公開、と使い分ける
  await interaction.reply({
    content: `✅ <#${channel.id}> を ${timeTag(parsed.at)}（${relativeTag(parsed.at)}）に終了する予約をしました！`,
    flags: MessageFlags.Ephemeral,
  });

  await gateway.announce(
    `## ⏰ 通話の終了予約\n<#${channel.id}> は ${timeTag(parsed.at)}（${relativeTag(parsed.at)}）に終了します。\n5分前と1分前にお知らせします！`,
  );
}
