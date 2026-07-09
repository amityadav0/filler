// Runtime secrets/endpoints for the price-payload pipeline. Kept OUT of the committed JSON config because they
// include an access token — read from the environment (see bot/README.md and the ryze-production-endpoints note).
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";

/**
 * Load the operator signing wallet for live mode (unconnected — the caller attaches the provider):
 *   - `OPERATOR_KEYSTORE` (path to an encrypted V3 keystore, e.g. `~/.foundry/keystores/operator` from
 *     `cast wallet import`) + `OPERATOR_KEYSTORE_PASSWORD` — preferred, no raw key in the environment; or
 *   - `OPERATOR_PRIVATE_KEY` (raw hex) — discouraged outside throwaway tests.
 * Returns undefined when neither is configured (shadow/dry-run need no signer).
 */
export async function loadOperatorWallet(env: NodeJS.ProcessEnv = process.env): Promise<Wallet | undefined> {
  if (env.OPERATOR_KEYSTORE) {
    const pw = env.OPERATOR_KEYSTORE_PASSWORD;
    if (!pw) throw new Error("OPERATOR_KEYSTORE set but OPERATOR_KEYSTORE_PASSWORD missing");
    const json = readFileSync(env.OPERATOR_KEYSTORE, "utf8");
    const w = await Wallet.fromEncryptedJson(json, pw);
    return w as Wallet;
  }
  if (env.OPERATOR_PRIVATE_KEY) return new Wallet(env.OPERATOR_PRIVATE_KEY);
  return undefined;
}

export interface PayloadEnv {
  /** Pyth Lazer (Pro) access token (Bearer). */
  pythAccessToken: string;
  /**
   * Ryze signed-CEX-price service websocket URL(s), comma-separated. The mainnet feed is split across hosts
   * (one streams USDC, another ETH/BTC), so list all of them, e.g.
   * `wss://us1.mainnet.pricing.ryze.pro/ws,wss://us-signed-price-4tyzr.ondigitalocean.app/ws`.
   */
  ryzePricingWsUrls: string[];
  /** Optional Pyth Lazer websocket endpoint override (defaults to the built-in dourolabs endpoints). */
  pythStreamUrls?: string[];
}

/** True if the required payload-pipeline env vars are present (⇒ the real PayloadSource can be constructed). */
export function hasPayloadEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PYTH_PRO_ACCESS_TOKEN && env.RYZE_PRICING_URL);
}

/** Read + validate the payload-pipeline env; throws with the missing keys if incomplete. */
export function loadPayloadEnv(env: NodeJS.ProcessEnv = process.env): PayloadEnv {
  const missing: string[] = [];
  const req = (k: string): string => {
    const v = env[k];
    if (!v) missing.push(k);
    return v ?? "";
  };
  const token = req("PYTH_PRO_ACCESS_TOKEN");
  const pricing = req("RYZE_PRICING_URL");
  if (missing.length) throw new Error(`missing payload env: ${missing.join(", ")}`);
  const pricingUrls = pricing.split(",").map((s) => s.trim()).filter(Boolean);
  const streams = env.PYTH_PRO_STREAM_URLS?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    pythAccessToken: token,
    ryzePricingWsUrls: pricingUrls,
    ...(streams && streams.length ? { pythStreamUrls: streams } : {}),
  };
}
