// submitter (M3/M4): build executor.execute tx with maxPriorityFeePerGas, fresh payloads, deadline.
import type { OpenOrder } from "../ingestor/index.js";
import type { Bid } from "../strategy/index.js";

export interface FillOutcome {
  orderHash: string;
  won: boolean;
  txHash?: `0x${string}`;
  gasWei?: bigint;
}

export interface Submitter {
  submit(order: OpenOrder, bid: Bid): Promise<FillOutcome>;
}

export function createSubmitter(): Submitter {
  return {
    async submit(): Promise<FillOutcome> {
      throw new Error("submitter not implemented (M3/M4)");
    },
  };
}
