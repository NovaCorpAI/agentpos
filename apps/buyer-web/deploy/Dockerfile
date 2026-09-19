# The buyer space (apps/buyer-web) as a container. Built from the monorepo root:
#   docker build -f apps/buyer-web/deploy/Dockerfile -t agentpos-buyer-web .
FROM node:22-alpine AS build
WORKDIR /app
# CI=true: pnpm prune must not stop to ask for a TTY confirmation inside a build.
ENV CI=true
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# The whole `packages` tree: buyer-web depends on @agentpos/core and @agentpos/mcp-buyer, and
# its dev dependency on @agentpos/site (tests spin a real store in-process) is part of the
# workspace graph the filtered install resolves.
COPY packages ./packages
COPY apps/buyer-web ./apps/buyer-web
RUN pnpm install --frozen-lockfile --filter @agentpos/buyer-web... \
 && pnpm --filter @agentpos/core build \
 && pnpm --filter @agentpos/mcp-buyer build \
 && pnpm --filter @agentpos/buyer-web build \
 && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# This process holds no wallet key and cannot sign (see apps/buyer-web/README.md), but it does
# hold the WhatsApp messaging credentials, the signer-bridge token and the owner's mandate:
# never root.
RUN mkdir -p /data && chown node:node /data
USER node
COPY --from=build --chown=node:node /app /app
# /data holds the SQLite database. Mount it; on a bind mount the host directory must be owned
# by uid 1000 (the `node` user) or the first write fails.
ENV AGENTPOS_HOME=/data
ENV BUYER_WEB_DB=/data/buyer-web.sqlite
# 8788 is the default BUYER_WEB_PORT in apps/buyer-web/src/config.ts; the compose file pins it.
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BUYER_WEB_PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/buyer-web/dist/server.js"]
