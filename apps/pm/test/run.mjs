// スタブ化した discord.js で PM Bot を実際に起動して検証するハーネス。
//
//   node --import ./test/loader.mjs ./test/run.mjs --phase=1 --dir=<作業ディレクトリ>
//   node --import ./test/loader.mjs ./test/run.mjs --phase=2 --dir=<同じディレクトリ>
//
// phase=1 で一連の操作とリマインダー送信を行い、phase=2 は別プロセスとして
// 同じ時刻でティックを回し直す（＝再起動しても二重送信しないことの確認）。

import { promises as fs } from 'fs';
import path from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const phase = Number(args.phase || 1);
const workDir = path.resolve(args.dir || './test/.tmp');
const stateDir = path.join(workDir, 'data');
const metaPath = path.join(workDir, 'meta.json');

const OWNER = 'owner-1';
const TANAKA = { id: 'user-tanaka', username: 'tanaka', globalName: '田中' };
const SATO = { id: 'user-sato', username: 'sato', globalName: '佐藤' };
const INTRUDER = 'user-intruder';

process.env.DISCORD_TOKEN = 'stub-token';
process.env.GUILD_ID = 'guild-1';
process.env.OWNER_USER_ID = OWNER;
process.env.STATE_DIR = stateDir;

await fs.mkdir(stateDir, { recursive: true });

// ---- 検証結果の集計 -------------------------------------------------

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
}

// ---- Bot を起動 -----------------------------------------------------

const stub = await import('./stub/discord.js');
await import('../src/index.js');

const {
  handleInteraction,
} = await import('../src/discord/interactions.js');
const { discordClient } = await import('../src/discord/client.js');
const { runTick, stopReminderLoop } = await import('../src/reminders/tick.js');
const { listTasks, listOpenTasks } = await import('../src/storage/tasks.js');
const {
  MS_PER_DAY, atJstTimeOfDay, jstDueString, startOfJstDay,
} = await import('../src/utils/datetime.js');

await waitFor(() => stub.__registeredCommands.length > 0, 'command registration');

// ---- スタブの Interaction ------------------------------------------

function commandInteraction({ name, userId = OWNER, channelId = 'chan-1', opts = {} }) {
  const replies = [];
  return {
    commandName: name,
    channelId,
    channel: stub.__channels.get(channelId),
    user: { id: userId, username: userId },
    replied: false,
    deferred: false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    options: {
      getUser: (n) => opts[n]?.user ?? null,
      getMember: (n) => opts[n]?.member ?? null,
      getString: (n) => (typeof opts[n] === 'string' ? opts[n] : null),
    },
    reply: async (payload) => { replies.push(payload); },
    replies,
  };
}

function autocompleteInteraction({ name, value = '', userId = OWNER }) {
  const captured = [];
  return {
    commandName: 'task',
    user: { id: userId },
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    options: { getFocused: () => ({ name, value }) },
    respond: async (choices) => { captured.push(...choices); },
    captured,
  };
}

const user = (u, displayName) => ({ user: u, member: { displayName } });

function takeSent() {
  const out = stub.__sentMessages.splice(0, stub.__sentMessages.length);
  return out;
}

// =====================================================================
if (phase === 1) await phase1();
else await phase2();
// =====================================================================

