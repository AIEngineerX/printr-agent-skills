import type { Connection, Keypair } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
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
    signature: string;
    /** Per-position claimed amounts. Order matches the input `positionIds`. */
    perPosition: Array<{
        position: string;
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
 * signature plus the amounts that were claimable immediately before the
 * claim (read from Printr's API before submission — these are "what the
 * claim was built for", not necessarily what lands, but the two should
 * match modulo fee / rounding).
 *
 * The Solana instruction bytes are server-encoded by Printr (their SVM
 * IDL is not public) — this wrapper takes those bytes, builds a
 * VersionedTransaction, signs with the owner keypair, submits, confirms.
 *
 * @param args.owner       keypair whose pubkey owns the positions
 * @param args.positionIds array of position addresses (from StakePositionInfo.position)
 * @param args.connection  Solana RPC
 * @param options          optional Printr API overrides (base URL, partner key)
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