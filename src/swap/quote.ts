import { jupiterFetch, type JupiterQuote, type PoolState } from './jupiter.js';

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}

/** Caller MUST abort on 'unknown' — Jupiter found a route but we couldn't classify the venue. */
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
