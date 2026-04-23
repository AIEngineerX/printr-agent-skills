import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  createBurnInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import {
  quoteSwap,
  buildSwapTransaction,
  executeServerSwap,
  verifySwapOutput,
} from '../swap/index.js';
import { WSOL_MINT } from '../payments/constants.js';
import type { QueryablePool } from '../payments/verify.js';

export const FEE_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL held back for tx fees

export interface CycleConfig {
  pool: QueryablePool;
  connection: Connection;
  hotKeypair: Keypair;
  agentTokenMint: PublicKey;
  thresholdLamports: bigint;
  maxPerCycleLamports: bigint;
  slippageBps: number;
}

export async function findRecoveryCycle(
  cfg: CycleConfig,
): Promise<{ id: number; amountToBurn: bigint } | null> {
  const ata = await getAssociatedTokenAddress(cfg.agentTokenMint, cfg.hotKeypair.publicKey);

  let ataBalance: bigint;
  try {
    const acct = await getAccount(cfg.connection, ata, 'confirmed');
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
  | { action: 'swapped'; cycleId: number; swapSig: string; bought: bigint; solIn: bigint };

export async function startCycle(cfg: CycleConfig): Promise<StartCycleResult> {
  const hotBalanceLamports = BigInt(
    await cfg.connection.getBalance(cfg.hotKeypair.publicKey, 'confirmed'),
  );
  const available = hotBalanceLamports - FEE_RESERVE_LAMPORTS;
  const amountIn = available < cfg.maxPerCycleLamports ? available : cfg.maxPerCycleLamports;

  if (hotBalanceLamports < cfg.thresholdLamports || amountIn <= 0n) {
    return { action: 'noop', reason: 'below_threshold', hotBalance: hotBalanceLamports };
  }

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

  const actualOut = await verifySwapOutput(
    cfg.connection,
    cfg.agentTokenMint,
    cfg.hotKeypair.publicKey,
    BigInt(quote.otherAmountThreshold),
  );

  // Record the swap BEFORE the burn runs. If the burn fails after this,
  // findRecoveryCycle picks up the orphan balance next cycle.
  const { rows } = await cfg.pool.query(
    `INSERT INTO burn_event
       (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
     VALUES ($1, $2, 0, $3, 'swap_done')
     RETURNING id`,
    [amountIn.toString(), actualOut.toString(), swapSig],
  );

  return {
    action: 'swapped',
    cycleId: Number(rows[0].id),
    swapSig,
    bought: actualOut,
    solIn: amountIn,
  };
}

export async function burnAgentTokens(
  cfg: CycleConfig,
  cycleId: number,
  amountToBurn: bigint,
): Promise<string> {
  const ata = await getAssociatedTokenAddress(cfg.agentTokenMint, cfg.hotKeypair.publicKey);

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    createBurnInstruction(ata, cfg.agentTokenMint, cfg.hotKeypair.publicKey, amountToBurn),
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

export type CycleResult =
  | { action: 'noop'; reason: 'below_threshold'; hotBalance: bigint }
  | { action: 'recovered'; cycleId: number; burnSig: string; amountBurned: bigint }
  | {
      action: 'completed';
      cycleId: number;
      swapSig: string;
      burnSig: string;
      solIn: bigint;
      amountBurned: bigint;
    }
  | { action: 'failed'; stage: 'preflight' | 'swap' | 'burn'; error: string };

export async function runBuybackCycle(cfg: CycleConfig): Promise<CycleResult> {
  let stage: 'preflight' | 'swap' | 'burn' = 'preflight';

  try {
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

    stage = 'swap';
    const start = await startCycle(cfg);
    if (start.action === 'noop') {
      return { action: 'noop', reason: 'below_threshold', hotBalance: start.hotBalance };
    }

    stage = 'burn';
    const burnSig = await burnAgentTokens(cfg, start.cycleId, start.bought);
    return {
      action: 'completed',
      cycleId: start.cycleId,
      swapSig: start.swapSig,
      burnSig,
      solIn: start.solIn,
      amountBurned: start.bought,
    };
  } catch (e) {
    return {
      action: 'failed',
      stage,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
