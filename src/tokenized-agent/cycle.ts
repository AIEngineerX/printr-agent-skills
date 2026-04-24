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

export async function findRecoveryCycle(
  cfg: CycleConfig,
): Promise<{ id: number; amountToBurn: bigint } | null> {
  const ataBalance = await readAtaBalance(cfg);
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
      /** Full ATA balance after the swap (bought + any pre-existing, e.g.
       *  claimed telecoin rewards). Pass this to burnAgentTokens to wipe the ATA. */
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

  // Snapshot the ATA balance BEFORE the swap so the slippage check compares
  // the delta (post - pre), not absolute. Required when autoClaim may have
  // pre-funded the ATA — otherwise a zero-fill swap passes trivially.
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

  // Record swap_done immediately post-confirmation so any later failure is
  // recoverable: RPC errors inside verifySwapOutput keep status='swap_done'
  // for next-tick recovery; a real slippage bust flips the row to 'failed'
  // so recovery doesn't auto-burn a partial fill. agent_token_bought is
  // seeded with the quote minimum and rewritten with the verified amount.
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

  // bought = swap delivery; totalAtaAmount = delivery + any pre-existing
  // (e.g. claimed telecoin rewards). Burning totalAtaAmount wipes the ATA.
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
      /** Populated when autoClaim was configured AND a claim ran this cycle.
       *  solIn already reflects the claim-boosted SOL balance; amountBurned
       *  includes any claimed telecoin rewards that were in the ATA. */
      claim?: ClaimPhaseResult;
    }
  | {
      action: 'failed';
      stage: 'preflight' | 'claim' | 'swap' | 'burn';
      error: string;
      claim?: ClaimPhaseResult;
    };

/** Run the claim phase. Null when autoClaim is off OR nothing was above
 *  threshold. Errors bubble up to runBuybackCycle's 'failed' handler. */
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
    // Phase 0 — recovery. Burn leftover tokens from a prior
    // swap-succeeded-burn-failed state before running anything else.
    // Claim stays OFF here to avoid mixing fresh rewards into a recovery burn.
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

    // Phase 0.5 — autoClaim. After recovery, before threshold check, so
    // claimed SOL can lift the wallet over the threshold.
    stage = 'claim';
    claim = await runClaimPhase(cfg);

    // Phase 1 — swap.
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

    // Phase 2 — burn totalAtaAmount (swap delivery + any claimed telecoin
    // rewards sitting in the same ATA) in a single ix.
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
