// order-ingestor (M2): poll orders API (webhook later); filter by chain, path availability, size bands.
export interface OpenOrder {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  auctionTargetBlock?: number;
}

export interface Ingestor {
  /** Yields newly-seen open Priority orders. */
  poll(): Promise<OpenOrder[]>;
}

export function createIngestor(): Ingestor {
  return {
    async poll(): Promise<OpenOrder[]> {
      throw new Error("order-ingestor not implemented (M2)");
    },
  };
}
