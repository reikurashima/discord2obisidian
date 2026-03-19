FROM node:20-slim

WORKDIR /bot

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/
RUN chmod -R 755 /bot/src

CMD ["node", "/bot/src/index.js"]
