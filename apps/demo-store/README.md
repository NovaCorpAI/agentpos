# apps/demo-store

WooCommerce store in Docker with five seed products and a REST API key. Used by the e2e suite
(scanner -> publish -> agent buys -> order lands in Woo) and by the demo video.

```
pnpm demo:up        # http://localhost:8080  (admin / admin)
pnpm demo:logs      # watch the seeder
pnpm demo:down      # remove containers and volumes
```

REST: `http://localhost:8080/wp-json/wc/v3/products` with basic auth
`ck_agentposdemo0000000000000000000000000000` / `cs_agentposdemo0000000000000000000000000000`
(demo-only, not secrets; 43 chars each because WooCommerce stores secrets in a varchar(43)).

Seeding is idempotent (`seed/seed.sh` + `seed/apikey.php`). First boot takes 1-3 minutes
(WooCommerce download). A demo-only mu-plugin marks authenticated `/wp-json/` requests as SSL
so Basic Auth works over plain HTTP locally; real stores must use HTTPS.
