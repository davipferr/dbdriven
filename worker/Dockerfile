FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY src ./src
# No `node --watch` here: in watch mode a crashed process just waits for a file
# change, so Docker would never restart it (and the `crash` job demo needs that).
# After editing src/, run: docker compose restart worker
CMD ["node", "src/worker.js"]
