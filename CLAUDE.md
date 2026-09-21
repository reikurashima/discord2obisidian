# CLAUDE.md — Discord Bot 群

デプロイ先: NAS docker（`\NiceNAS-01\docker\discordbot` = `/volume1/docker/discordbot`）
ビルド:     `docker compose up -d --build`
起動:       ローカル開発時は `npm start`（= `node src/index.js`）

⚠ **このリポジトリには複数のBotが同居しています。** ルート直下の `src/` は Obsidian保存Bot（本番稼働中）。
新しいBotは `apps/<名前>/` に**自己完結**で作ること。**ルートの `package.json` に workspaces を足さない**（既存のビルドが壊れる）。

```
src/              Bot1: Obsidian保存Bot（極東魔術結社・本番稼働中）
apps/niceworker/  Bot3: 通話制御・ポモドーロ（NiceWorker）
apps/pm/          Bot2: タスク管理（NiceCraft Production）
```

---

# Bot1: Obsidian保存Bot（`src/`）

Discordに投稿したメッセージ/画像/URLを Obsidian Vault へ自動保存する。
**3チャンネル**をチャンネルIDで振り分ける。

| チャンネル | 動作 |
|---|---|
| ノート | 1投稿 = 1ノート |
| デイリー | `YYYY-MM-DD.md` に追記 |
| **canvas** | **画像を `.canvas` ファイルにノードとして並べる** |

⚠ **canvas 機能は4か月以上稼働している現役機能。** `src/discord/canvasHandler.js` と `src/utils/canvas.js`。
canvas は URL先の画像を取得して並べるため、**`scraper/urlFetcher.js` の `fetchUrlContent` に依存している**。
「スクレイピングは廃止したから消せる」は**誤り**（ノート・デイリーで使わなくなっただけ）。

## URLの扱い（ノート・デイリー共通・例外なし）

```
1行目          → ノート名
2行目以降      → 本文
1行目が URL    → ノート名は URL を記号→ハイフンに変換したもの
                 例: https://x.com/jack/status/20 → x.com-jack-status-20
                 本文にも同じ URL を展開する
本文中の URL   → 必ず次の形:
                   [[投稿者名]]   ← X / YouTube のときだけ。取れなければ省く
                   ![](URL)
                   URL            ← 埋め込みが効かないサイト用に生URLも残す
複数 URL       → 全部処理する
```

- **URL先の中身は取得しない**（ノート・デイリーのみ。canvas は従来どおり取得する）。
  記事本文のスクレイピングも画像・動画のダウンロードも廃止した（ノートにゴミが混ざる・遅い・分岐が増える）
- 取りに行くのは**投稿者名だけ**。X=fxtwitter API / YouTube=oEmbed。どちらもAPIキー不要・5秒タイムアウト。
  失敗したら `[[投稿者名]]` の行が省かれるだけで処理は続く
- Discord添付画像の保存（WebP変換）は従来どおり有効
- **画像だけの投稿**（テキストなし）も `YYYY-MM-DD-HHMMSS.md` としてノート化する
- 1行目がサニタイズで空文字になる場合（絵文字のみ等）だけ、1行目を本文の先頭にも残す（データを失わない保険）

## デイリーの区切り

**前の投稿から30分以上空いていたら `***` の行を入れてから追記する。** 最終追記時刻は `src/storage/dailyState.js` が持つ。
状態が飛んだら「区切りを入れる」側に倒す（入れすぎは無害、入れ忘れは分かりにくい）。

## 技術構成

- Node.js 20（`"type": "module"`）+ discord.js v14 + `dropbox` SDK + `sharp`
- 設定は `.env`（`STORAGE_MODE=dropbox|local`、`LOCAL_VAULT_PATH` は local 時のみ必須）
- 本番は `STORAGE_MODE=local`、`LOCAL_VAULT_PATH=/vault/00_SCRAPBOX`（`/vault` = `/volume1/syncdata/library`）

