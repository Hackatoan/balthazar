FROM node:22-bookworm

WORKDIR /app

# System deps for native modules like @discordjs/opus (node-gyp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --production

# Copy source
COPY . .

# Run as the image's unprivileged "node" user (uid 1000) instead of root.
# The app writes to /app/data, /app/public/{clips,uploads} and
# /app/clips-config.json, so hand /app to that user.
RUN mkdir -p data public/clips public/uploads && chown -R node:node /app
USER node

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/index.js"]
