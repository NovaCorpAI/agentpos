<?php
/**
 * Inserts or refreshes the demo REST API key. Run via `wp eval-file /seed/apikey.php`.
 * WooCommerce stores consumer_key as wc_api_hash() (HMAC-SHA256 with key 'wc-api') and the
 * consumer_secret in clear. Demo-only credentials, not secrets.
 */
$ck = getenv('AG_DEMO_CK') ?: 'ck_agentposdemo000000000000000000000000000';
$cs = getenv('AG_DEMO_CS') ?: 'cs_agentposdemo000000000000000000000000000';
if (strlen($ck) !== 43 || strlen($cs) !== 43) {
    echo "[seed] ERROR: demo credentials must be exactly 43 chars (WooCommerce column size)\n";
    exit(1);
}

global $wpdb;
$table = $wpdb->prefix . 'woocommerce_api_keys';
$row = array(
    'user_id'         => 1,
    'description'     => 'agentpos-demo',
    'permissions'     => 'read_write',
    'consumer_key'    => wc_api_hash($ck),
    'consumer_secret' => $cs,
    'truncated_key'   => substr($ck, -7),
);
$id = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM {$table} WHERE description = %s", 'agentpos-demo'));
if ($id) {
    $wpdb->update($table, $row, array('key_id' => (int) $id));
    echo "[seed] refreshed REST API key\n";
} else {
    $wpdb->insert($table, $row);
    echo "[seed] created REST API key\n";
}
if ($wpdb->last_error) {
    echo "[seed] ERROR: {$wpdb->last_error}\n";
    exit(1);
}
