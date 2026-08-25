# apps/demo-store

WooCommerce store in Docker with five seed products and a REST API key. Used by the e2e suite
(scanner -> publish -> agent buys -> order lands in Woo) and by the demo video.

```
pnpm demo:up        # http://localhost:8080  (admin / admin)
pnpm demo:logs      # watch the seeder
pnpm demo:down      # remove containers and volumes
```

REST: `http://localhost:8080/wp-json/wc/v3/products` with basic auth
`ck_agentgate_demo_0000000000000000000000000000000000000000` /
`cs_agentgate_demo_0000000000000000000000000000000000000000` (demo-only, not secrets).

Seeding is idempotent (`seed/seed.sh`). First boot takes 1-3 minutes (WooCommerce download).
