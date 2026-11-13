FROM node:22.22.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22.22.3-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/apps/gateway/main.js"]

FROM runtime AS worker
CMD ["node", "dist/apps/worker/main.js"]
