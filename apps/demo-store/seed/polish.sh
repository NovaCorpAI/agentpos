#!/bin/sh
# Storefront polish for the demo store (idempotent, Spanish-first per brand direction).
# Run inside the wp-cli seed container:
#   docker compose -f apps/demo-store/deploy/docker-compose.prod.yml \
#     --env-file /root/.agentpos/demo-store.env run --rm --no-deps \
#     --entrypoint sh demo-seed /seed/polish.sh
# Spanish product names, branded images by SKU, the honest "official demo" notice, clean menu.
set -e
cd /var/www/html

# 1. Spanish product names and descriptions (SKU is the stable key, prices untouched).
rename() {
  sku="$1"; title="$2"; desc="$3"
  id="$(wp post list --post_type=product --field=ID --meta_key=_sku --meta_value="$sku")"
  if [ -z "$id" ]; then
    echo "skip $sku: no product with that SKU"
    return 0
  fi
  wp post update "$id" --post_title="$title" --post_excerpt="$desc" >/dev/null
  echo "renamed $sku -> $title"
}
rename "AP-GUIDE-DIG" "Guia de campo AgentPOS (digital)" "PDF digital: como funciona el comercio agentico, explicado para comercios."
rename "AP-STICKERS-DIG" "Pack de stickers AgentPOS (digital)" "Pack digital de stickers de la marca, listo para imprimir."
rename "AP-SUPPORT" "Apoya AgentPOS" "Aporte simbolico: gracias por apoyar el comercio agentico abierto."

# 2. Product images (re-imports when forced with POLISH_REIMPORT=1, otherwise only fills gaps).
for entry in "AP-GUIDE-DIG:ap-guide-dig.png" "AP-STICKERS-DIG:ap-stickers-dig.png" "AP-SUPPORT:ap-support.png"; do
  sku="${entry%%:*}"
  img="${entry##*:}"
  id="$(wp post list --post_type=product --field=ID --meta_key=_sku --meta_value="$sku")"
  [ -n "$id" ] || continue
  current="$(wp post meta get "$id" _thumbnail_id 2>/dev/null || true)"
  if [ -n "$current" ] && [ "${POLISH_REIMPORT:-0}" != "1" ]; then
    echo "skip image $sku: already set (attachment $current)"
    continue
  fi
  att="$(wp media import "/seed/images/$img" --porcelain)"
  wp post meta update "$id" _thumbnail_id "$att"
  echo "image set: $sku -> attachment $att"
done

# 3. Honest labeling, in Spanish: WooCommerce's store-wide notice.
wp option update woocommerce_demo_store yes
wp option update woocommerce_demo_store_notice "Tienda demo oficial de AgentPOS. Productos reales, pagos reales en USDC sobre Stellar mainnet. Los agentes compran en /agentpos/catalog; el panel publico esta en /agentpos/dashboard."

# 4. Primary menu in Spanish (rebuilt from scratch each run to stay idempotent).
if wp menu list --fields=slug --format=csv | grep -q "^main$"; then
  wp menu delete main
fi
wp menu create "Main"
SHOP_ID="$(wp post list --post_type=page --name=shop --field=ID)"
CART_ID="$(wp post list --post_type=page --name=cart --field=ID)"
[ -n "$SHOP_ID" ] && wp menu item add-post main "$SHOP_ID" --title="Tienda"
[ -n "$CART_ID" ] && wp menu item add-post main "$CART_ID" --title="Carro"
wp menu item add-custom main "Panel de agentes" "/agentpos/dashboard"
wp menu location assign main primary

# 5. Storefront in Spanish (WP core language; es_CL with es_ES fallback).
LANG_OK=""
if wp language core install es_CL 2>/dev/null && wp language core activate es_CL 2>/dev/null; then
  LANG_OK="es_CL"
elif wp language core install es_ES 2>/dev/null && wp language core activate es_ES 2>/dev/null; then
  LANG_OK="es_ES"
fi
if [ -n "$LANG_OK" ]; then
  wp language plugin install woocommerce "$LANG_OK" 2>/dev/null || true
  wp language theme install storefront "$LANG_OK" 2>/dev/null || true
  echo "language: $LANG_OK"
else
  echo "language: keeping en_US (spanish pack unavailable)"
fi
echo "polish done"
