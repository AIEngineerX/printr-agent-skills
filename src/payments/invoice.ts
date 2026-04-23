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

/** Inlined to avoid depending on @solana/spl-memo for a 10-line helper. */
export function createMemoInstruction(
  memo: string,
  signers: PublicKey[] = [],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: Buffer.from(memo, 'utf8'),
  });
}

export function generateInvoiceParams(opts: {
  currency: Currency;
  price_smallest_unit: bigint;
  durationSeconds?: number;
}): {
  memo: bigint;
  currency_mint: string;
  amount_smallest_unit: bigint;
  start_time: number;
  end_time: number;
} {
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

  // Mask top bit so the 63-bit value fits a signed BIGINT column.
  const memo = crypto.randomBytes(8).readBigUInt64BE() & 0x7fff_ffff_ffff_ffffn;
  const now = Math.floor(Date.now() / 1000);
  return {
    memo,
    currency_mint: SUPPORTED_MINTS[opts.currency],
    amount_smallest_unit: opts.price_smallest_unit,
    start_time: now,
    end_time: now + ttl,
  };
}

export async function buildPaymentTransaction(
  connection: Connection,
  params: {
    userWallet: string;
    treasuryReceiver: string;
    memo: bigint;
    currency_mint: string;
    amount_smallest_unit: bigint;
    priorityFeeMicroLamports?: number;
  },
): Promise<string> {
  const currency = mintToCurrency(params.currency_mint);
  if (!currency) {
    throw new Error(
      `unsupported currency_mint ${params.currency_mint} — must be ${WSOL_MINT} (SOL) or ${USDC_MINT} (USDC)`,
    );
  }
  if (params.amount_smallest_unit <= 0n) {
    throw new Error('amount_smallest_unit must be > 0');
  }

  const user = new PublicKey(params.userWallet);
  const treasury = new PublicKey(params.treasuryReceiver);
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: params.priorityFeeMicroLamports ?? 100_000,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    createMemoInstruction(params.memo.toString(), [user]),
  );

  // web3.js ^1.98 accepts bigint for lamports and SPL amounts directly.
  if (currency === 'SOL') {
    tx.add(SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: treasury,
      lamports: params.amount_smallest_unit,
    }));
  } else {
    // Caller must ensure treasury's USDC ATA exists — prepend
    // createAssociatedTokenAccountIdempotentInstruction if unsure.
    const currencyMint = new PublicKey(params.currency_mint);
    const sourceAta = await getAssociatedTokenAddress(currencyMint, user);
    const destAta   = await getAssociatedTokenAddress(currencyMint, treasury);
    tx.add(createTransferCheckedInstruction(
      sourceAta,
      currencyMint,
      destAta,
      user,
      params.amount_smallest_unit,
      DECIMALS[currency],
      [],
      SPL_TOKEN_PROGRAM_ID,
    ));
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = user;

  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}
