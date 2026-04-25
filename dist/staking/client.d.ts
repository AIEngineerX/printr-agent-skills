import type { Connection, Keypair } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
/** Thrown when Printr's HTTP API returns a non-2xx response. Adopters can
 *  catch this specifically to retry, back off, or route to a status-page
 *  alert rather than treating every failure as a bug. */
export declare class PrintrApiError extends Error {
    readonly status: number;
    readonly path: string;
    readonly body: string;
    constructor(path: string, status: number, body: string);
}
export interface PrintrClientOptions {
    apiBase?: string;
    apiKey?: string;
    timeoutMs?: number;
}
export interface AssetAmount {
    asset: string;
    decimals: number;
    atomic: string;
    display?: string;
}
export interface StakePositionInfo {
    telecoin_id: string;
    owner: string;
    position: string;
    /**
     * The signature of the transaction that opened this position. Required
     * by Printr's `/staking/claim-rewards` endpoint as a stable handle for
     * the position — without it the request fails with "creation_tx is required".
     */
    creation_tx: string;
    lock_period: 'STAKING_LOCK_PERIOD_SEVEN_DAYS' | 'STAKING_LOCK_PERIOD_FOURTEEN_DAYS' | 'STAKING_LOCK_PERIOD_THIRTY_DAYS' | 'STAKING_LOCK_PERIOD_SIXTY_DAYS' | 'STAKING_LOCK_PERIOD_NINETY_DAYS' | 'STAKING_LOCK_PERIOD_ONE_HUNDRED_EIGHTY_DAYS';
    staked: AssetAmount;
    created_at: string;
    unlocks_at: string;
    was_closed?: boolean;
}
export interface StakePositionWithRewards {
    info: StakePositionInfo;
    claimable_quote_rewards?: AssetAmount;
    claimable_telecoin_rewards?: AssetAmount;
    claimed_quote_rewards?: AssetAmount;
    claimed_telecoin_rewards?: AssetAmount;
}
export interface ListPositionsResponse {
    positions: StakePositionWithRewards[];
    next_cursor?: string;
}
/** Format a Solana pubkey (base58) as a CAIP-10 mainnet-beta account. */
export declare function solanaCaip10(pubkey: string | PublicKey): string;
/**
 * List stake positions with claimable rewards for a given owner, optionally
 * filtered to specific telecoin(s). Results are paginated — caller must
 * handle `next_cursor` if the operator has >100 positions.
 */
export declare function listPositionsWithRewards(args: {
    owner: string | PublicKey;
    telecoinIds?: string[];
    cursor?: string;
    limit?: number;
}, options?: PrintrClientOptions): Promise<ListPositionsResponse>;
/** Amounts reported by a successful claim, per position + aggregated. */
export interface ClaimResult {
    /**
     * Comma-joined claim signatures, in submission order. Printr's
     * `/staking/claim-rewards` accepts only one position per call, so an
     * N-position claim produces N signatures rather than one combined tx.
     * Each signature is a separate on-chain claim transaction.
     */
    signature: string;
    /** Per-position claimed amounts. Order matches the input `positionIds`. */
    perPosition: Array<{
        position: string;
        signature: string;
        claimedQuoteLamports: bigint;
        claimedTelecoinAtomic: bigint;
    }>;
    /** Sum of claimed quote (SOL, lamports) across all positions. */
    totalClaimedLamports: bigint;
    /** Sum of claimed telecoin atomic across all positions. */
    totalClaimedTelecoinAtomic: bigint;
}
/**
 * Claim rewards from stake positions. Owner must have signing authority on
 * each position (Printr's program checks this on-chain). Returns the tx
 * signature plus the pre-claim claimable amounts — "what the claim was
 * built for", should match on-chain delivery modulo fees / rounding.
 *
 * Printr's `/staking/claim-rewards` endpoint accepts one position per
 * call (with its `creation_tx` as a required handle). N positions ⇒ N
 * sequential claim transactions; failure of any aborts the loop, so any
 * already-submitted claims stay on-chain and reward state diverges from
 * what the caller requested. Verified against api-preview 2026-04-25.
 */
export declare function claimRewards(args: {
    owner: Keypair;
    positionIds: string[];
    connection: Connection;
}, options?: PrintrClientOptions): Promise<ClaimResult>;
/**
 * List-then-claim helper: finds all positions for a given owner (optionally
 * filtered to a telecoin) that have non-zero claimable_quote_rewards above
 * a threshold, and claims them in one tx. Returns null if nothing is above
 * the threshold.
 */
export declare function claimAllAboveThreshold(args: {
    owner: Keypair;
    telecoinIds?: string[];
    minClaimableLamports: bigint;
    connection: Connection;
}, options?: PrintrClientOptions): Promise<ClaimResult | null>;
//# sourceMappingURL=client.d.ts.map