import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  createBurnInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import {
  quoteSwap,
  buildSwapTransaction,
  executeServerSwap,
  verifySwapOutput,
  SwapBelowMinimumError,
} from '../swap/index.js';
import { claimAllAboveThreshold, type PrintrClientOptions } from '../staking/index.js';
import { WSOL_MINT } from '../payments/constants.js';
import type { QueryablePool } from '../payments/verify.js';

export const FEE_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL held back for tx fees

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

export async function findRecoveryCycle(
  cfg: CycleConfig,
): Promise<{ id: number; amountToBurn: bigint } | null> {
  const programId = cfg.tokenProgramId ?? TOKEN_PROGRAM_ID;
  const ata = await getAssociatedTokenAddress(
    cfg.agentTokenMint,
    cfg.hotKeypair.publicKey,
    false,
    programId,
  );

  let ataBalance: bigint;
  try {
    const acct = await getAccount(cfg.connection, ata, 'confirmed', programId);
    ataBalance = acct.amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return null;
    throw e;
  }

  if (ataBalance === 0n) return null;

  const { rows } = await cfg.pool.query(
    `SELECT id, agent_token_bought
       FROM burn_event
      WHERE status = 'swap_done'
      ORDER BY cycle_started_at DESC
      LIMIT 1`,
  );

  if (rows.length === 0) {
    throw new Error(
      `hot wallet holds ${ataBalance} agent tokens but no open burn_event row — manual intervention required`,
    );
  }

  // Burn the actual ATA balance, not the recorded quote.
  return { id: Number(rows[0].id), amountToBurn: ataBalance };
}

