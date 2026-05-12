# ── build the Vite SPA (apps/web) ────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
# build tools for any native deps in the workspace (e.g. better-sqlite3); this is
# only the throwaway builder stage — the final image ships just nginx + dist.
RUN apk add --no-cache python3 make g++
# install workspace deps (root manifest + every workspace package.json + lockfile)
COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/package.json
COPY packages/pipeline/package.json  packages/pipeline/package.json
COPY apps/web/package.json           apps/web/package.json
RUN npm ci
COPY . .
# base=/ because Fly serves it at the domain root (GitHub Pages uses base=/fx/);
# then drop the live data snapshot (data/*.json) into the built dist
RUN npm run build -w @fx/web -- --base=/ \
 && mkdir -p apps/web/dist/data \
 && cp -f data/events.json data/leads.json apps/web/dist/data/ 2>/dev/null || true

# ── serve it ─────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
