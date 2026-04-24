import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { type PrintrClientOptions } from '../staking/index.js';
import type { QueryablePool } from '../payments/verify.js';
export declare const FEE_RESERVE_LAMPORTS = 10000000n;
/** When set on CycleConfig, runBuybackCycle adds a Phase 0.5 before the swap
 *  that claims POB stake rewards for the hot keypair's positions. The hot
 *  keypair thus doubles as the position owner — blast radius includes all
 *  staked principal after lock expiry. See `printr-tokenized-agent/SKILL.md`
 *  §Auto-claim for the tradeoff vs. the manual-sweep default. */
export interface AutoClaimConfig {
    /** Restrict claims to these telecoin_ids (0x…). Omit to claim across every
     *  telecoin the owner holds a position on. */
    telecoinIds?: string[];
    /** Skip the claim tx unless aggregate claimable SOL across matching
     *  positions meets this threshold — avoids spending fees on dust. */
    minClaimableLamports: bigint;
    /** Optional Printr API overrides. */
    printrOptions?: PrintrClientOptions;
}
export interface CycleConfig {
    pool: QueryablePool;
    connection: Connection;
    hotKeypair: Keypair;
    agentTokenMint: PublicKey;
    thresholdLamports: bigint;
    maxPerCycleLamports: bigint;
    slippageBps: number;
    /** SPL Token program ID that owns the agent token mint. Defaults to
     *  classic SPL (`TokenkegQ...`). Pass `TOKEN_2022_PROGRAM_ID` for
     *  Token-2022 mints — the program ID is a seed in ATA derivation and a
     *  dispatch key in `getAccount` / `createBurnInstruction`, so a
     *  mismatch derives the wrong ATA and addresses the burn ix to the
     *  wrong program. **[Printr]** Many POB tokens graduated post-mid-2025
     *  are Token-2022. */
    tokenProgramId?: PublicKey;
    /** When set, Phase 0.5 claims POB stake rewards before the threshold
     *  check — funds the cycle from accrued yield. Widens blast radius (hot
     *  keypair must own the positions). See `AutoClaimConfig`. */
    autoClaim?: AutoClaimConfig;
}
export declare function findRecoveryCycle(cfg: CycleConfig): Promise<{
    id: number;
    amountToBurn: bigint;
} | null>;
export type StartCycleResult = {
    action: 'noop';
    reason: 'below_threshold';
    hotBalance: bigint;
} | {
    action: 'swapped';
    cycleId: number;
    swapSig: string;
    /** Tokens delivered by the swap itself (post − pre ATA delta). */
    bought: bigint;
    /** Full ATA balance after the swap (bought + any pre-existing, e.g.
     *  claimed telecoin rewards). Pass this to burnAgentTokens to wipe the ATA. */
    totalAtaAmount: bigint;
    solIn: bigint;
};
export declare function startCycle(cfg: CycleConfig): Promise<StartCycleResult>;
export declare function burnAgentTokens(cfg: CycleConfig, cycleId: number, amountToBurn: bigint): Promise<string>;
/** Summary of what the claim phase did (if enabled + if anything was
 *  claimable above threshold). Null when the phase was skipped. */
export interface ClaimPhaseResult {
    signature: string;
    claimedLamports: bigint;
    claimedTelecoinAtomic: bigint;
    positionsClaimed: number;
}
export type CycleResult = {
    action: 'noop';
    reason: 'below_threshold';
    hotBalance: bigint;
    claim?: ClaimPhaseResult;
} | {
    action: 'recovered';
    cycleId: number;
    burnSig: string;
    amountBurned: bigint;
} | {
    action: 'completed';
    cycleId: number;
    swapSig: string;
    burnSig: string;
    solIn: bigint;
    amountBurned: bigint;
    /** Populated when autoClaim was configured AND a claim ran this cycle.
     *  solIn already reflects the claim-boosted SOL balance; amountBurned
     *  includes any claimed telecoin rewards that were in the ATA. */
    claim?: ClaimPhaseResult;
} | {
    action: 'failed';
    stage: 'preflight' | 'claim' | 'swap' | 'burn';
    error: string;
    claim?: ClaimPhaseResult;
};
export declare function runBuybackCycle(cfg: CycleConfig): Promise<CycleResult>;
//# sourceMappingURL=cycle.d.ts.map