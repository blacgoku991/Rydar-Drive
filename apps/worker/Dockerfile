# Worker Rydar Drive — tick du dispatch, notifications push, ménage, suivi des vols,
# surveillance des courses, rappels d'échéance des documents.
#   docker build -f apps/worker/Dockerfile -t rydar-worker .
#   docker run -e DATABASE_URL=... -e EXPO_ACCESS_TOKEN=... rydar-worker
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
# Build (tsup embarque @rydar/shared) puis bundle autonome avec les seules dépendances de prod
RUN pnpm install --frozen-lockfile --filter "@rydar/worker..." \
 && pnpm --filter @rydar/worker build \
 && pnpm --filter @rydar/worker deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080 || exit 1
CMD ["node", "dist/index.js"]
