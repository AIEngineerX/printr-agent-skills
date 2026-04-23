import { jupiterFetch, type JupiterQuote, type PoolState } from './jupiter.js';

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}

/** Permissive pool-state lookup. Returns 'unknown' instead of throwing when
 *  the AMM label doesn't match known patterns — use this for diagnostic code
 *  that wants to inspect the raw quote on unclassified venues. Buyback crons
 *  should use `getPoolStateOrThrow` instead. */
export async function getPoolState(
  inputMint: string,
  outputMint: string,
  probeAmount: bigint,
): Promise<{ state: PoolState; quote: JupiterQuote }> {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(probeAmount),
    slippageBps: '100',
  });
  const res = await jupiterFetch(`/swap/v1/quote?${qs}`);
  const quote = (await res.json()) as JupiterQuote;

  const label = quote.routePlan?.[0]?.swapInfo.label ?? '';
  if (label.includes('DBC') || label.includes('Dynamic Bonding Curve')) {
    return { state: 'bonding-curve', quote };
  }
  if (label.includes('DAMM')) return { state: 'graduated', quote };
  return { state: 'unknown', quote };
}

/** Strict pool-state lookup for production code paths (buyback crons).
 *  Throws on 'unknown' — if the AMM label doesn't match our known patterns,
 *  Meteora may have renamed them and our classification is stale. Abort
 *  rather than proceed with an unclassified venue. */
export async function getPoolStateOrThrow(
  inputMint: string,
  outputMint: string,
  probeAmount: bigint,
): Promise<{ state: 'bonding-curve' | 'graduated'; quote: JupiterQuote }> {
  const { state, quote } = await getPoolState(inputMint, outputMint, probeAmount);
  if (state === 'unknown') {
    const label = quote.routePlan?.[0]?.swapInfo.label ?? '(missing)';
    throw new Error(
      `getPoolState: unclassified AMM label "${label}" for ${inputMint} -> ${outputMint}. ` +
        `Meteora may have renamed its labels — update the classifier or pin @solana/* deps.`,
    );
  }
  return { state, quote };
}

export async function quoteSwap(params: QuoteParams): Promise<JupiterQuote> {
  if (params.amount <= 0n) throw new Error('amount must be > 0');
  if (params.slippageBps <= 0) throw new Error('slippageBps must be > 0');
  if (params.slippageBps > 5000) throw new Error('slippageBps must be <= 5000 (5%)');

  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: String(params.slippageBps),
  });
  const res = await jupiterFetch(`/swap/v1/quote?${qs}`);
  const quote = (await res.json()) as JupiterQuote;

  if (!quote.routePlan?.length) {
    throw new Error(`No route available for ${params.inputMint} -> ${params.outputMint}`);
  }
  if (quote.outputMint !== params.outputMint) {
    throw new Error(
      `Jupiter returned wrong output mint: expected ${params.outputMint}, got ${quote.outputMint}`,
    );
  }
  return quote;
}
