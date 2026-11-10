# One image, three roles: API (default), worker, and migration job.
# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @reachinbox/api...
COPY apps/api apps/api
RUN pnpm --filter @reachinbox/api exec prisma generate --schema prisma/schema.prisma \
 && pnpm --filter @reachinbox/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/health/live >/dev/null || exit 1
CMD ["node", "dist/server.js"]
