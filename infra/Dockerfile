# One multi-stage Dockerfile for all apps; pick a stage with --target (api | worker | builder | tools).
# Prototype images favour simplicity over size: api/worker run from the full workspace install.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
ENV NEXT_STANDALONE=true
RUN pnpm --filter @agentflow/api --filter @agentflow/worker --filter @agentflow/builder build

# Migrations and seed (runs TypeScript directly with tsx).
FROM deps AS tools
CMD ["pnpm", "db:migrate"]

FROM build AS api
ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]

FROM build AS worker
ENV NODE_ENV=production
WORKDIR /repo/apps/worker
CMD ["node", "dist/index.js"]

FROM node:22-alpine AS builder
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/builder/.next/standalone ./
COPY --from=build /repo/apps/builder/.next/static ./apps/builder/.next/static
EXPOSE 3000
CMD ["node", "apps/builder/server.js"]
