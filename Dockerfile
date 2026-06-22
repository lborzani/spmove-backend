# ── Stage 1: Build TypeScript ────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY data/gtfs-stops.json ./static/gtfs-stops.json
COPY data/metro-lines.json ./static/metro-lines.json
COPY data/route-colors.json ./static/route-colors.json

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
