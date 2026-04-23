// Jupiter base URL + shared fetch helper. Used by every Jupiter-calling
// helper in this module. JUPITER_TIMEOUT_MS caps individual calls so a
// hung Jupiter node cannot stall a cron.

export const JUPITER_BASE = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag';
export const JUPITER_TIMEOUT_MS = 10_000;

export async function jupiterFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${JUPITER_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Jupiter ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

// ---- Jupiter response types ----

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
    };
    percent: number;
  }>;
}

export type PoolState = 'bonding-curve' | 'graduated' | 'unknown';

export type PriorityFee =
  | 'auto'
  | { maxLamports: number; level: 'low' | 'medium' | 'high' | 'veryHigh' };
