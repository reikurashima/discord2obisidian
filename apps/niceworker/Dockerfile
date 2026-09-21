FROM node:20-slim

WORKDIR /bot

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/
RUN chmod -R 755 /bot/src

# ミュート記録の置き場。docker-compose.yaml で名前付きボリュームを当てる
RUN mkdir -p /data

CMD ["node", "/bot/src/index.js"]
