/**
 * Generic connector (SPEC 08): custom stacks implement two or three functions and AgentPOS
 * calls them. createOrder runs ONLY after settlement.
 */
import type {
  AvailabilityResult,
  ConnectorOrderResult,
  ConnectorProduct,
  OrderConnector,
  PaidOrderInput,
} from "@agentpos/core";

export interface GenericConnectorHooks {
  listProducts?: () => Promise<ConnectorProduct[]>;
  getAvailability?: (
    items: Array<{ itemId: string; externalId?: string; quantity: number }>,
  ) => Promise<AvailabilityResult[]>;
  createOrder: (input: PaidOrderInput) => Promise<ConnectorOrderResult>;
  getOrderStatus?: (externalOrderId: string) => Promise<{ status: string; raw?: unknown }>;
}

export class GenericConnector implements OrderConnector {
  readonly platform = "generic" as const;
  constructor(private readonly hooks: GenericConnectorHooks) {}

  listProducts(): Promise<ConnectorProduct[]> {
    return this.hooks.listProducts ? this.hooks.listProducts() : Promise.resolve([]);
  }

  getAvailability(
    items: Array<{ itemId: string; externalId?: string; quantity: number }>,
  ): Promise<AvailabilityResult[]> {
    if (this.hooks.getAvailability) return this.hooks.getAvailability(items);
    // Untracked stock: everything the catalog lists is available.
    return Promise.resolve(items.map((i) => ({ itemId: i.itemId, available: true })));
  }

  createOrder(input: PaidOrderInput): Promise<ConnectorOrderResult> {
    return this.hooks.createOrder(input);
  }

  getOrderStatus(externalOrderId: string): Promise<{ status: string; raw?: unknown }> {
    return this.hooks.getOrderStatus
      ? this.hooks.getOrderStatus(externalOrderId)
      : Promise.resolve({ status: "unknown" });
  }
}
