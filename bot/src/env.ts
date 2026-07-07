// Runtime secrets/endpoints for the price-payload pipeline. Kept OUT of the committed JSON config because they
// include an access token — read from the environment (see bot/README.md and the ryze-production-endpoints note).

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
