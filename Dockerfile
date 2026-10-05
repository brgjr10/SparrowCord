# Pinned to the manifest digest of the `22-alpine` tag as of 2026-10-05, so
# `docker compose up -d --build` cannot silently drift to a newer base.
# (SPARROWCORD-016) — READ-ONLY: no Docker daemon or `docker` CLI on this host,
# so the pin is verified by reading the Docker Hub API, not by building.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

LABEL org.opencontainers.image.source="https://github.com/brgjr10/SparrowCord"
LABEL org.opencontainers.image.revision="068b3c4"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8020 \
    STATE_PATH=/app/data/state.json

COPY package.json ./
# No dependencies, so nothing to install: the build never needs the network, which
# is the point on a box that may be offline. If you ever add one, install it here.
COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 8020

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8020)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]