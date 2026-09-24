# Worker Rydar Drive — dispatch tick, notifications push, ménage.
# docker build -f apps/worker/Dockerfile -t rydar-worker .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm install --frozen-lockfile --filter @rydar/worker... && pnpm --filter @rydar/worker build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080 || exit 1
CMD ["node", "apps/worker/dist/index.js"]
