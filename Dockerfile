# watchhentai-api on Railway: Bun, one process, no build step.
FROM oven/bun:1
WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src
COPY server.ts ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Railway also checks /api/health; this keeps the container honest locally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["bun", "run", "server.ts"]
