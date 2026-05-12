# ── build the Vite SPA ───────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# base=/ because Fly serves it at the domain root (GitHub Pages uses base=/fx/)
RUN npx vite build --base=/ \
 && mkdir -p dist/data \
 && cp -f data/events.json data/leads.json dist/data/ 2>/dev/null || true

# ── serve it ─────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
