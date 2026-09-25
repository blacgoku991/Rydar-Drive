# Site Rydar Drive (dashboard, super admin, API v1, mini-sites, inscription chauffeurs).
# Next.js en sortie « standalone » : image autonome, sans node_modules complet.
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_SUPABASE_URL=... -t rydar-web .
# Les variables NEXT_PUBLIC_* sont intégrées au moment du build (navigateur + CSP) : l'image se
# construit avec celles de la production (voir deploy/docker-compose.yml). Les secrets serveur
# (clé service role, Stripe, poivre des clés API…) ne sont passés qu'au démarrage du conteneur.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_ROOT_DOMAIN
ARG NEXT_PUBLIC_MAP_STYLE_URL
ARG NEXT_PUBLIC_MAP_TILES_URL
ARG NEXT_PUBLIC_MAP_GLYPHS_URL
ARG NEXT_PUBLIC_MAP_CONNECT_ORIGINS
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone \
    NODE_OPTIONS=--max-old-space-size=3072 \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_ROOT_DOMAIN=$NEXT_PUBLIC_ROOT_DOMAIN \
    NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL \
    NEXT_PUBLIC_MAP_TILES_URL=$NEXT_PUBLIC_MAP_TILES_URL \
    NEXT_PUBLIC_MAP_GLYPHS_URL=$NEXT_PUBLIC_MAP_GLYPHS_URL \
    NEXT_PUBLIC_MAP_CONNECT_ORIGINS=$NEXT_PUBLIC_MAP_CONNECT_ORIGINS
COPY . .
RUN pnpm install --frozen-lockfile --filter "@rydar/web..." \
 && pnpm --filter @rydar/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Serveur autonome (racine du monorepo) + fichiers statiques et publics à côté de server.js
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