```
src/
  index.js              ログイン失敗・invalidated・uncaughtException で exit(1)／SIGTERM対応
  config.js             環境変数
  discord/              client.js / messageHandler.js / canvasHandler.js
  dropbox/              client.js / uploader.js
  storage/              index.js（切替＋書き込み直列化） / local.js（アトミック書き込み） / dailyState.js
  scraper/              urlFetcher.js（URL抽出＋投稿者名＋canvas用のページ取得）
  utils/                image.js / logger.js / markdown.js / sanitize.js / canvas.js
```

---

# ⚠ 実際に事故った knowledge（必ず読むこと）

## 1. リポジトリが本番より古いことがある

**2026-09-21**: リポジトリの最終コミットは 2026-03-19、本番（NAS）のコードは 2026-07-12 だった。
**本番だけに canvas 機能があり、リポジトリには無かった。** 気づかずデプロイしていれば機能が消えていた。

→ **コードを読む前に「本番 vs 手元」を差分で確認すること。**
```bash
diff <(cd 本番/src && find . -type f | sort) <(cd 手元/src && find . -type f | sort)
```

## 2. `docker-compose.yaml` と `.yml` が両方あると `.yml` が読まれる

**2026-09-21 実測。** 以前この文書に「`.yaml` が優先されるので実害なし」と書かれていたが**逆だった**。
`.yaml` に加えた `TZ=Asia/Tokyo` が無視され、コンテナがUTCのままだった。

→ **`.yml` は `/volume1/docker/_old/discordbot/` へ退避済み。二度と両方置かないこと。**

## 3. TZ を指定しないとコンテナはUTCで動く

`node:20-slim` の既定はUTC。**日付の変わり目が朝9時**になり、JST 0:00〜9:00 の投稿が**前日のデイリーノート**に入っていた。
→ compose の `environment` に **`TZ=Asia/Tokyo` を必ず入れる**。新しいBotでも同様。

## 4. ログはローテーションしないと無限に増える

json-file ドライバの既定はローテーションなし。→ `logging.options` に `max-size: "10m"` / `max-file: "3"`。

## 5. 書き込みの直列化とアトミック書き込み

「全文読む→足す→全体を上書き」に排他制御が無く、**連投すると先に書いた分が消えていた**（実測で 8件中1件しか残らなかった）。

- 書き込みは `src/storage/index.js` の**1本のPromiseチェーンで直列化**。新しい書き込みAPIを足すときは必ずここを通すこと
- ローカル保存は**一時ファイル→`fs.rename`**。Vault内に一瞬 `*.tmp` が現れるが Obsidian は無視する
- **デイリーの順序は投稿順**。`reserveDailySlot()` を `await` より**前に同期で呼ぶ**こと。後ろだと投稿者名の取得（最大5秒）を待つ間に後続に追い越される

## 6. Docker が送るのは SIGTERM（SIGINT ではない）

捕まえていないと書き込み中に即死する。`process.on('SIGTERM')` で進行中の書き込みを待ってから exit（上限8秒）。

## 7. ログイン失敗を握りつぶすとコンテナが「起動中」のまま

`restart: unless-stopped` が発火せず、**Discordに繋がっていない空のコンテナが延々 up 表示**になる。
「2か月無停止」は「2か月動いていた」証拠にならない。→ `login()` 失敗・`invalidated`・`uncaughtException` で `exit(1)`。

## 8. 同名ファイルへの追記は意図的な仕様

保存先 `00_SCRAPBOX/` は**2,300件超の手書きノートが並ぶフラットなフォルダ**で、ノート名は日本語の口語。
同名なら追記するのは「同じ概念のページに書き足す」という Scrapbox 思想。**「上書きになっていない」と直さないこと。**

## 9. その他

- `.env` に Discord Token / Dropboxトークンが入る。コミット対象外を徹底（`.gitignore` 済み）
- NAS上のVaultパスは `/volume1/syncdata/library`（Windowsから見た `\NiceNAS-01\syncdata\library`）。`.env` の `LOCAL_VAULT_PATH` と compose のマウント先を一致させる
- ソースファイルは CRLF で入っている（本番も同じ）。Node は問題なく動く
