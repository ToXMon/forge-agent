# Forge server — build once, deploy anywhere (Akash, VPS, Fly, ...).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --silent
COPY tsconfig.json ./
COPY src ./src
COPY evals ./evals
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --silent && npm cache clean --force
COPY --from=build /app/dist ./dist
# Sessions/state live here — mount a volume in production.
RUN mkdir -p /data && ln -s /data/.forge /app/.forge
VOLUME /data
ENV FORGE_PORT=8787
EXPOSE 8787
CMD ["node", "dist/src/server/index.js"]
