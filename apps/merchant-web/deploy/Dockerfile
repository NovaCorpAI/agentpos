# The merchant onboarding wizard (apps/merchant-web) as a container. Built from the monorepo
# root:
#   docker build -f apps/merchant-web/deploy/Dockerfile -t agentpos-merchant-web .
FROM node:22-alpine AS build
WORKDIR /app
# CI=true: pnpm prune must not stop to ask for a TTY confirmation inside a build.
ENV CI=true
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# The whole `packages` tree: merchant-web depends on @agentpos/core and @agentpos/site, and
# site pulls in connectors, policy, approvals, identity, receipts and scanner through the
# workspace graph the filtered install resolves.
COPY packages ./packages
COPY apps/merchant-web ./apps/merchant-web
# The recursive filtered build runs each workspace package in topological order, so core is
# compiled before site and site before the wizard.
RUN pnpm install --frozen-lockfile --filter "@agentpos/merchant-web..." \
 && pnpm --filter "@agentpos/merchant-web..." build \
 && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# This process is stateless: no database, no volume, no secret of any kind. It still runs as
# the non-root `node` user, because a public HTTP surface that fetches URLs other people typed
# is exactly the process you do not want running as root.
USER node
COPY --from=build --chown=node:node /app /app
# 8410 is the default port in apps/merchant-web/src/server.ts (`process.env.PORT ?? 8410`);
# the compose file pins it and the Caddy block proxies to it.
ENV PORT=8410
EXPOSE 8410
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8410)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/merchant-web/dist/server.js"]
