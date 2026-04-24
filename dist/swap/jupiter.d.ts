export declare const JUPITER_BASE: string;
export declare const JUPITER_TIMEOUT_MS = 10000;
export declare function jupiterFetch(path: string, init?: RequestInit): Promise<Response>;
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
export type PriorityFee = 'auto' | {
    maxLamports: number;
    level: 'low' | 'medium' | 'high' | 'veryHigh';
};
//# sourceMappingURL=jupiter.d.ts.map