// payload-service (M2): hot cache of Pyth Lazer + signed CEX prices per pool asset.
import type { Address, PayloadBundle } from "../types.js";

export interface PayloadService {
  /** Fresh payloads + prices for the given assets; throws if any feed is stale beyond payloadMaxAgeMs. */
  getPayloads(assets: Address[]): Promise<PayloadBundle>;
}

export function createPayloadService(): PayloadService {
  return {
    async getPayloads(_assets: Address[]): Promise<PayloadBundle> {
      throw new Error("payload-service not implemented (M2)");
    },
  };
}
