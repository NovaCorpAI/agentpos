/**
 * Reconciliation export (unified conciliation file): one CSV row per order, in the shape an
 * accountant or an ERP import expects. Money is formatted from integer minor units via the core
 * money helpers, never floats (guardrail 4). RFC 4180 quoting, CRLF rows, UTF-8 BOM so Excel
 * opens it with the right encoding out of the box.
 *
 * Privacy: the CSV carries buyer emails, which the merchant already sees on each of their own
 * orders; the endpoint lives on the dashboard path with the rest of the merchant surface and
 * exposes nothing an agent-facing endpoint does not already hand the merchant.
 */
import { formatUsdc } from "@agentpos/core";
import type { Order } from "@agentpos/core";

/** UTF-8 byte order mark, so Excel detects the encoding instead of guessing Latin-1. */
export const CSV_BOM = String.fromCharCode(0xfeff);
const CRLF = String.fromCharCode(13, 10);

/** Column order is fixed; only the header labels are localized. */
const EXPORT_HEADERS = {
  en: [
    "date_iso",
    "order_id",
    "external_order_id",
    "status",
    "items",
    "gross_usdc",
    "rail",
    "asset",
    "tx_hash",
    "settled_at",
    "buyer_email",
  ],
  es: [
    "fecha",
    "orden",
    "orden_externa",
    "estado",
    "items",
    "monto_usdc",
    "riel",
    "activo",
    "hash_transaccion",
    "liquidado_el",
    "correo_comprador",
  ],
} as const;

/** RFC 4180: quote a field containing comma, quote or line breaks; double inner quotes. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The payment rail, derived from the payment record's network ("stellar:testnet" ->
 * "x402-stellar"). Constant today; when a second rail lands, its payment records carry another
 * network and the CSV schema does not change.
 */
function railOf(network: string): string {
  const chain = network.split(":")[0];
  return chain ? `x402-${chain}` : "";
}

function rowOf(order: Order): string[] {
  const payment = order.payment;
  return [
    order.createdAt,
    order.id,
    order.externalOrderId ?? "",
    order.status,
    order.quote.lines.map((l) => `${l.title} x ${l.quantity}`).join("; "),
    formatUsdc(payment?.amountMinor ?? order.quote.totalUsdc),
    payment ? railOf(payment.network) : "",
    payment?.asset ?? "",
    payment?.txHash ?? "",
    payment?.ts ?? "",
    order.buyer?.email ?? "",
  ];
}

/** Builds the complete CSV document, BOM included. */
export function buildReconciliationCsv(orders: Order[], locale: "en" | "es"): string {
  const lines = [
    EXPORT_HEADERS[locale].join(","),
    ...orders.map((order) => rowOf(order).map(csvField).join(",")),
  ];
  return CSV_BOM + lines.join(CRLF) + CRLF;
}
