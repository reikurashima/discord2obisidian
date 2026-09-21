# NiceWorker Bot

友人用サーバー向けのDiscord Bot。**ルート直下で動いている Obsidian保存Bot とは完全に別物**で、
このディレクトリだけで自己完結している（ルートの `package.json` / `src/` / `Dockerfile` には一切触らない）。

## 機能

- **自動ポモドーロ**: ポモドーロ専用VCに誰かが入った瞬間に開始。作業25分（全員サーバーミュート）→ 休憩5分（解除）を繰り返し、VCが空になったら終了。コマンドは不要
- **残り時間の表示**: 告知チャンネルに `<t:UNIX秒:R>` 付きで投稿（カウントダウンはDiscord側が行う）＋VCステータス、失敗時はVC名変更へフォールバック
- **`/call end-at`**: 指定時刻に通話を終了（オーナー専用）。5分前・1分前に告知して、時刻になったら全員切断
- **`/pomo status`**: 今のフェーズと残り時間（誰でも）

## セットアップ

```sh
cp .env.example .env   # 値を埋める
docker compose up -d --build
```

### Discord Developer Portal 側

- **Bot → Privileged Gateway Intents**: `SERVER MEMBERS INTENT` を ON にしておくのを推奨
  （VCの在室者は voiceStateUpdate からも取れるので必須ではないが、起動直後にVCへ既に人が居た場合の
  取りこぼしを防げる。`MESSAGE CONTENT INTENT` は使わないので OFF のままでよい）
- 使用するIntentは `Guilds` / `GuildVoiceStates` / `GuildMessages`。いずれも特権Intentではない
- **招待URLのスコープ**: `bot` + `applications.commands`
- **必要な権限**:
  | 権限 | 用途 |
  |---|---|
  | メンバーをミュート (Mute Members) | ポモドーロの必須権限 |
  | メンバーを移動 (Move Members) | `/call end-at` の切断 |
  | メッセージを送信 (Send Messages) | 告知チャンネル |
  | チャンネルの管理 (Manage Channels) | VC名変更のフォールバック |
  | ボイスチャンネルのステータス設定 (Set Voice Channel Status) | 任意。無くても動く |
- Botのロールは、**ポモドーロ参加者のロールより上**に置くこと（下だとミュートできない）

## 開発

```sh
npm install
npm run check   # 全ファイルの構文チェック
npm test        # Discordに繋がずに状態遷移を検証
node test/lifecycle.js   # クラッシュ復帰・SIGTERM をプロセス単位で検証
```

## ⚠ ミュート解除の仕様（重要）

**VCに接続していない相手のサーバーミュートは、Discordの仕様上そもそも解除できない。**

```
PATCH /guilds/{guild}/members/{user}  {"mute": false}
→ 400  {"code": 40032, "message": "Target user is not connected to voice."}
```

つまり「VCを抜けた人をその場で解除する」ことは**不可能**。
そこで **「次にVCに入った瞬間に解除する」** 方式にしている。

| タイミング | 動作 |
|---|---|
| 休憩に入る／VCが空になる／`SIGTERM` | 全員まだ接続中なのでここで解除できる。**成功/失敗を1人ずつログに出す** |
| 誰かがVCを完全に切断 | 解除を試みる → `40032` なら**解除待ち（pendingUnmute）として台帳に残す**。消さない |
| 誰かが**どこかの**VCに入室 | 解除待ちならその場で解除して台帳から削除（ポモドーロ専用VCに限らない） |
| 別のVCへ移動 | 接続が続いているのでその場で解除できる |
| 起動時 | 台帳を読み、接続中の人は解除。未接続の人は**解除待ちのまま保持** |
| `40032` 以外の失敗 | 3回までリトライ → 駄目なら告知チャンネルに `⚠️ ミュート解除に失敗しました` |

台帳は `STATE_DIR/muted-members.json`。**ミュートする前に**書き、解除できて初めて消す。
解除待ちは名前付きボリュームに残るので、コンテナ再作成やクラッシュをまたいでも失われない。

参加者向けには、作業開始の告知に毎回この1行を添えている:

> ⚠ 作業中に抜けるとミュートが残ります。次にVCに入ると自動で解除されます。

解除待ちの人がいるかは `/pomo status` でも確認できる。

### ログの読み方

解除は必ず**結果**が出る。「解除します」だけで結果が出ないことはない（以前それで失敗を見落とした）。

```
[Pomodoro] 解除成功: 2466…（休憩開始）
[Pomodoro] 解除できませんでした: 2466… — VCに接続していないため（Discord仕様 40032）。解除待ちとして台帳に残します。…
[Pomodoro] 休憩開始の解除結果: 解除 2人 / 解除待ち 1人 / 失敗 0人
```
