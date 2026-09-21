FROM node:20-slim

# ⚠ git と ca-certificates を入れる。
#    Claude Code は内部で git を呼ぶ場面があり、未インストールだと
#    「動いているように見えて一部だけ失敗する」状態になる。
#    ca-certificates が無いと HTTPS 通信（認証・API）が証明書検証で落ちる。
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Claude Code 本体（ヘッドレス実行 `claude -p` に使う）
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 依存パッケージなし（素の Node のみ）なので npm install は走らせない。
# package.json は "type": "module" を効かせるために入れる
COPY package.json ./
COPY src/ ./src/

# ジョブごとの使い捨て作業ディレクトリ（コンテナ内に閉じる。マウントしない）
RUN mkdir -p /work

CMD ["node", "/app/src/index.js"]
