import { type JupiterQuote, type PoolState } from './jupiter.js';
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
export declare function getPoolState(inputMint: string, outputMint: string, probeAmount: bigint): Promise<{
    state: PoolState;
    quote: JupiterQuote;
}>;
/** Strict pool-state lookup for production code paths (buyback crons).
 *  Throws on 'unknown' — if the AMM label doesn't match our known patterns,
 *  Meteora may have renamed them and our classification is stale. Abort
 *  rather than proceed with an unclassified venue. */
export declare function getPoolStateOrThrow(inputMint: string, outputMint: string, probeAmount: bigint): Promise<{
    state: 'bonding-curve' | 'graduated';
    quote: JupiterQuote;
}>;
export declare function quoteSwap(params: QuoteParams): Promise<JupiterQuote>;
//# sourceMappingURL=quote.d.ts.map