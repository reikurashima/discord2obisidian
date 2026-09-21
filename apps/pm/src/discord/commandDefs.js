// スラッシュコマンドの定義。
//
// SlashCommandBuilder ではなく素のJSONで書いている理由:
//   - REST の登録エンドポイントがそのまま受け取れる形なので、変換が要らない
//   - 定義そのものをテストから読んで検証できる（ビルダーの内部表現に依存しない）
//
// ⚠ default_member_permissions: "0" は「どのロールにも許可しない」= 管理者以外UIに出ない、の意味。
//    ただしこれは見た目の話でしかない（サーバー管理者は依然として実行できる）。
//    実際の拒否はハンドラ側の user.id 判定で行う。二重にかけるのが要件。

const OPT_STRING = 3;
const OPT_USER = 6;

const OWNER_ONLY = {
  default_member_permissions: '0',
  dm_permission: false,
};

const taskPickerOption = (description) => ({
  type: OPT_STRING,
  name: 'task',
  description,
  required: true,
  autocomplete: true,
});

export const commandDefs = [
  {
    ...OWNER_ONLY,
    name: 'task',
    description: 'タスクを登録します',
    options: [
      {
        type: OPT_USER,
        name: 'assignee',
        description: '担当者',
        required: true,
      },
      {
        type: OPT_STRING,
        name: 'due',
        description: '期限（YYYY-MM-DD または YYYY-MM-DD HH:mm）',
        required: true,
        autocomplete: true,
      },
      {
        type: OPT_STRING,
        name: 'title',
        description: 'お願いする内容',
        required: true,
      },
      {
        type: OPT_STRING,
        name: 'remind_at',
        description: '3日前・1日前に通知する時刻（HH:mm・既定 18:00）',
        required: false,
      },
    ],
  },
  {
    ...OWNER_ONLY,
    name: 'complete',
    description: 'タスクを完了にします',
    options: [taskPickerOption('完了にするタスク')],
  },
  {
    ...OWNER_ONLY,
    name: 'task-edit',
    description: 'タスクの内容を変更します',
    options: [
      taskPickerOption('変更するタスク'),
      {
        type: OPT_USER,
        name: 'assignee',
        description: '新しい担当者',
        required: false,
      },
      {
        type: OPT_STRING,
        name: 'due',
        description: '新しい期限（YYYY-MM-DD または YYYY-MM-DD HH:mm）',
        required: false,
        autocomplete: true,
      },
      {
        type: OPT_STRING,
        name: 'title',
        description: '新しい内容',
        required: false,
      },
      {
        type: OPT_STRING,
        name: 'remind_at',
        description: '新しい通知時刻（HH:mm）',
        required: false,
      },
    ],
  },
  {
    ...OWNER_ONLY,
    name: 'task-drop',
    description: 'タスクを取り下げます（完了とは別扱い）',
    options: [taskPickerOption('取り下げるタスク')],
  },
];