async function phase1() {
  console.log('\n===== PHASE 1: 登録・通知・リマインダー =====\n');

  // --- 起動時の構造チェック ---
  check(
    'messageCreate を購読していない（他人の発言でコードが走らない）',
    discordClient.listenerCount('messageCreate') === 0,
    `messageCreate listeners=${discordClient.listenerCount('messageCreate')}, interactionCreate listeners=${discordClient.listenerCount('interactionCreate')}`,
  );
  check(
    'Intents は Guilds のみ（特権Intent不要）',
    JSON.stringify(discordClient.options.intents) === JSON.stringify([1]),
    `intents=${JSON.stringify(discordClient.options.intents)}`,
  );
  const defs = stub.__registeredCommands;
  check(
    '4コマンドが setDefaultMemberPermissions(0) 相当で登録される',
    defs.length === 4 && defs.every((d) => d.default_member_permissions === '0' && d.dm_permission === false),
    defs.map((d) => `/${d.name} perms=${d.default_member_permissions} dm=${d.dm_permission}`).join(' | '),
  );
  check(
    '.state / tasks / scans ディレクトリが作られる',
    (await exists(path.join(stateDir, 'tasks')))
      && (await exists(path.join(stateDir, '.state')))
      && (await exists(path.join(stateDir, 'scans'))),
    await fs.readdir(stateDir).then((d) => d.join(', ')),
  );

  // --- オーナー以外は拒否 ---
  takeSent();
  const intruder = commandInteraction({
    name: 'task',
    userId: INTRUDER,
    opts: { assignee: user(TANAKA, '田中'), due: '2026-12-01', title: '侵入テスト' },
  });
  await handleInteraction(discordClient, intruder);
  check(
    'オーナー以外のユーザーIDは即拒否され、タスクも作られない',
    intruder.replies[0]?.content?.includes('オーナーのみ')
      && intruder.replies[0]?.flags === 64
      && (await listTasks()).length === 0
      && takeSent().length === 0,
    JSON.stringify(intruder.replies[0]),
  );

  const acIntruder = autocompleteInteraction({ name: 'task', userId: INTRUDER });
  await handleInteraction(discordClient, acIntruder);
  check('オーナー以外のオートコンプリートは空を返す', acIntruder.captured.length === 0);

  // --- 時刻の基準 ---
  const now = Date.now();
  const at18 = (days) => atJstTimeOfDay(startOfJstDay(now) + days * MS_PER_DAY, { hour: 18, minute: 0 });
  const dueA = at18(10);
  const dueB = at18(2);
  const dueC = at18(5);

  // --- /task 登録（A: 10日後） ---
  const iA = commandInteraction({
    name: 'task',
    opts: {
      assignee: user(TANAKA, '田中'),
      due: jstDueString(dueA),
      title: '修正版データの提出',
    },
  });
  await handleInteraction(discordClient, iA);
  const sentA = takeSent();
  const taskA = (await listTasks()).find((t) => t.title === '修正版データの提出');

  const rawA = await fs.readFile(path.join(stateDir, 'tasks', `${taskA.id}.md`), 'utf-8');
  check(
    '/task で .md が契約どおりの形で作られる（連番 #1）',
    taskA.number === 1
      && /^---\n/.test(rawA)
      && rawA.includes('status: todo')
      && rawA.includes('channel_id: "chan-1"')
      && rawA.includes('channel_name: 案件A')
      && rawA.includes('assignee_id: "user-tanaka"')
      && rawA.includes(`due: ${jstDueString(dueA)}`)
      && rawA.includes('remind_at: "18:00"')
      && rawA.includes('reminders_sent: []')
      && rawA.includes('completed_at: null')
      && rawA.includes('## メモ'),
    rawA,
  );
  check(
    '登録通知が担当者メンションつきで投稿される',
    sentA.length === 1
      && sentA[0].channelId === 'chan-1'
      && sentA[0].content.includes('<@user-tanaka> さんに『修正版データの提出』をお願いしました')
      && JSON.stringify(sentA[0].allowedMentions) === JSON.stringify({ parse: [], users: ['user-tanaka'] }),
    `${sentA[0]?.content}\n  allowedMentions=${JSON.stringify(sentA[0]?.allowedMentions)}`,
  );
  check(
    'counter.json が進む',
    JSON.parse(await fs.readFile(path.join(stateDir, '.state', 'counter.json'), 'utf-8')).next === 2,
  );

  // --- /task 登録（B: 2日後 → 3日前の通知は飛ばす） ---
  const iB = commandInteraction({
    name: 'task',
    channelId: 'chan-2',
    opts: {
      assignee: user(SATO, '佐藤'),
      due: jstDueString(dueB),
      title: '絵コンテのチェック',
    },
  });
  await handleInteraction(discordClient, iB);
  takeSent();
  const taskB = (await listTasks()).find((t) => t.title === '絵コンテのチェック');
  check(
    '期限まで2日で登録 → 3日前は最初から送信済み扱い（-1d と 0 だけ残る）',
    JSON.stringify(taskB.remindersSent) === JSON.stringify(['-3d'])
      && iB.replies[0].content.includes('3日前の通知は登録時点で過ぎている'),
    `reminders_sent=${JSON.stringify(taskB.remindersSent)} / reply="${iB.replies[0].content}"`,
  );

  // --- /task 登録（C: 5日後・担当＝オーナー） ---
  const iC = commandInteraction({
    name: 'task',
    opts: {
      assignee: user({ id: OWNER, username: 'rei', globalName: 'Rei' }, 'Rei'),
      due: jstDueString(dueC),
      title: '請求書の作成',
    },
  });
  await handleInteraction(discordClient, iC);
  takeSent();
  const taskC = (await listTasks()).find((t) => t.title === '請求書の作成');

  // --- オートコンプリート ---
  const acTask = autocompleteInteraction({ name: 'task' });
  await handleInteraction(discordClient, acTask);
  check(
    'task オートコンプリートが未完了3件を「#n 担当 / MM-DD / 内容」で返す',
    acTask.captured.length === 3
      && /^#1 田中 \/ \d{2}-\d{2} \/ 修正版データの提出$/.test(acTask.captured[0].name)
      && acTask.captured[0].value === taskA.id,
    acTask.captured.map((c) => `${c.name}  →  ${c.value}`).join('\n'),
  );

  const acFiltered = autocompleteInteraction({ name: 'task', value: '絵コンテ' });
  await handleInteraction(discordClient, acFiltered);
  check('task オートコンプリートは入力で絞り込める', acFiltered.captured.length === 1 && acFiltered.captured[0].value === taskB.id,
    acFiltered.captured.map((c) => c.name).join(' | '));

  const acDue = autocompleteInteraction({ name: 'due' });
  await handleInteraction(discordClient, acDue);
  check(
    'due オートコンプリートが相対指定を実日付に解決して返す',
    acDue.captured.length >= 8
      && acDue.captured.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.value))
      && acDue.captured.some((c) => c.name.startsWith('今日'))
      && acDue.captured.some((c) => c.name.startsWith('来週')),
    acDue.captured.map((c) => `${c.name} → ${c.value}`).join('\n'),
  );

  // --- /task-edit ---
  const iEdit = commandInteraction({
    name: 'task-edit',
    opts: { task: taskB.id, assignee: user(TANAKA, '田中'), remind_at: '10:00' },
  });
  await handleInteraction(discordClient, iEdit);
  const sentEdit = takeSent();
  const taskBAfterEdit = (await listTasks()).find((t) => t.id === taskB.id);
  check(
    '/task-edit で担当・通知時刻を変更 → 変更通知が新旧担当メンションつきで出る',
    sentEdit.length === 1
      && sentEdit[0].content.includes('・担当: 佐藤 → 田中')
      && sentEdit[0].content.includes('・通知時刻: 18:00 → 10:00')
      && JSON.stringify(sentEdit[0].allowedMentions.users) === JSON.stringify(['user-tanaka', 'user-sato']),
    `${sentEdit[0]?.content}\n  users=${JSON.stringify(sentEdit[0]?.allowedMentions?.users)}`,
  );
  check(
    '通知時刻の変更で reminders_sent が引き直される（過ぎた -3d のみ抑止のまま）',
    JSON.stringify(taskBAfterEdit.remindersSent) === JSON.stringify(['-3d'])
      && taskBAfterEdit.remindAt === '10:00',
    `reminders_sent=${JSON.stringify(taskBAfterEdit.remindersSent)} remind_at=${taskBAfterEdit.remindAt}`,
  );

  // 以降の検証をしやすくするため通知時刻を 18:00 に戻す
  await handleInteraction(discordClient, commandInteraction({
    name: 'task-edit', opts: { task: taskB.id, remind_at: '18:00' },
  }));
  takeSent();

  // --- リマインダーのティック ---
  const ticks = {
    b1: at18(1),   // B の 1日前
    b2: at18(2),   // B の 期限ちょうど / C の 3日前
    a1: at18(7),   // A の 3日前 / C は期限超過で抑止
    a2: at18(9),   // A の 1日前
    a3: at18(10),  // A の 期限ちょうど
  };

  // B: 1日前
  await runTick(discordClient, ticks.b1);
  let s = takeSent();
  check(
    'ティック: B の1日前通知が飛ぶ（オーナー＋担当者メンション）',
    s.length === 1
      && s[0].content.includes('明日が期限です')
      && s[0].content.includes('一報')
      && JSON.stringify(s[0].allowedMentions.users) === JSON.stringify([OWNER, 'user-tanaka']),
    `${s[0]?.content}\n  users=${JSON.stringify(s[0]?.allowedMentions?.users)}`,
  );

  await runTick(discordClient, ticks.b1 + 60_000);
  check('ティック: 同じ通知は2度飛ばない（1分後にもう一度回す）', takeSent().length === 0);

  // B: 期限ちょうど / C: 3日前（担当＝オーナー）
  await runTick(discordClient, ticks.b2);
  s = takeSent();
  const bDue = s.find((m) => m.content.includes('絵コンテ'));
  const c3d = s.find((m) => m.content.includes('請求書'));
  check(
    'ティック: B の期限ちょうど通知が飛ぶ',
    !!bDue && bDue.content.includes('期限の時刻になりました')
      && JSON.stringify(bDue.allowedMentions.users) === JSON.stringify([OWNER, 'user-tanaka']),
    bDue?.content,
  );
  check(
    '担当者＝オーナーのときメンションは1つにまとまる',
    !!c3d && JSON.stringify(c3d.allowedMentions.users) === JSON.stringify([OWNER])
      && (c3d.content.match(/<@owner-1>/g) || []).length === 1,
    `${c3d?.content}\n  users=${JSON.stringify(c3d?.allowedMentions?.users)}`,
  );

  await runTick(discordClient, ticks.b2 + 60_000);
  check('ティック: B・C とも二度目は飛ばない', takeSent().length === 0);

  // A: 3日前（同時に C は期限超過 → 送らない）
  await runTick(discordClient, ticks.a1);
  s = takeSent();
  check(
    'ティック: A の3日前通知が飛ぶ',
    s.length === 1 && s[0].content.includes('期限まであと3日です') && s[0].content.includes('進捗'),
    s[0]?.content,
  );
  const taskCAfter = (await listTasks()).find((t) => t.id === taskC.id);
  check(
    '期限を過ぎた未完了タスクには通知しない（送信済み扱いにして黙る）',
    taskCAfter.status === 'todo'
      && JSON.stringify(taskCAfter.remindersSent.slice().sort()) === JSON.stringify(['-1d', '-3d', '0']),
    `C status=${taskCAfter.status} reminders_sent=${JSON.stringify(taskCAfter.remindersSent)}`,
  );

  await runTick(discordClient, ticks.a2);
  s = takeSent();
  check('ティック: A の1日前通知が飛ぶ', s.length === 1 && s[0].content.includes('明日が期限です'), s[0]?.content);
  await runTick(discordClient, ticks.a2 + 60_000);
  check('ティック: A の1日前は1回だけ', takeSent().length === 0);

  // --- ポータル側の編集を模した外部書き換え ---
  const aPath = path.join(stateDir, 'tasks', `${taskA.id}.md`);
  let rawEdited = await fs.readFile(aPath, 'utf-8');
  rawEdited = rawEdited
    .replace('title: 修正版データの提出', 'title: 修正版データの提出（ポータルで改題）')
    .replace(/^status: todo$/m, 'status: todo\nportal_priority: high');
  await fs.writeFile(aPath, rawEdited, 'utf-8');

  await runTick(discordClient, ticks.a3);
  s = takeSent();
  check(
    'ポータルが外部から .md を書き換えると、次のティックで新しい内容が使われる（キャッシュしていない）',
    s.length === 1 && s[0].content.includes('修正版データの提出（ポータルで改題）') && s[0].content.includes('期限の時刻になりました'),
    s[0]?.content,
  );
  const rawAfterTick = await fs.readFile(aPath, 'utf-8');
  check(
    'Botが書き戻しても、ポータルが足した未知のキーは保持される',
    rawAfterTick.includes('portal_priority: high') && rawAfterTick.includes('reminders_sent: ["-3d", "-1d", "0"]'),
    rawAfterTick.split('\n').filter((l) => l.startsWith('portal_') || l.startsWith('reminders_sent')).join('\n'),
  );

  // --- /complete ---
  const iDone = commandInteraction({ name: 'complete', opts: { task: taskB.id } });
  await handleInteraction(discordClient, iDone);
  s = takeSent();
  check(
    '/complete の完了通知はメンションを含まない',
    s.length === 1
      && s[0].content === `✅ タスク #${taskB.number}『絵コンテのチェック』完了！ありがとうございました！`
      && !s[0].content.includes('<@')
      && JSON.stringify(s[0].allowedMentions) === JSON.stringify({ parse: [], users: [] }),
    `${s[0]?.content}\n  allowedMentions=${JSON.stringify(s[0]?.allowedMentions)}`,
  );

  const acAfterDone = autocompleteInteraction({ name: 'task' });
  await handleInteraction(discordClient, acAfterDone);
  check(
    '/complete 後のオートコンプリートに完了タスクは出ない',
    acAfterDone.captured.length === 2 && !acAfterDone.captured.some((c) => c.value === taskB.id),
    acAfterDone.captured.map((c) => c.name).join(' | '),
  );

  // --- /task-drop ---
  const iDrop = commandInteraction({ name: 'task-drop', opts: { task: taskC.id } });
  await handleInteraction(discordClient, iDrop);
  check(
    '/task-drop は dropped にするだけでチャンネルには投稿しない',
    takeSent().length === 0
      && (await listOpenTasks()).length === 1
      && (await listTasks()).find((t) => t.id === taskC.id).status === 'dropped',
    iDrop.replies[0]?.content,
  );

  // --- 非オーナーは complete も打てない ---
  const iDoneIntruder = commandInteraction({ name: 'complete', userId: INTRUDER, opts: { task: taskA.id } });
  await handleInteraction(discordClient, iDoneIntruder);
  check(
    '/complete もオーナー以外は拒否される',
    iDoneIntruder.replies[0]?.content?.includes('オーナーのみ')
      && (await listTasks()).find((t) => t.id === taskA.id).status === 'todo',
  );

  await fs.writeFile(metaPath, JSON.stringify({ ticks, ids: { a: taskA.id, b: taskB.id, c: taskC.id } }, null, 2));
  finish();
}

async function phase2() {
  console.log('\n===== PHASE 2: 別プロセスで再起動し、同じ時刻でティックし直す =====\n');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));

  takeSent(); // 起動直後のティック分があれば捨てる
  for (const [name, ms] of Object.entries(meta.ticks)) {
    await runTick(discordClient, ms);
    await runTick(discordClient, ms + 60_000);
    const s = takeSent();
    check(`再起動後: ${name} の時刻でティックしても何も送らない`, s.length === 0,
      s.map((m) => m.content).join('\n'));
  }

  const raw = await fs.readFile(path.join(stateDir, 'tasks', `${meta.ids.a}.md`), 'utf-8');
  check(
    '再起動後も外部編集（改題・未知キー）がそのまま読める',
    raw.includes('portal_priority: high') && raw.includes('（ポータルで改題）'),
  );

  finish();
}

// ---- 後始末 ---------------------------------------------------------

function finish() {
  stopReminderLoop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n----- ${results.length - failed.length}/${results.length} passed -----`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function waitFor(fn, what, timeoutMs = 5000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
