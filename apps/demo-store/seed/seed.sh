#!/usr/bin/env sh
# Seeds the demo WooCommerce store. Idempotent: re-running skips what exists.
set -eu

SITE_URL="${SITE_URL:-http://localhost:8080}"
# Demo-only REST credentials (NOT secrets; allowlisted in .gitleaks.toml).
# Exactly 43 chars each: WooCommerce stores consumer_secret in a varchar(43) column.
CK="ck_agentposdemo000000000000000000000000000"
CS="cs_agentposdemo000000000000000000000000000"
export AG_DEMO_CK="$CK" AG_DEMO_CS="$CS"

echo "[seed] waiting for WordPress files..."
until [ -f /var/www/html/wp-config.php ]; do sleep 2; done
echo "[seed] waiting for database..."
until wp db check >/dev/null 2>&1; do sleep 2; done

if ! wp core is-installed >/dev/null 2>&1; then
  wp core install --url="$SITE_URL" --title="AgentPOS Demo Store" \
    --admin_user=admin --admin_password=admin --admin_email=admin@example.com --skip-email
fi

wp rewrite structure '/%postname%/' --hard >/dev/null
wp plugin is-installed woocommerce >/dev/null 2>&1 || wp plugin install woocommerce --activate
wp plugin is-active woocommerce >/dev/null 2>&1 || wp plugin activate woocommerce
wp option update woocommerce_currency USD >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
wp option update woocommerce_store_address "1 Demo St" >/dev/null
wp option update woocommerce_default_country "US:CA" >/dev/null

seed_product() {
  name="$1"; sku="$2"; price="$3"; stock="$4"; desc="$5"
  if wp wc product list --user=admin --sku="$sku" --field=id | grep -q .; then
    echo "[seed] product $sku exists"
  else
    wp wc product create --user=admin --name="$name" --sku="$sku" --type=simple \
      --regular_price="$price" --manage_stock=true --stock_quantity="$stock" \
      --description="$desc" --short_description="$desc" >/dev/null
    echo "[seed] created $sku"
  fi
}

seed_product "Ceramic Mug 350ml" "AG-MUG-350" "9.90" 50 "White ceramic mug, 350 ml, dishwasher safe."
seed_product "Organic Coffee Beans 500g" "AG-COFFEE-500" "14.50" 40 "Single-origin arabica, medium roast, 500 g bag."
seed_product "Notebook A5 Dotted" "AG-NOTE-A5" "6.00" 100 "A5 notebook, 160 pages, dotted, 100 gsm paper."
seed_product "USB-C Cable 1m" "AG-CABLE-1M" "4.25" 200 "USB-C to USB-C, 1 m, 60 W, USB 2.0 data."
seed_product "Sticker Pack" "AG-STICKERS" "3.00" 500 "10 vinyl stickers, waterproof, assorted designs."

# Demo-only mu-plugin: WooCommerce accepts Basic Auth on the REST API only over SSL.
# The local store runs on plain HTTP, so REST requests carrying an Authorization header
# are treated as SSL. Never ship this to a real store: use HTTPS there.
mkdir -p /var/www/html/wp-content/mu-plugins
cat > /var/www/html/wp-content/mu-plugins/agentpos-demo.php <<'PHP'
<?php
/* Plugin Name: AgentPOS demo store helpers (local only) */
if (
    isset($_SERVER['REQUEST_URI']) && strpos($_SERVER['REQUEST_URI'], '/wp-json/') !== false
    && (isset($_SERVER['HTTP_AUTHORIZATION']) || isset($_SERVER['PHP_AUTH_USER']))
) {
    $_SERVER['HTTPS'] = 'on';
}
PHP

# REST API key: see seed/apikey.php (wc_api_hash for the key, clear secret, 43 chars).
wp eval-file /seed/apikey.php

echo "[seed] done. Store: $SITE_URL  REST: $SITE_URL/wp-json/wc/v3/products"
echo "[seed] consumer_key=$CK consumer_secret=$CS"
