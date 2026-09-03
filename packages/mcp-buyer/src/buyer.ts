/**
 * BuyerService: search -> cart -> mandate check -> pay (x402) -> receipt + spending log.
 * The agent never sees the key and never edits the mandate.
 */
import {
  AgentPOSError,
  createBuyerFetch,
  createLocalKeypairSigner,
  formatUsdc,
  loadKeypair,
  receiptFromResponse,
  resolveConfig,
} from "@agentpos/core";
import type {
  Address,
  BuyerContact,
  BuyerLimits,
  CartLine,
  CoreConfig,
  SettlementReceipt,
  SignerProvider,
} from "@agentpos/core";
import { evaluateMandate, periodStart, toMandateError } from "./mandate.js";
import { clearApproval, getApproval, requestApproval } from "./profile.js";
import type { Profile } from "./profile.js";
import { SiteClient, cartTotalMinor } from "./siteClient.js";
import type { SiteCart, SiteItem, SiteOrder } from "./siteClient.js";
import { SpendingLog } from "./spending.js";

export type PayFetchFactory = (
  core: CoreConfig,
  signer: SignerProvider,
  limits: BuyerLimits,
) => typeof globalThis.fetch;

export interface BuyerDeps {
  profile: Profile;
  passphrase?: string;
  /** Tests inject a fake; production signs with the profile keypair. */
  signer?: SignerProvider;
  payFetchFactory?: PayFetchFactory;
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
    if (info.network !== this.core.caip2) {
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
    const approval = getApproval(this.profile.name, cartId);
    const verdict = evaluateMandate(this.profile.mandate, {
      amount,
      siteHost: client.host,
      siteVerified: info.verified,
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

    const payFetch = this.payFetchFactory(this.core, this.signer(), { maxPerPayment: amount });
    this.log(
      `paying cart ${cartId} at ${client.url}: ${formatUsdc(amount)} ${this.core.checkoutAsset}`,
    );
    // Pay against the host we reached (the cart's absolute `checkout` uses the site's public URL,
    // which may differ from how this buyer addresses it, e.g. behind proxies or in e2e).
    const checkoutUrl = `${client.url}${client.basePath}/checkout?cart=${encodeURIComponent(cartId)}`;
    const response = await payFetch(checkoutUrl, { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as {
      orderId?: string;
      error?: { code?: string; message?: string; hint?: string };
    };
    if (response.status !== 200 || !body.orderId) {
      throw new AgentPOSError(
        "PAYMENT_REJECTED",
        body.error?.message ?? `Checkout answered ${response.status}`,
        {
          hint: body.error?.hint ?? "The payment was not settled; nothing was charged.",
          details: { status: response.status, code: body.error?.code },
        },
      );
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
      asset: this.core.checkoutAsset,
      amountMinor: amount.toString(),
      summary: cart.quote.lines.map((l) => `${l.quantity} x ${l.title}`).join(", "),
    });
    clearApproval(this.profile.name, cartId);
    const order = await client.waitForOrder(body.orderId);
    return { orderId: body.orderId, cartId, site: client.url, receipt, order };
  }

  spendingEntries(since?: Date) {
    return this.spending.entries(since);
  }
}
