# Discord Obsidian Bot

DiscordのメッセージをObsidianノートとして自動保存するボットです。

詳しいセットアップ手順は `docs/setup-guide.pdf` をご覧ください。

## 主な機能

- **ノートチャンネル**: メッセージを個別のMarkdownファイルとして保存
- **デイリーチャンネル**: 1日分のメモを1つのファイルに自動追記
- **AI Clipチャンネル**: Gemini AIによるテキスト整形＆自動保存
- **X(Twitter)連携**: URLを貼るだけで本文・画像・動画・投稿者情報を自動取得
- **ストレージ切替**: Dropbox / NASローカル保存を設定で切替可能

## クイックスタート

1. `.env.example` を `.env` にコピー
2. `.env` に各種キーを記入
3. `docker compose up -d --build` で起動

## ライセンス

MIT
