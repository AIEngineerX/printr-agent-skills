import { VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { type JupiterQuote, type PriorityFee } from './jupiter.js';
export interface BuildSwapParams {
    quote: JupiterQuote;
    userPublicKey: PublicKey;
    wrapAndUnwrapSol?: boolean;
    priorityFee?: PriorityFee;
}
export declare function buildSwapTransaction(params: BuildSwapParams): Promise<{
    tx: VersionedTransaction;
    lastValidBlockHeight: number;
}>;
//# sourceMappingURL=build.d.ts.map