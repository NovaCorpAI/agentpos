/**
 * BuyerService: search -> cart -> mandate check -> pay (x402) -> receipt + spending log.
 * The agent never sees the key and never edits the mandate.
 */
import {
  AgentPOSError,
  ERROR_CODES,
  compareUsdc,
  createBuyerFetch,
  createLocalKeypairSigner,
  formatUsdc,
  isAgentPOSError,
  loadKeypair,
  receiptFromResponse,
  resolveConfig,
  usdc,
  usdcFromMinor,
} from "@agentpos/core";
import type {
  Address,
  BuyerContact,
  BuyerLimits,
  BuyerNetworkExtension,
  CartLine,
  CoreConfig,
  SettlementReceipt,
  SignerProvider,
  UsdcMinor,
} from "@agentpos/core";
import { allowedNetworks, evaluateMandate, periodStart, toMandateError } from "./mandate.js";
import { mergeFacets, sortOffers, toOffer } from "./market.js";
import type {
  MandateContext,
  MarketCallRequest,
  MarketCallResult,
  MarketOffer,
  MarketStoreReport,
} from "./market.js";
import { clearApproval, getApproval, recordDecline, requestApproval } from "./profile.js";
import type { Profile } from "./profile.js";
import { SiteClient, cartTotalMinor } from "./siteClient.js";
import type { CatalogQuery, SiteCart, SiteFacets, SiteItem, SiteOrder } from "./siteClient.js";
import { SpendingLog } from "./spending.js";

/** How long one store gets to answer a market call before it is reported as `timeout`. */
export const MARKET_CALL_TIMEOUT_MS = 8_000;

/** Marks the store that ran out of time, so the report can say `timeout` and not `error`. */
class StoreTimeout extends AgentPOSError {}

/**
 * Runs `work` with a deadline. The store's own request timeouts still apply underneath; this
 * one bounds the whole conversation with a store (its pages included), which is what keeps a
 * single slow seller from holding up the market call.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new StoreTimeout("SITE_UNREACHABLE", `${url} did not answer within ${ms} ms`, {
                hint: "The store is slow or down; the other stores answered. Try again later, or raise the per-store timeout.",
                retryable: true,
                details: { timeoutMs: ms, url },
              }),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type PayFetchFactory = (
  core: CoreConfig,
  signer: SignerProvider,
  limits: BuyerLimits,
  extensions: ReadonlyArray<BuyerNetworkExtension>,
) => typeof globalThis.fetch;

/**
 * Another network the buyer can pay on, brought by a rail package and bound to the buyer's own
 * signer there: given the payment's ceiling in the catalog's unit, it returns the extension with
 * the ceiling converted to that network (e.g. `(max) => arcBuyerExtension(ARC_TESTNET, client,
 * max)`). It is used only when the mandate lists its network in `allowedNetworks`.
 */
export type BuyerNetwork = (maxPerPayment: UsdcMinor) => BuyerNetworkExtension;

export interface BuyerDeps {
  profile: Profile;
  passphrase?: string;
  /** Tests inject a fake; production signs with the profile keypair. */
  signer?: SignerProvider;
  payFetchFactory?: PayFetchFactory;
  /** Extra networks the buyer can pay on; the mandate decides which ones it may (M3). */
  networks?: ReadonlyArray<BuyerNetwork>;
  fetchImpl?: typeof globalThis.fetch;
  spendingLog?: SpendingLog;
  core?: CoreConfig;
  log?: (message: string) => void;
}

export interface Offer extends SiteItem {
  site: string;
  siteName: string;
}

export interface BuyResult {
  orderId: string;
  cartId: string;
  site: string;
  receipt: SettlementReceipt;
  order: SiteOrder;
}

export class BuyerService {
  readonly profile: Profile;
  private readonly core: CoreConfig;
  private readonly spending: SpendingLog;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly payFetchFactory: PayFetchFactory;
  private readonly log: (m: string) => void;
  private signerCache: SignerProvider | undefined;