export type StartCycleResult =
  | { action: 'noop'; reason: 'below_threshold'; hotBalance: bigint }
  | {
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

export async function startCycle(cfg: CycleConfig): Promise<StartCycleResult> {
  const hotBalanceLamports = BigInt(
    await cfg.connection.getBalance(cfg.hotKeypair.publicKey, 'confirmed'),
  );
  const available = hotBalanceLamports - FEE_RESERVE_LAMPORTS;
  const amountIn = available < cfg.maxPerCycleLamports ? available : cfg.maxPerCycleLamports;

  if (hotBalanceLamports < cfg.thresholdLamports || amountIn <= 0n) {
    return { action: 'noop', reason: 'below_threshold', hotBalance: hotBalanceLamports };
  }

  // Snapshot the agent-token ATA balance BEFORE the swap so the slippage
  // check below compares delta (post - pre), not absolute. When auto-claim
  // is enabled the ATA may be pre-funded with telecoin rewards; without
  // this snapshot, a zero-fill swap would silently pass because pre+0
  // already exceeds minOut.
  const preSwapBalance = await readAtaBalance(cfg);

  const quote = await quoteSwap({
    inputMint: WSOL_MINT,
    outputMint: cfg.agentTokenMint.toBase58(),
    amount: amountIn,
    slippageBps: cfg.slippageBps,
  });

  const { tx, lastValidBlockHeight } = await buildSwapTransaction({
    quote,
    userPublicKey: cfg.hotKeypair.publicKey,
  });

  const swapSig = await executeServerSwap(cfg.connection, tx, lastValidBlockHeight, cfg.hotKeypair);

  // Record the swap_done row IMMEDIATELY after swap confirmation. Any failure
  // past this point leaves a durable row: RPC errors inside verifySwapOutput
  // keep status='swap_done' so findRecoveryCycle picks up the ATA balance next
  // tick; a real slippage bust is caught below and flips the row to 'failed'
  // so recovery does not auto-burn a partial fill without operator review.
  // agent_token_bought is seeded with the quote's minimum and rewritten with
  // the verified amount on the happy path.
  const inserted = await cfg.pool.query(
    `INSERT INTO burn_event
       (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
     VALUES ($1, $2, 0, $3, 'swap_done')
     RETURNING id`,
    [amountIn.toString(), quote.otherAmountThreshold, swapSig],
  );
  const cycleId = Number(inserted.rows[0].id);

  let totalAtaAmount: bigint;
  try {
    totalAtaAmount = await verifySwapOutput(
      cfg.connection,
      cfg.agentTokenMint,
      cfg.hotKeypair.publicKey,
      BigInt(quote.otherAmountThreshold),
      cfg.tokenProgramId,
      preSwapBalance,
    );
  } catch (e) {
    if (e instanceof SwapBelowMinimumError) {
      await cfg.pool.query(`UPDATE burn_event SET status = 'failed', error = $1 WHERE id = $2`, [
        e.message,
        cycleId,
      ]);
    }
    throw e;
  }

  // Record the delta as agent_token_bought for accounting accuracy. The
  // burn amount passed to burnAgentTokens will be the TOTAL ATA balance
  // (includes any pre-existing telecoin rewards), so the burn naturally
  // wipes the ATA regardless of source.
  const bought = totalAtaAmount - preSwapBalance;
  await cfg.pool.query(`UPDATE burn_event SET agent_token_bought = $1 WHERE id = $2`, [
    bought.toString(),
    cycleId,
  ]);

  return {
    action: 'swapped',
    cycleId,
    swapSig,
    bought,
    solIn: amountIn,
    totalAtaAmount,
  };
}

/** Read the current ATA balance; returns 0n when the ATA doesn't exist yet. */
async function readAtaBalance(cfg: CycleConfig): Promise<bigint> {
  const programId = cfg.tokenProgramId ?? TOKEN_PROGRAM_ID;
  const ata = await getAssociatedTokenAddress(
    cfg.agentTokenMint,
    cfg.hotKeypair.publicKey,
    false,
    programId,
  );
  try {
    const acct = await getAccount(cfg.connection, ata, 'confirmed', programId);
    return acct.amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return 0n;
    throw e;
  }
}

export async function burnAgentTokens(
  cfg: CycleConfig,
  cycleId: number,
  amountToBurn: bigint,
): Promise<string> {
  const programId = cfg.tokenProgramId ?? TOKEN_PROGRAM_ID;
  const ata = await getAssociatedTokenAddress(
    cfg.agentTokenMint,
    cfg.hotKeypair.publicKey,
    false,
    programId,
  );

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    createBurnInstruction(
      ata,
      cfg.agentTokenMint,
      cfg.hotKeypair.publicKey,
      amountToBurn,
      [],
      programId,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await cfg.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = cfg.hotKeypair.publicKey;
  tx.sign(cfg.hotKeypair);

  const sig = await cfg.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });
  const conf = await cfg.connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`burn failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }

  await cfg.pool.query(
    `UPDATE burn_event
        SET agent_token_burned = $1,
            burn_sig = $2,
            status = CASE WHEN agent_token_staked = 0 THEN 'complete' ELSE 'burn_done' END,
            completed_at = CASE WHEN agent_token_staked = 0 THEN now() ELSE completed_at END
      WHERE id = $3`,
    [amountToBurn.toString(), sig, cycleId],
  );

  return sig;
}

/** Summary of what the claim phase did (if enabled + if anything was
 *  claimable above threshold). Null when the phase was skipped. */
export interface ClaimPhaseResult {
  signature: string;
  claimedLamports: bigint;
  claimedTelecoinAtomic: bigint;
  positionsClaimed: number;
}

export type CycleResult =
  | { action: 'noop'; reason: 'below_threshold'; hotBalance: bigint; claim?: ClaimPhaseResult }
  | { action: 'recovered'; cycleId: number; burnSig: string; amountBurned: bigint }
  | {
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
    }
  | {
      action: 'failed';
      stage: 'preflight' | 'claim' | 'swap' | 'burn';
      error: string;
      claim?: ClaimPhaseResult;
    };

/** Execute the claim phase. Returns the summary, or null if nothing was
 *  claimable above threshold (no tx submitted). Errors bubble up — the
 *  orchestrator's try/catch wraps them into a 'failed' CycleResult with
 *  stage='claim'. */
async function runClaimPhase(cfg: CycleConfig): Promise<ClaimPhaseResult | null> {
  if (!cfg.autoClaim) return null;
  const result = await claimAllAboveThreshold(
    {
      owner: cfg.hotKeypair,
      telecoinIds: cfg.autoClaim.telecoinIds,
      minClaimableLamports: cfg.autoClaim.minClaimableLamports,
      connection: cfg.connection,
    },
    cfg.autoClaim.printrOptions,
  );
  if (!result) return null;
  return {
    signature: result.signature,
    claimedLamports: result.totalClaimedLamports,
    claimedTelecoinAtomic: result.totalClaimedTelecoinAtomic,
    positionsClaimed: result.perPosition.length,
  };
}

export async function runBuybackCycle(cfg: CycleConfig): Promise<CycleResult> {
  let stage: 'preflight' | 'claim' | 'swap' | 'burn' = 'preflight';
  let claim: ClaimPhaseResult | null = null;

  try {
    // Phase 0 — recovery takes precedence. If the hot ATA has leftover
    // tokens from a previous cycle's swap-succeeded-burn-failed state,
    // burn those first. Do not run claim here — recovery uses existing
    // ATA balance; we don't want to mix in fresh claim-delivered tokens
    // until the prior swap's output is resolved. The next cycle tick
    // after recovery picks up claim + normal flow.
    const recovery = await findRecoveryCycle(cfg);
    if (recovery) {
      stage = 'burn';
      const burnSig = await burnAgentTokens(cfg, recovery.id, recovery.amountToBurn);
      return {
        action: 'recovered',
        cycleId: recovery.id,
        burnSig,
        amountBurned: recovery.amountToBurn,
      };
    }

    // Phase 0.5 — optional auto-claim. Happens AFTER recovery (so we
    // don't mix claim output into a recovery burn) but BEFORE the
    // threshold check (so the claim's SOL can lift us over the threshold
    // when the hot wallet would otherwise no-op).
    stage = 'claim';
    claim = await runClaimPhase(cfg);

    // Phase 1 — swap. startCycle snapshots the ATA pre-swap so if the
    // claim deposited telecoin rewards into the same ATA, the slippage
    // check still works.
    stage = 'swap';
    const start = await startCycle(cfg);
    if (start.action === 'noop') {
      return {
        action: 'noop',
        reason: 'below_threshold',
        hotBalance: start.hotBalance,
        claim: claim ?? undefined,
      };
    }

    // Phase 2 — burn. Pass totalAtaAmount (not bought) so any claimed
    // telecoin rewards in the ATA are burned alongside the swap output.
    // This is the supply-reduction double-hit: swap burns X, claim adds
    // Y, single burn ix destroys X+Y.
    stage = 'burn';
    const burnSig = await burnAgentTokens(cfg, start.cycleId, start.totalAtaAmount);
    return {
      action: 'completed',
      cycleId: start.cycleId,
      swapSig: start.swapSig,
      burnSig,
      solIn: start.solIn,
      amountBurned: start.totalAtaAmount,
      claim: claim ?? undefined,
    };
  } catch (e) {
    return {
      action: 'failed',
      stage,
      error: e instanceof Error ? e.message : String(e),
      claim: claim ?? undefined,
    };
  }
}
