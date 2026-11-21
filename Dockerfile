# Sticky processor: Cloud Run in the TEMP project (never Asaply's).
# Debian's ffmpeg includes zscale (libzimg), so HDR iPhone footage is tonemapped to SDR here.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY web ./web
# Overlay text font (Poppins, OFL) and a fontconfig that knows only it (src/overlays.ts).
COPY assets ./assets
ENV NODE_ENV=production STICKY_WORK_DIR=/tmp/sticky
CMD ["node", "--import", "tsx", "src/server.ts"]
