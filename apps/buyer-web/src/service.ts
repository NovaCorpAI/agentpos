/**
 * Channel-agnostic buyer service: the web pages call it, and a future messaging channel
 * (WhatsApp) will call EXACTLY these functions. Nothing here knows about HTTP or HTML.
 *
 * Flow: searchOffers -> propose (quote frozen, human notified) -> approve | reject.
 * approve() marks the proposal approved and returns payment instructions; it does NOT pay.
 * This process holds no key and cannot pay. The buyer pays from their own machine
 * (agentpos-buyer CLI, or a later signing bridge) where the local signer lives.
 */
import { randomUUID } from "node:crypto";
import { AgentPOSError, addUsdc, formatUsdc, usdcFromMinor } from "@agentpos/core";
import type { UsdcMinor } from "@agentpos/core";
import { BuyerService, evaluateMandate, periodStart } from "@agentpos/mcp-buyer";
import type { Offer, Profile } from "@agentpos/mcp-buyer";
import type { BuyerWebStorage } from "./storage.js";
import { buyerWebProfileSchema } from "./types.js";
import type {
  ApprovalResult,
  BuyerWebProfile,
  PaymentInstructions,
  Proposal,
  ServiceStatus,
} from "./types.js";

/**
 * Satisfies the mcp-buyer Profile shape when no wallet is linked yet. Format-only: it is
 * never funded, never published and never signs; buyer-web never calls BuyerService.buy().
 */
const PLACEHOLDER_ADDRESS = `G${"A".repeat(55)}`;

/**
 * Custody rule, structurally: buyer-web builds a BuyerService with a key file that does not
 * exist and no passphrase, so even a future bug that reached the signing path would fail with
 * "Wallet is locked" before touching any file.
 */
const NO_KEY_FILE = "buyer-web-never-has-a-key";

export interface SaveProfileInput {
  /** Decimal USDC, e.g. "25" or "9.5". */
  maxPerTx: string;
  maxTotal: string;
  period?: string;
  /** Store URLs the agent may buy from; empty means any store. */
  stores?: string[];
  allowPhysicalGoods?: boolean;
  email?: string;
  /** Public wallet address (G...). A secret (S...) is refused loudly. */
  walletAddress?: string;
}

