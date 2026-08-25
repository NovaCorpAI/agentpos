# @agentgate/scanner

Reads the merchant's OWN site and proposes an agent catalog draft (SPEC 05). Nothing is
published without a human confirming each item (guardrail 5).

Sources, by trust:

1. Platform connector (`listProducts`): ids, prices, stock, physical flag.
2. `sitemap.xml` (+ indexes) -> product pages -> JSON-LD `schema.org/Product|Service`, then
   Open Graph product tags. Same origin only, `robots.txt` respected (guardrail 8).
3. Optional LLM redaction (`descriptionAgent`, attributes) that may only restate facts present in
   the page; every LLM edit is recorded as evidence.

Prices: the source price/currency is kept; a USDC suggestion is produced only for USD (1:1).
The human sets or confirms every USDC price in `agentgate confirm`.
