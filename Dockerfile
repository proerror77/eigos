# syntax=docker/dockerfile:1
FROM node:22.22.3-bookworm-slim AS build
WORKDIR /app
ARG SOURCE_SHA
ARG RELEASE_BACKEND=codex
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json Dockerfile .dockerignore ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/build.mjs scripts/ontology.mjs scripts/release-artifacts.mjs ./scripts/
COPY scripts/run-local.mjs scripts/agent-request.mjs scripts/agent-enroll.mjs scripts/ontology-operator.mjs ./scripts/
COPY scripts/relocate-primary.mjs scripts/refresh-harness-login.mjs scripts/postgres-primary-handoff.mjs scripts/postgres-node-migrate.mjs scripts/postgres-vector.mjs scripts/postgres-task-vectors.mjs ./scripts/
# build.mjs copies the actual PA Skill assets. Omitting this breaks npm run build.
COPY integrations/grok/eigos-delegate ./integrations/grok/eigos-delegate
COPY integrations/grok/eigos-native/client.mjs ./integrations/grok/eigos-native/client.mjs
RUN npm run build
RUN node scripts/release-artifacts.mjs create --root /app --out /app/release --source-sha "${SOURCE_SHA}" --backend "${RELEASE_BACKEND}"
RUN npm prune --omit=dev && npm cache clean --force

FROM scratch AS release-package
COPY --from=build /app/release /

FROM node:22.22.3-bookworm-slim AS runtime
ARG SOURCE_SHA
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    DATABASE_PATH=/var/lib/eigos/tasks.sqlite \
    HOME=/home/node CODEX_HOME=/home/node/.codex
WORKDIR /app
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# Only the real releaseFiles whitelist enters the runtime filesystem.
COPY --from=build --chown=node:node /app/release/runtime/ ./
COPY --from=build --chown=node:node /app/release/manifest.json ./release/manifest.json
COPY --from=build --chown=node:node /app/release/ontology ./release/ontology
RUN mkdir -p /var/lib/eigos /home/node/.codex \
    && chown -R node:node /var/lib/eigos /home/node/.codex \
    && chmod 700 /var/lib/eigos /home/node/.codex
USER node
VOLUME ["/var/lib/eigos", "/home/node/.codex"]
STOPSIGNAL SIGTERM

FROM runtime AS relay
ENV EIGOS_RELAY_HOST=0.0.0.0 EIGOS_RELAY_PORT=8788 \
    EIGOS_RELAY_DATABASE_PATH=/var/lib/eigos/relay.sqlite
LABEL io.eigos.role="relay"
EXPOSE 8788
CMD ["node", "dist/apps/relay/main.js"]

FROM runtime AS worker
LABEL io.eigos.role="worker"
CMD ["node", "dist/apps/worker/main.js"]

FROM worker AS worker-codex
USER root
RUN npm install --global --omit=dev @openai/codex@0.164.0 \
    && test "$(codex --version)" = "codex-cli 0.164.0" \
    && npm cache clean --force
ENV EIGOS_CODEX_BIN=/usr/local/bin/codex
LABEL io.eigos.model-cli="codex@0.164.0"
USER node

# Generate the same immutable runtime payload with its selected Harness backend.
# This remains a candidate; an initialize-only image smoke is not model or
# business acceptance and does not finalize release publication.
FROM build AS harness-release
ARG SOURCE_SHA
RUN node scripts/release-artifacts.mjs create --root /app --out /app/release-harness --source-sha "${SOURCE_SHA}" --backend harness

FROM scratch AS release-package-harness
COPY --from=harness-release /app/release-harness /

FROM worker AS worker-harness
USER root
# pi-ai is the actual existing codex-oauth provider plugin. Keep it beside dsh
# so native profile resolution also supports that selected account backend.
RUN npm install --prefix /opt/eigos-harness --omit=dev --save-exact --no-audit --no-fund \
      @deepseek-ai/dsh@0.2.1-rc.5 @deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.5 \
    && ln -s /opt/eigos-harness/node_modules/.bin/dsh /usr/local/bin/dsh \
    && test "$(dsh --version)" = "0.2.1-rc.5" \
    && npm cache clean --force
COPY --from=harness-release --chown=node:node /app/release-harness/manifest.json ./release/manifest.json
ENV EIGOS_EXECUTOR=harness EIGOS_HARNESS_BIN=/usr/local/bin/dsh
LABEL io.eigos.model-cli="dsh@0.2.1-rc.5"
USER node

# Keep the ordinary docker build endpoint as the Gateway.
FROM runtime AS gateway
LABEL io.eigos.role="gateway"
EXPOSE 3000
CMD ["node", "dist/apps/gateway/main.js"]
