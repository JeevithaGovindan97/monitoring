# syntax=docker/dockerfile:1
# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace server --include-workspace-root=false
COPY server server
RUN npm run build --workspace server

# ---- runtime deps (production only) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace server --omit=dev --include-workspace-root=false

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# pg_dump/pg_restore (major version must match the database image: postgres:15) and openssl for encrypted backups
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/reports /data/backups && chown -R node:node /data
WORKDIR /app/server
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY server/migrations ./migrations
COPY server/package.json ./package.json
ENV REPORTS_DIR=/data/reports BACKUP_DIR=/data/backups PORT=4000
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
