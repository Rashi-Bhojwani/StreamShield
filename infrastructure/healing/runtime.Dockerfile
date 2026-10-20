FROM node:24-bookworm-slim
WORKDIR /app
COPY --chmod=644 infrastructure/healing/package.json infrastructure/healing/package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chmod=644 packages/shared/package.json /app/packages/shared/package.json
RUN mkdir -p node_modules/@streamshield && ln -s /app/packages/shared node_modules/@streamshield/shared
USER node