  constructor(private readonly deps: BuyerDeps) {
    this.profile = deps.profile;
    this.core =
      deps.core ??
      resolveConfig({
        network: deps.profile.network,
        allowMainnet: deps.profile.network === "mainnet",
      });
    this.spending = deps.spendingLog ?? SpendingLog.forProfile(deps.profile.name);
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.payFetchFactory = deps.payFetchFactory ?? createBuyerFetch;
    this.log = deps.log ?? (() => {});
    if (deps.signer) this.signerCache = deps.signer;
  }

  private signer(): SignerProvider {
    if (this.signerCache) return this.signerCache;
    const passphrase = this.deps.passphrase ?? process.env.AGENTPOS_BUYER_PASSPHRASE;
    if (!passphrase) {
      throw new AgentPOSError("CONFIG_INVALID", "Wallet is locked", {
        hint: "Set AGENTPOS_BUYER_PASSPHRASE for the MCP server process (the human who owns the wallet does this, never the agent).",
      });
    }
    const kp = loadKeypair(this.profile.keyFile, passphrase);
    this.signerCache = createLocalKeypairSigner(kp.secret(), this.profile.network);
    return this.signerCache;
  }

  site(url: string): SiteClient {
    return new SiteClient(url, this.fetchImpl);
  }

  async searchOffers(query: string, sites?: string[], maxPriceMinor?: bigint): Promise<Offer[]> {
    const targets = [...new Set([...(sites ?? []), ...this.profile.sites])];
    if (targets.length === 0) {
      throw new AgentPOSError("CONFIG_INVALID", "No sites to search", {
        hint: "Pass `sites: [url]` or add store URLs to the profile (`agentpos-buyer sites add <url>`).",
      });
    }
    const results = await Promise.all(
      targets.map(async (url) => {
        const client = this.site(url);
        try {
          const [info, items] = await Promise.all([client.info(), client.search(query)]);
          return items.map((i) => ({ ...i, site: client.url, siteName: info.name }));
        } catch (err) {
          this.log(`search skipped ${url}: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Offer[];
        }
      }),
    );
    const flat = results.flat();
    return maxPriceMinor === undefined
      ? flat
      : flat.filter((o) => BigInt(o.price.minor) <= maxPriceMinor);
  }

  /**
   * Market call: ONE structured request, asked of every store the mandate allows, answered
   * with offers that can be compared side by side.
   *
   * The mandate decides the universe: a site it forbids is never queried, and says so in
   * `stores`. Each store gets its own deadline and its own failure; whoever did not answer is
   * named instead of silently dropped. Offers outside the mandate are listed and labelled
   * `payable: false` with the reason, never hidden.
   */
  async marketCall(request: MarketCallRequest): Promise<MarketCallResult> {
    const quantity = request.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new AgentPOSError("CONFIG_INVALID", `Invalid quantity ${String(quantity)}`, {
        hint: "Use an integer between 1 and 999.",
        details: { quantity },
      });
    }
    const minPriceUsdc =
      request.minPriceUsdc === undefined ? undefined : usdc(request.minPriceUsdc);
    const maxPriceUsdc =
      request.maxPriceUsdc === undefined ? undefined : usdc(request.maxPriceUsdc);
    if (
      minPriceUsdc !== undefined &&
      maxPriceUsdc !== undefined &&
      compareUsdc(minPriceUsdc, maxPriceUsdc) > 0
    ) {
      throw new AgentPOSError("CONFIG_INVALID", "minPriceUsdc is greater than maxPriceUsdc", {
        hint: "Use minPriceUsdc <= maxPriceUsdc, both decimal USDC amounts.",
        details: { minPriceUsdc: request.minPriceUsdc, maxPriceUsdc: request.maxPriceUsdc },
      });
    }
    const attributes = request.attributes ?? {};
    const targets = [...new Set([...(request.sites ?? []), ...this.profile.sites])];
    if (targets.length === 0) {
      throw new AgentPOSError("CONFIG_INVALID", "No sites to call", {
        hint: "Pass `sites: [url]` or add store URLs to the profile (`agentpos-buyer sites add <url>`).",
      });
    }
    const query: CatalogQuery = {
      ...(request.what ? { q: request.what } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(minPriceUsdc !== undefined ? { minPriceUsdc } : {}),
      ...(maxPriceUsdc !== undefined ? { maxPriceUsdc } : {}),
      ...(request.physical !== undefined ? { physical: request.physical } : {}),
    };
    const context: MandateContext = {
      mandate: this.profile.mandate,
      spentInPeriod: usdcFromMinor(this.spentInPeriod()),
    };
    const timeoutMs = request.timeoutMs ?? MARKET_CALL_TIMEOUT_MS;

    const allowed: string[] = [];
    const reports: MarketStoreReport[] = [];
    for (const url of targets) {
      const forbidden = this.forbiddenStore(url);
      if (forbidden) reports.push(forbidden);
      else allowed.push(url);
    }
    const answered = await Promise.all(
      allowed.map((url) =>
        this.callStore(url, query, { attributes, quantity }, context, timeoutMs),
      ),
    );
    const offers: MarketOffer[] = [];
    const facets: SiteFacets[] = [];
    for (const answer of answered) {
      reports.push(answer.report);
      offers.push(...answer.offers);
      facets.push(answer.facets);
    }
    reports.sort((a, b) => a.url.localeCompare(b.url));
    return {
      query: {
        what: request.what,
        attributes,
        quantity,
        ...(minPriceUsdc !== undefined ? { minPriceUsdc: formatUsdc(minPriceUsdc) } : {}),
        ...(maxPriceUsdc !== undefined ? { maxPriceUsdc: formatUsdc(maxPriceUsdc) } : {}),
        ...(request.physical !== undefined ? { physical: request.physical } : {}),
      },
      offers: sortOffers(offers),
      stores: reports,
      facets: mergeFacets(facets),
    };
  }

  /** A store the mandate's allowlist rules out. Reported, never contacted. */
  private forbiddenStore(url: string): MarketStoreReport | undefined {
    const allowedSellers = this.profile.mandate.allowedSellers;
    if (!Array.isArray(allowedSellers)) return undefined;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return {
        url,
        name: url,
        host: url,
        state: "error",
        offers: 0,
        error: {
          code: "CONFIG_INVALID",
          message: `'${url}' is not a valid store URL`,
          hint: "Use a full URL, e.g. https://shop.example.",
        },
      };
    }
    if (allowedSellers.includes(host)) return undefined;
    return {
      url,
      name: host,
      host,
      state: "not-allowed",
      offers: 0,
      error: {
        code: "SELLER_UNVERIFIED",
        message: `${host} is not in the mandate allowlist, so it was not asked`,
        hint:
          allowedSellers.length === 0
            ? 'The allowlist is empty, so no store can be called. Ask the human to add hosts to allowedSellers, or to set it to "any".'
            : `Allowed: ${allowedSellers.join(", ")}. Ask the human to add ${host}.`,
      },
    };
  }

  /** One store's half of the market call. Never throws: a failure becomes a report. */
  private async callStore(
    url: string,
    query: CatalogQuery,
    request: { attributes: Record<string, string>; quantity: number },
    context: MandateContext,
    timeoutMs: number,
  ): Promise<{ report: MarketStoreReport; offers: MarketOffer[]; facets: SiteFacets }> {
    const client = this.site(url);
    const base: Pick<MarketStoreReport, "url" | "host"> = { url: client.url, host: client.host };
    try {
      const page = await withDeadline(client.catalog(query), timeoutMs, client.url);
      const store = { name: page.siteName ?? client.host, url: client.url, host: client.host };
      const offers = page.items.map((item) => toOffer(item, store, request, context));
      return {
        report: {
          ...base,
          name: store.name,
          state: page.degraded ? "unsupported-filters" : "ok",
          offers: offers.length,
          total: page.page.total,
          ...(page.truncated ? { truncated: true } : {}),
          ...(page.degraded
            ? {
                error: {
                  code: "SPEC_MISMATCH",
                  message:
                    "The store refused the structured filters, so it was asked plainly and filtered here",
                  hint: "Its counts and facets are computed by the buyer; update the store to get them from the source.",
                },
              }
            : {}),
        },
        offers,
        facets: page.facets,
      };
    } catch (err) {
      this.log(`market call skipped ${url}: ${err instanceof Error ? err.message : String(err)}`);
      const shaped = isAgentPOSError(err)
        ? err
        : new AgentPOSError("INTERNAL", err instanceof Error ? err.message : String(err), {
            hint: "The store answered with something this buyer could not read.",
          });
      return {
        report: {
          ...base,
          name: client.host,
          state: err instanceof StoreTimeout ? "timeout" : "error",
          offers: 0,
          error: { code: shaped.code, message: shaped.message, hint: shaped.hint },
        },
        offers: [],
        facets: {},
      };
    }
  }

  async createCart(
    siteUrl: string,
    items: CartLine[],
    buyer?: BuyerContact,
    shipping?: Address,
  ): Promise<SiteCart> {
    const client = this.site(siteUrl);
    const contact = buyer ?? this.profile.buyer;
    let address = shipping;
    if (this.profile.mandate.shippingAddressLocked) {
      if (
        shipping &&
        this.profile.shipping &&
        JSON.stringify(shipping) !== JSON.stringify(this.profile.shipping)
      ) {
        throw new AgentPOSError("MANDATE_EXCEEDED", "Shipping address is locked by the mandate", {
          hint: "Omit `shipping`; the profile address is used automatically.",
        });
      }
      address = this.profile.shipping;
    }
    return client.createCart(items, contact, address);
  }

  private spentInPeriod(): bigint {
    return this.spending.totalSince(periodStart(this.profile.mandate.period));
  }

  async buy(siteUrl: string, cartId: string): Promise<BuyResult> {
    const client = this.site(siteUrl);
    const info = await client.info();
    // A facilitator already declined this cart somewhere (F3): only the human can send it to
    // another network, and never back to the one that declined it.
    const approval = getApproval(this.profile.name, cartId);
    const declined = approval?.declinedOn ?? [];
    if (declined.length > 0 && !approval?.approvedAt) {
      throw new AgentPOSError(
        "PAYMENT_DECLINED",
        `Cart ${cartId} was declined on ${declined.join(", ")}`,
        {
          hint: `Nothing was charged. Paying it on another allowed network is the human's decision: they run \`agentpos-buyer approve ${cartId}\`, then call buy again.`,
          details: { declinedOn: declined },
        },
      );
    }
    const allowed = allowedNetworks(this.profile.mandate, this.core.caip2).filter(
      (n) => !declined.includes(n),
    );
    const ownNetworkAllowed = allowed.includes(this.core.caip2);
    const installed = (this.deps.networks ?? []).map((n) => n(usdcFromMinor(0n)).network);
    const payable = [
      ...(ownNetworkAllowed ? [this.core.caip2] : []),
      ...installed.filter((n) => allowed.includes(n)),
    ];
    if (payable.length === 0) {
      throw new AgentPOSError(
        "NETWORK_NOT_ALLOWED",
        "The mandate allows no network this buyer can pay on",
        {
          hint: `Allowed by the mandate: ${allowed.join(", ")}. Installed here: ${[this.core.caip2, ...installed].join(", ")}. Ask the human to add a network to allowedNetworks.`,
          details: { allowedNetworks: allowed, installed: [this.core.caip2, ...installed] },
        },
      );
    }
    // A store on another network is fine when an extra network can pay it: the 402 lists every
    // network the store takes, and only the payable ones have a scheme here.
    if (!payable.includes(info.network) && payable.every((n) => n === this.core.caip2)) {
      throw new AgentPOSError(
        "SPEC_MISMATCH",
        `Site settles on ${info.network}, profile is ${this.core.caip2}`,
        {
          hint: "Use a profile on the same network as the store.",
        },
      );
    }
    const cartRes = await this.fetchImpl(
      `${client.url}/agentpos/cart/${encodeURIComponent(cartId)}`,
      { headers: { accept: "application/json" } },
    );
    if (!cartRes.ok) {
      throw new AgentPOSError(
        cartRes.status === 410 ? "CART_EXPIRED" : "CART_NOT_FOUND",
        `Cart ${cartId} is not available (${cartRes.status})`,
        {
          hint: "Create a new cart with create_cart.",
        },
      );
    }
    const cart = (await cartRes.json()) as SiteCart;
    const amount = cartTotalMinor(cart);
    const hasPhysical = cart.quote.lines.some((l) => l.physical);
    const verdict = evaluateMandate(this.profile.mandate, {
      amount,
      siteHost: client.host,
      hasPhysicalItems: hasPhysical,
      spentInPeriod: this.spentInPeriod() as never,
      humanApproved: Boolean(approval?.approvedAt),
    });
    if (!verdict.ok) {
      if (verdict.code === "CONFIRMATION_REQUIRED") {
        requestApproval(this.profile.name, {
          cartId,
          site: client.url,
          amount: formatUsdc(amount),
          summary: cart.quote.lines.map((l) => `${l.quantity} x ${l.title}`).join(", "),
          requestedAt: new Date().toISOString(),
        });
      }
      throw toMandateError(verdict);
    }

    // One ceiling, the cart total, on every payable network (converted exactly by each rail).
    // The profile's own network is always registered by the client, so when the mandate leaves
    // it out its ceiling is zero: nothing can be authorized there (M3).
    const extensions = (this.deps.networks ?? [])
      .map((n) => n(amount))
      .filter((ext) => allowed.includes(ext.network));
    const payFetch = this.payFetchFactory(
      this.core,
      this.signer(),
      { maxPerPayment: ownNetworkAllowed ? amount : usdcFromMinor(0n) },
      extensions,
    );
    this.log(
      `paying cart ${cartId} at ${client.url}: ${formatUsdc(amount)} ${this.core.checkoutAsset}`,
    );
    // Pay against the host we reached (the cart's absolute `checkout` uses the site's public URL,
    // which may differ from how this buyer addresses it, e.g. behind proxies or in e2e).
    const checkoutUrl = `${client.url}${client.basePath}/checkout?cart=${encodeURIComponent(cartId)}`;
    const response = await payFetch(checkoutUrl, { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as {
      orderId?: string;
      error?: {
        code?: string;
        message?: string;
        hint?: string;
        retryable?: boolean;
        details?: Record<string, unknown>;
      };
    };
    if (response.status !== 200 || !body.orderId) {
      // The store names why the payment failed (F3); keep its code when it is one of ours.
      const code = ERROR_CODES.find((k) => k === body.error?.code) ?? "PAYMENT_REJECTED";
      const network =
        typeof body.error?.details?.network === "string" ? body.error.details.network : undefined;
      if (code === "PAYMENT_DECLINED" && network) {
        recordDecline(
          this.profile.name,
          {
            cartId,
            site: client.url,
            amount: formatUsdc(amount),
            summary: cart.quote.lines.map((l) => `${l.quantity} x ${l.title}`).join(", "),
            requestedAt: new Date().toISOString(),
          },
          network,
        );
      }
      throw new AgentPOSError(code, body.error?.message ?? `Checkout answered ${response.status}`, {
        hint: body.error?.hint ?? "The payment was not settled; nothing was charged.",
        retryable: body.error?.retryable ?? false,
        details: { ...body.error?.details, status: response.status, code: body.error?.code },
      });
    }
    const receipt = receiptFromResponse(response);
    this.spending.append({
      ts: new Date().toISOString(),
      profile: this.profile.name,
      site: client.url,
      cartId,
      orderId: body.orderId,
      txHash: receipt.txHash,
      network: receipt.network,
      asset:
        extensions.find((ext) => ext.network === receipt.network)?.asset ?? this.core.checkoutAsset,
      amountMinor: amount.toString(),
      summary: cart.quote.lines.map((l) => `${l.quantity} x ${l.title}`).join(", "),
    });
    if (!payable.includes(receipt.network)) {
      // Cannot happen through the x402 client (it holds no scheme for other networks); checked
      // anyway, after the spending log, so money that did move still counts against the limit.
      throw new AgentPOSError("NETWORK_NOT_ALLOWED", `Settled on ${receipt.network}`, {
        hint: "Report this: the payment settled on a network the mandate does not allow.",
        details: { network: receipt.network, allowedNetworks: allowed, txHash: receipt.txHash },
      });
    }
    clearApproval(this.profile.name, cartId);
    const order = await client.waitForOrder(body.orderId);
    return { orderId: body.orderId, cartId, site: client.url, receipt, order };
  }

  spendingEntries(since?: Date) {
    return this.spending.entries(since);
  }
}
