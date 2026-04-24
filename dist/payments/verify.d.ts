import { Connection, PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction } from '@solana/web3.js';
export declare const GRACE_PAST_END_SECONDS = 300;
export declare const CLOCK_SKEW_SECONDS = 60;
export declare const SIGNATURE_PAGE_SIZE = 200;
export interface QueryablePool {
    query(text: string, params?: readonly unknown[]): Promise<{
        rows: any[];
        rowCount?: number | null;
    }>;
}
export interface InvoiceRow {
    memo: string | bigint;
    user_wallet: string;
    currency_mint: string;
    amount_smallest_unit: string | bigint;
    start_time: number | string;
    end_time: number | string;
    status: 'pending' | 'paid' | 'expired' | 'cancelled';
    tx_sig: string | null;
}
export type VerifyResult = {
    paid: true;
    tx_sig: string;
    blockTime: number;
} | {
    paid: false;
    reason: 'not_found' | 'expired' | 'already_marked_paid';
};
export interface VerifyContext {
    pool: QueryablePool;
    connection: Connection;
    treasuryPubkey: PublicKey;
    treasuryUsdcAta?: () => Promise<string>;
}
/** Lazy-memoized treasury USDC ATA. Invalidates on rejection so a transient
 *  failure doesn't lock in the error. */
export declare function makeTreasuryUsdcAtaCache(treasuryPubkey: PublicKey): () => Promise<string>;
/**
 * Returns paid: true only when a single on-chain tx satisfies ALL of:
 *  - Memo instruction with data equal to String(invoice.memo)
 *  - SOL transfer user → treasury for exactly invoice.amount, OR
 *    USDC transfer from user wallet → treasury's USDC ATA for exactly invoice.amount
 *  - blockTime within [start_time - skew, end_time + grace]
 */
export declare function verifyInvoiceOnChain(ctx: VerifyContext, opts: {
    memo: bigint;
}): Promise<VerifyResult>;
type Ix = ParsedInstruction | PartiallyDecodedInstruction;
export declare function instructionIsMemo(ix: Ix, expectedMemo: string): boolean;
export declare function instructionIsSolTransfer(ix: Ix, from: PublicKey, to: PublicKey, lamports: bigint): boolean;
export declare function instructionIsUsdcTransfer(ix: Ix, userWallet: PublicKey, treasuryAta: string, amount: bigint): boolean;
/** 10×2s retry loop absorbs RPC indexer propagation delay. Returns true only
 *  when the DB UPDATE flipped a 'pending' row (rowCount=1). */
export declare function verifyInvoiceWithRetries(ctx: VerifyContext, memo: bigint, retryCount?: number, retryDelayMs?: number): Promise<boolean>;
export {};
//# sourceMappingURL=verify.d.ts.map