export interface BuyerWebServiceDeps {
  storage: BuyerWebStorage;
  network?: "testnet" | "mainnet";
  /** Tests inject the in-process store; production uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export class BuyerWebService {
  private readonly storage: BuyerWebStorage;
  private readonly network: "testnet" | "mainnet";
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly now: () => Date;

  constructor(deps: BuyerWebServiceDeps) {
    this.storage = deps.storage;
    this.network = deps.network ?? "testnet";
    this.fetchImpl = deps.fetchImpl;
    this.now = deps.now ?? (() => new Date());
  }

  // --- profile / mandate -----------------------------------------------------

  getProfile(): BuyerWebProfile | undefined {
    return this.storage.getProfile();
  }

  saveProfile(input: SaveProfileInput): BuyerWebProfile {
    const wallet = input.walletAddress?.trim();
    if (wallet && wallet.startsWith("S")) {
      throw new AgentPOSError("SECRET_IN_CONFIG", "That looks like a SECRET key, not an address", {
        hint: "This service stores public addresses only (they start with G). Keep the secret on your own machine; never paste it into any website, including this one.",
      });
    }
    const stores = (input.stores ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    const hosts: string[] = [];
    for (const url of stores) {
      try {
        hosts.push(new URL(url).host);
      } catch {
        throw new AgentPOSError("CONFIG_INVALID", `'${url}' is not a valid store URL`, {
          hint: "Use full URLs, one per line, e.g. https://shop.example",
        });
      }
    }
    const parsed = buyerWebProfileSchema.safeParse({
      id: "default",
      network: this.network,
      stores,
      mandate: {
        maxPerTx: input.maxPerTx.trim(),
        maxTotal: input.maxTotal.trim(),
        period: input.period ?? "day",
        // The store list IS the seller allowlist; an empty list means any store.
        allowedSellers: hosts.length > 0 ? hosts : "any",
        allowPhysicalGoods: input.allowPhysicalGoods ?? false,
        shippingAddressLocked: true,
      },
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
      ...(wallet ? { walletAddress: wallet } : {}),
      updatedAt: this.now().toISOString(),
    });
    if (!parsed.success) {
      throw new AgentPOSError("CONFIG_INVALID", "The mandate is invalid", {
        hint: "Amounts are decimal USDC with up to 7 decimals (e.g. 25 or 9.5); the wallet address starts with G.",
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
    }
    this.storage.saveProfile(parsed.data);
    this.storage.appendActivity(
      "profile.saved",
      {
        maxPerTx: parsed.data.mandate.maxPerTx,
        maxTotal: parsed.data.mandate.maxTotal,
        period: parsed.data.mandate.period,
        stores: parsed.data.stores,
        walletLinked: parsed.data.walletAddress !== undefined,
      },
      this.now().toISOString(),
    );
    return parsed.data;
  }

  // --- offers ----------------------------------------------------------------

  async searchOffers(query: string): Promise<Offer[]> {
    const profile = this.requireProfile();
    const offers = await this.buyerFor(profile).searchOffers(query);
    this.storage.appendActivity(
      "search",
      { query, results: offers.length },
      this.now().toISOString(),
    );
    return offers;
  }

  // --- proposals -------------------------------------------------------------

  /**
   * Quote the purchase against the store (a real cart, a real price) and park it as a
   * pending proposal for the human. The mandate is evaluated NOW, before the human is
   * bothered: a proposal that could never be paid is refused, not queued.
   */
  async propose(itemId: string, storeUrl: string, quantity = 1): Promise<Proposal> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new AgentPOSError("CONFIG_INVALID", `Invalid quantity ${quantity}`, {
        hint: "Use an integer between 1 and 999.",
      });
    }
    const profile = this.requireProfile();
    const buyer = this.buyerFor(profile);
    const client = buyer.site(storeUrl);
    const info = await client.info();
    const cart = await buyer.createCart(storeUrl, [{ itemId, quantity }]);
    const amount = usdcFromMinor(cart.quote.totalMinor);
    const hasPhysical = cart.quote.lines.some((l) => l.physical);
    const verdict = evaluateMandate(profile.mandate, {
      amount,
      siteHost: client.host,
      siteVerified: info.verified,
      hasPhysicalItems: hasPhysical,
      spentInPeriod: this.approvedInPeriod(profile),
      // Approving the proposal IS the human confirmation this platform exists for, so a
      // CONFIRMATION_REQUIRED verdict is not an obstacle here: everything gets confirmed.
      humanApproved: true,
    });
    if (!verdict.ok) {
      throw new AgentPOSError(verdict.code, verdict.message, {
        hint: verdict.hint,
        details: verdict.details,
      });
    }
    const proposal: Proposal = {
      id: randomUUID(),
      status: "pending",
      storeUrl: client.url,
      storeName: info.name,
      itemId,
      title: cart.quote.lines.map((l) => `${l.quantity} x ${l.title}`).join(", "),
      quantity,
      amount: cart.quote.total,
      amountMinor: cart.quote.totalMinor,
      asset: cart.quote.asset,
      network: cart.quote.network,
      cartId: cart.cartId,
      checkoutUrl: cart.checkout,
      physical: hasPhysical,
      cartExpiresAt: cart.expiresAt,
      createdAt: this.now().toISOString(),
    };
    this.storage.saveProposal(proposal);
    this.storage.appendActivity(
      "proposal.created",
      {
        proposalId: proposal.id,
        store: proposal.storeUrl,
        title: proposal.title,
        amount: proposal.amount,
        asset: proposal.asset,
      },
      proposal.createdAt,
    );
    return proposal;
  }

  /**
   * Mark the proposal approved and return the exact payment instructions. The money has NOT
   * moved when this returns: the proposal is "approved, awaiting signature" until the buyer
   * pays from the machine that holds the key. Idempotent on an already-approved proposal.
   */
  approve(proposalId: string): ApprovalResult {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "rejected") {
      throw new AgentPOSError("APPROVAL_REJECTED", "This proposal was already rejected", {
        hint: "Ask the agent to propose the purchase again if you changed your mind.",
      });
    }
    if (proposal.status === "expired" || this.cartExpired(proposal)) {
      if (proposal.status !== "expired") this.markExpired(proposal);
      throw new AgentPOSError("CART_EXPIRED", "The store's quote for this proposal expired", {
        hint: "Prices are only held for a short time. Ask the agent to propose the purchase again.",
      });
    }
    if (proposal.status === "pending") {
      const decided: Proposal = {
        ...proposal,
        status: "approved",
        decidedAt: this.now().toISOString(),
      };
      this.storage.saveProposal(decided);
      this.storage.appendActivity(
        "proposal.approved",
        { proposalId: decided.id, title: decided.title, amount: decided.amount },
        decided.decidedAt as string,
      );
      return { proposal: decided, instructions: this.instructionsFor(decided) };
    }
    return { proposal, instructions: this.instructionsFor(proposal) };
  }

  /** Reject a pending (or even an approved-but-unpaid) proposal. Idempotent. */
  reject(proposalId: string): Proposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "rejected") return proposal;
    const decided: Proposal = {
      ...proposal,
      status: "rejected",
      decidedAt: this.now().toISOString(),
    };
    this.storage.saveProposal(decided);
    this.storage.appendActivity(
      "proposal.rejected",
      { proposalId: decided.id, title: decided.title, amount: decided.amount },
      decided.decidedAt as string,
    );
    return decided;
  }

  getProposal(proposalId: string): Proposal | undefined {
    return this.storage.getProposal(proposalId);
  }

  pendingProposals(): Proposal[] {
    return this.storage.listProposals("pending");
  }

  approvedProposals(): Proposal[] {
    return this.storage.listProposals("approved");
  }

  proposalHistory(): Proposal[] {
    return this.storage.listProposals();
  }

  instructionsFor(proposal: Proposal): PaymentInstructions {
    return {
      proposalId: proposal.id,
      storeUrl: proposal.storeUrl,
      cartId: proposal.cartId,
      checkoutUrl: proposal.checkoutUrl,
      amount: proposal.amount,
      asset: proposal.asset,
      network: proposal.network,
      signer: "local",
      cli: `agentpos-buyer demo ${proposal.storeUrl} --item ${proposal.itemId} -q ${proposal.quantity}`,
      note: "Approved, awaiting signature. This platform stores only your public wallet address and cannot pay for you: run the command on the machine that holds your wallet key.",
    };
  }

  // --- status ----------------------------------------------------------------

  status(): ServiceStatus {
    const profile = this.storage.getProfile();
    const pending = this.storage.listProposals("pending").length;
    const approved = this.storage.listProposals("approved").length;
    return {
      profileConfigured: profile !== undefined,
      walletLinked: profile?.walletAddress !== undefined,
      network: this.network,
      stores: profile?.stores ?? [],
      ...(profile
        ? {
            mandate: {
              maxPerTx: profile.mandate.maxPerTx,
              maxTotal: profile.mandate.maxTotal,
              period: profile.mandate.period,
              allowPhysicalGoods: profile.mandate.allowPhysicalGoods,
            },
          }
        : {}),
      pendingProposals: pending,
      approvedAwaitingSignature: approved,
      approvedInPeriod: profile ? formatUsdc(this.approvedInPeriod(profile)) : "0",
    };
  }

  activity(limit = 200) {
    return this.storage.listActivity(limit);
  }

  // --- internals -------------------------------------------------------------

  private requireProfile(): BuyerWebProfile {
    const profile = this.storage.getProfile();
    if (!profile) {
      throw new AgentPOSError("CONFIG_INVALID", "No mandate configured yet", {
        hint: "Open the mandate editor (/) and save spending limits before the agent can act.",
      });
    }
    return profile;
  }

  private requireProposal(proposalId: string): Proposal {
    const proposal = this.storage.getProposal(proposalId);
    if (!proposal) {
      throw new AgentPOSError("APPROVAL_NOT_FOUND", `No proposal '${proposalId}'`, {
        hint: "It may have been created by another profile or never existed; check /proposals.",
      });
    }
    return proposal;
  }

  private cartExpired(proposal: Proposal): boolean {
    return new Date(proposal.cartExpiresAt).getTime() <= this.now().getTime();
  }

  private markExpired(proposal: Proposal): void {
    const expired: Proposal = {
      ...proposal,
      status: "expired",
      decidedAt: this.now().toISOString(),
    };
    this.storage.saveProposal(expired);
    this.storage.appendActivity(
      "proposal.expired",
      { proposalId: expired.id, title: expired.title },
      expired.decidedAt as string,
    );
  }

  /** What the human already approved in the current mandate period; the honest ceiling this
   * platform can enforce, since settlement happens off-box on the buyer's machine. */
  private approvedInPeriod(profile: BuyerWebProfile): UsdcMinor {
    const since = periodStart(profile.mandate.period, this.now());
    return this.storage
      .listProposals("approved")
      .filter((p) => p.decidedAt !== undefined && new Date(p.decidedAt) >= since)
      .reduce((acc, p) => addUsdc(acc, usdcFromMinor(p.amountMinor)), usdcFromMinor(0n));
  }

  /** BuyerService over the web profile. Search and quoting only; it can never sign here. */
  private buyerFor(p: BuyerWebProfile): BuyerService {
    const profile: Profile = {
      name: "buyer-web",
      network: this.network,
      keyFile: NO_KEY_FILE,
      address: p.walletAddress ?? PLACEHOLDER_ADDRESS,
      mandate: p.mandate,
      sites: p.stores,
      createdAt: p.updatedAt,
      ...(p.email ? { buyer: { email: p.email } } : {}),
    };
    return new BuyerService({
      profile,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }
}
