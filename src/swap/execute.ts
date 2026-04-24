import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

import {
  TOKEN_2022_PROGRAM_ID as TOKEN_2022_PROGRAM_ID_STR,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID_STR,
} from '../payments/constants.js';

export function loadHotKeypair(): Keypair {
  const secret = process.env.TREASURY_HOT_PRIVATE_KEY;
  if (!secret) throw new Error('TREASURY_HOT_PRIVATE_KEY not set');
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64) {
    throw new Error(`expected 64-byte secret, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}

export async function executeUserSwap(
  txBase64: string,
  lastValidBlockHeight: number,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  connection: Connection,
): Promise<string> {
  if (!signTransaction) throw new Error('Wallet does not support signing');
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

export async function executeServerSwap(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  keypair: Keypair,
): Promise<string> {
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
    preflightCommitment: 'confirmed',
  });
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new OnChainConfirmError('swap', conf.value.err);
  }
  return sig;
}

/** Thrown by verifySwapOutput when the swap confirmed but delivered less than
 *  the quote's minimum output. Distinct class lets callers distinguish a real
 *  slippage bust (no retry, operator decides) from a transient RPC failure
 *  during the post-swap ATA read (safe to recover next cycle). */
export class SwapBelowMinimumError extends Error {
  readonly actual: bigint;
  readonly minimum: bigint;
  constructor(actual: bigint, minimum: bigint) {
    super(`swap output below minimum: got ${actual}, expected >= ${minimum}`);
    this.name = 'SwapBelowMinimumError';
    this.actual = actual;
    this.minimum = minimum;
  }
}

/** Thrown when a tx landed but the RPC reports a non-null `meta.err`. The
 *  `operation` field identifies which primitive failed ('swap' / 'burn' /
 *  'claim') so adopters can route by call-site. */
export class OnChainConfirmError extends Error {
  readonly operation: string;
  readonly chainError: unknown;
  constructor(operation: string, chainError: unknown) {
    super(`${operation} failed on-chain: ${JSON.stringify(chainError)}`);
    this.name = 'OnChainConfirmError';
    this.operation = operation;
    this.chainError = chainError;
  }
}

/** Throws SwapBelowMinimumError if the ATA didn't receive at least
 *  minOutAmount — a tx can confirm without delivering expected output on a
 *  partial-fill route. Any other thrown error (RPC timeout, ATA not found)
 *  indicates the read itself failed, not a slippage bust.
 *
 *  `tokenProgramId` defaults to classic SPL. Pass `TOKEN_2022_PROGRAM_ID`
 *  for Token-2022 mints — the program ID is a seed in ATA derivation and a
 *  parsing key in `getAccount`. A mismatch derives the wrong ATA and throws
 *  TokenAccountNotFoundError every cycle. **[Printr]**
 *
 *  `preSwapBalance` switches the slippage check from absolute to delta
 *  (`account.amount - preSwapBalance`). Required when the ATA may have been
 *  pre-funded (e.g. by an earlier claim-rewards call) — without it the
 *  absolute check passes trivially and hides a zero-fill swap. */
export async function verifySwapOutput(
  connection: Connection,
  outputMint: PublicKey,
  owner: PublicKey,
  minOutAmount: bigint,
  tokenProgramId: PublicKey = SPL_TOKEN_PROGRAM_ID,
  preSwapBalance?: bigint,
): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(outputMint, owner, false, tokenProgramId);
  const account = await getAccount(connection, ata, 'confirmed', tokenProgramId);
  if (preSwapBalance !== undefined) {
    const delta = account.amount - preSwapBalance;
    if (delta < minOutAmount) {
      throw new SwapBelowMinimumError(delta, minOutAmount);
    }
  } else if (account.amount < minOutAmount) {
    throw new SwapBelowMinimumError(account.amount, minOutAmount);
  }
  return account.amount;
}

/** Dry-run swap result. Validates route resolution, tx landability, and
 *  compute cost — not POB fee liveness (that's async, not per-swap; use
 *  `scripts/verify-printr-mechanism.ts`). */
export interface SimulateSwapResult {
  ok: boolean;
  err: unknown;
  logs: readonly string[];
  computeUnitsConsumed: number | null;
  innerInstructions: SimulatedTransactionResponse['innerInstructions'];
  /** Count of Token-program transfer / transferChecked ixs across inner
   *  instruction groups (covers both classic SPL and Token-2022). Route-sanity
   *  check; null when the RPC didn't return inner ixs in parsed form. */
  tokenTransferCount: number | null;
}

/** Run the swap tx through `simulateTransaction` — no submission, no
 *  signature required (`sigVerify: false`), fresh blockhash injected
 *  (`replaceRecentBlockhash: true`). */
export async function simulateSwap(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<SimulateSwapResult> {
  const result = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
    innerInstructions: true,
  });

  const value = result.value;
  const inners = value.innerInstructions ?? null;
  let tokenTransferCount: number | null = null;

  if (inners) {
    tokenTransferCount = 0;
    for (const group of inners) {
      for (const ix of group.instructions) {
        const programId = 'programId' in ix ? ix.programId.toBase58() : null;
        if (programId !== TOKEN_PROGRAM_ID_STR && programId !== TOKEN_2022_PROGRAM_ID_STR) continue;
        if (
          'parsed' in ix &&
          typeof ix.parsed === 'object' &&
          ix.parsed !== null &&
          'type' in ix.parsed
        ) {
          const t = (ix.parsed as { type: string }).type;
          if (t === 'transfer' || t === 'transferChecked') tokenTransferCount++;
        }
      }
    }
  }

  return {
    ok: value.err == null,
    err: value.err,
    logs: value.logs ?? [],
    computeUnitsConsumed: value.unitsConsumed ?? null,
    innerInstructions: inners,
    tokenTransferCount,
  };
}
