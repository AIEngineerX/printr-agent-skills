import crypto from 'node:crypto';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  type Currency,
  DECIMALS,
  MEMO_PROGRAM_ID,
  SUPPORTED_MINTS,
  USDC_MINT,
  WSOL_MINT,
  mintToCurrency,
} from './constants.js';

// Memo program instruction builder (inlined to avoid a dependency on
// @solana/spl-memo, which adds no value beyond this 10-line helper).
export function createMemoInstruction(
  memo: string,
  signers: PublicKey[] = [],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: signers.map((pubkey) => ({
      pubkey,
      isSigner: true,
      isWritable: false,
    })),
    data: Buffer.from(memo, 'utf8'),
  });
}

export interface GeneratedInvoice {
  memo: bigint;
  currency_mint: string;
  amount_smallest_unit: bigint;
  start_time: number;
  end_time: number;
}

export interface GenerateInvoiceOpts {
  currency: Currency;
  price_smallest_unit: bigint;
  durationSeconds?: number;
}

export function generateInvoiceParams(opts: GenerateInvoiceOpts): GeneratedInvoice {
  if (!(opts.currency in SUPPORTED_MINTS)) {
    throw new Error(
      `unknown currency ${String(opts.currency)} — must be one of ${Object.keys(SUPPORTED_MINTS).join(', ')}`,
    );
  }
  if (opts.price_smallest_unit <= 0n) {
    throw new Error('price_smallest_unit must be > 0');
  }
  const ttl = opts.durationSeconds ?? 86400;
  if (ttl <= 0) throw new Error('durationSeconds must be > 0');

  // Cryptographically random 63-bit memo. Top bit masked off so the value
  // fits a signed BIGINT column and stringifies compactly for on-chain memo.
  const buf = crypto.randomBytes(8);
  const memo = buf.readBigUInt64BE() & 0x7fff_ffff_ffff_ffffn;

  const now = Math.floor(Date.now() / 1000);
  return {
    memo,
    currency_mint: SUPPORTED_MINTS[opts.currency],
    amount_smallest_unit: opts.price_smallest_unit,
    start_time: now,
    end_time: now + ttl,
  };
}

export interface BuildPaymentTxParams {
  userWallet: string;
  treasuryReceiver: string;
  memo: bigint;
  currency_mint: string;
  amount_smallest_unit: bigint;
  priorityFeeMicroLamports?: number;
}

/**
 * Build an unsigned payment Transaction, base64-serialized for client
 * signing. Validates the currency_mint against the whitelist — an
 * unknown mint would be catastrophic on the SPL path because decimals
 * are hardcoded per currency.
 *
 * The `connection` parameter is the Solana RPC Connection used to fetch
 * a recent blockhash. Injecting it (vs. constructing from env inside)
 * makes the function testable against a mock Connection.
 */
export async function buildPaymentTransaction(
  connection: Connection,
  params: BuildPaymentTxParams,
): Promise<string> {
  const currency = mintToCurrency(params.currency_mint);
  if (!currency) {
    throw new Error(
      `unsupported currency_mint ${params.currency_mint} — must be one of ${WSOL_MINT} (SOL) or ${USDC_MINT} (USDC)`,
    );
  }
  if (params.amount_smallest_unit <= 0n) {
    throw new Error('amount_smallest_unit must be > 0');
  }

  const user = new PublicKey(params.userWallet);
  const treasury = new PublicKey(params.treasuryReceiver);
  const tx = new Transaction();

  // Priority fee + CU limit — always prepend.
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: params.priorityFeeMicroLamports ?? 100_000,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
  );

  // Memo instruction — binds this tx to the invoice row.
  tx.add(createMemoInstruction(params.memo.toString(), [user]));

  // Payment instruction — SOL or SPL. web3.js ^1.98 accepts bigint
  // directly for both lamports and SPL transfer amounts, so no manual
  // number conversion is needed on any path below.
  if (currency === 'SOL') {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: treasury,
        lamports: params.amount_smallest_unit,
      }),
    );
  } else {
    // USDC (the only SPL currency we support).
    // Caller is responsible for ensuring the treasury's USDC ATA exists —
    // prepend createAssociatedTokenAccountIdempotentInstruction if not
    // already guaranteed.
    const currencyMint = new PublicKey(params.currency_mint);
    const sourceAta = await getAssociatedTokenAddress(currencyMint, user);
    const destAta   = await getAssociatedTokenAddress(currencyMint, treasury);
    tx.add(
      createTransferCheckedInstruction(
        sourceAta,
        currencyMint,
        destAta,
        user,
        params.amount_smallest_unit,
        DECIMALS[currency],
        [],
        SPL_TOKEN_PROGRAM_ID,
      ),
    );
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = user;

  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}
