// On-chain token metadata (decimals) with a per-process cache.
import { Contract, type Provider } from "ethers";
import type { Address } from "../types.js";

const ERC20_ABI = ["function decimals() view returns (uint8)"];

export interface TokenMeta {
  decimalsOf(token: Address): Promise<number>;
}

export function createTokenMeta(provider: Provider): TokenMeta {
  const cache = new Map<string, number>();
  return {
    async decimalsOf(token: Address): Promise<number> {
      const key = token.toLowerCase();
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const erc20 = new Contract(token, ERC20_ABI, provider);
      const d = Number(await erc20.decimals());
      cache.set(key, d);
      return d;
    },
  };
}
