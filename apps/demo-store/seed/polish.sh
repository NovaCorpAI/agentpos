#!/bin/sh
# Storefront polish for the demo store (idempotent). Run inside the wp-cli seed container:
#   docker compose -f apps/demo-store/deploy/docker-compose.prod.yml \
#     --env-file /root/.agentpos/demo-store.env run --rm --no-deps \
#     --entrypoint sh demo-seed /seed/polish.sh
# Product images by SKU, the honest "official demo" store notice, and a clean primary menu.
set -e
cd /var/www/html

# 1. Product images (skip products that already have one, so re-runs do not duplicate media).
for entry in "AP-GUIDE-DIG:ap-guide-dig.png" "AP-STICKERS-DIG:ap-stickers-dig.png" "AP-SUPPORT:ap-support.png"; do
  sku="${entry%%:*}"
  img="${entry##*:}"
  id="$(wp post list --post_type=product --field=ID --meta_key=_sku --meta_value="$sku")"
  if [ -z "$id" ]; then
    echo "skip $sku: no product with that SKU"
    continue
  fi
  current="$(wp post meta get "$id" _thumbnail_id 2>/dev/null || true)"
  if [ -n "$current" ]; then
    echo "skip $sku: already has image (attachment $current)"
    continue
  fi
  att="$(wp media import "/seed/images/$img" --porcelain)"
  wp post meta update "$id" _thumbnail_id "$att"
  echo "image set: $sku -> attachment $att"
done

# 2. Honest labeling: WooCommerce's store-wide notice, always visible.
wp option update woocommerce_demo_store yes
wp option update woocommerce_demo_store_notice "Official AgentPOS demo store. Real products, real USDC payments on Stellar mainnet. AI agents buy at /agentpos/catalog; the public dashboard lives at /agentpos/dashboard."

# 3. Primary menu: Shop, Cart, Agent dashboard (replaces the fallback page menu).
if ! wp menu list --fields=slug --format=csv | grep -q "^main$"; then
  wp menu create "Main"
  SHOP_ID="$(wp post list --post_type=page --name=shop --field=ID)"
  CART_ID="$(wp post list --post_type=page --name=cart --field=ID)"
  [ -n "$SHOP_ID" ] && wp menu item add-post main "$SHOP_ID" --title="Shop"
  [ -n "$CART_ID" ] && wp menu item add-post main "$CART_ID" --title="Cart"
  wp menu item add-custom main "Agent dashboard" "/agentpos/dashboard"
fi
wp menu location assign main primary
echo "polish done"
