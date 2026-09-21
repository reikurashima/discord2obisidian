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

## ミュート解除の保険

サーバーミュートは「解除し忘れると人が喋れないまま取り残される」ため、3重に保険をかけている。

1. ミュートした人は `STATE_DIR/muted-members.json` に**ミュートする前に**記録する
2. 起動時にその記録を読み、**残っている人を全員解除してから**通常動作に入る
3. `SIGTERM` / `SIGINT` で全解除してから終了する

解除に失敗した場合は、ログと告知チャンネルの両方に出す（黙って失敗させない）。
