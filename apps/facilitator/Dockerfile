# Minimal x402 facilitator. Built from the monorepo root:
#   docker build -f apps/facilitator/Dockerfile -t agentgate-facilitator .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/facilitator ./apps/facilitator
RUN pnpm install --frozen-lockfile --filter @agentgate/facilitator... \
 && pnpm --filter @agentgate/core build \
 && pnpm --filter @agentgate/facilitator build \
 && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Never runs as root: this process holds a signing key.
USER node
COPY --from=build --chown=node:node /app /app
EXPOSE 8403
# The container is healthy only while the fee account can still pay for settlements.
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8403)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/facilitator/dist/server.js"]
