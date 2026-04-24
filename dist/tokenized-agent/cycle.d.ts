import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { type PrintrClientOptions } from '../staking/index.js';
import type { QueryablePool } from '../payments/verify.js';
export declare const FEE_RESERVE_LAMPORTS = 10000000n;
/** Auto-claim configuration. When set on CycleConfig, runBuybackCycle
 *  adds a Phase 0.5 before the swap that calls Printr's
 *  /v1/staking/claim-rewards for the hot keypair's positions, topping up
 *  the hot wallet's SOL balance. **The hot keypair thus doubles as the
 *  position owner** — blast radius includes all staked principal after
 *  lock expiry. See `printr-tokenized-agent/SKILL.md` §Auto-claim for
 *  the custody tradeoff vs. the manual-sweep default. */
export interface AutoClaimConfig {
    /** Restrict claims to these Printr telecoin_ids (0x…). When omitted, any
     *  position the owner holds on any telecoin is eligible — usually you
     *  want the single telecoin for your buyback. */
    telecoinIds?: string[];
    /** Only claim if the aggregate claimable SOL across matching positions
     *  is >= this many lamports. Avoids spending tx fees on dust claims. */
    minClaimableLamports: bigint;
    /** Optional Printr API overrides (base URL, partner key, timeout). */
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
     *  classic SPL (`TokenkegQ...`). Pass `TOKEN_2022_PROGRAM_ID` from
     *  `@solana/spl-token` for Token-2022 mints — the ATA PDA derivation
     *  and `getAccount`/`createBurnInstruction` decoding all use the program
     *  ID as a seed or dispatch key. Omitting it on a Token-2022 mint
     *  produces the wrong ATA address (TokenAccountNotFoundError every
     *  cycle) and a burn ix addressed to the wrong program (on-chain
     *  failure). **[Printr]** Many POB tokens graduated post-mid-2025 are
     *  Token-2022. */
    tokenProgramId?: PublicKey;
    /** Optional auto-claim phase. When set, the cycle claims stake rewards
     *  before checking the SOL threshold, effectively funding itself from
     *  the owner's accrued POB yield. Omit for manual-sweep mode (safer —
     *  the hot wallet doesn't own stake positions). See `AutoClaimConfig`. */
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
    /** Total ATA balance after the swap (bought + any pre-existing,
     *  e.g. telecoin rewards claimed earlier this cycle). This is what
     *  should be passed to burnAgentTokens to wipe the ATA. */
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
    /** Populated when autoClaim was configured AND a claim ran this
     *  cycle. Claim happens before the swap, so `solIn` already reflects
     *  any claim-boosted SOL balance. amountBurned includes any claimed
     *  telecoin rewards that were in the ATA alongside the swap output. */
    claim?: ClaimPhaseResult;
} | {
    action: 'failed';
    stage: 'preflight' | 'claim' | 'swap' | 'burn';
    error: string;
    claim?: ClaimPhaseResult;
};
export declare function runBuybackCycle(cfg: CycleConfig): Promise<CycleResult>;
//# sourceMappingURL=cycle.d.ts.map