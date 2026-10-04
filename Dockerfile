FROM node:22-alpine

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