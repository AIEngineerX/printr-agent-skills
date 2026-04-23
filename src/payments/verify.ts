import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import {
  MEMO_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from './constants.js';

export const GRACE_PAST_END_SECONDS = 300;
export const CLOCK_SKEW_SECONDS = 60;
export const SIGNATURE_PAGE_SIZE = 200;

export interface QueryablePool {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface InvoiceRow {
  memo: string | bigint;
  user_wallet: string;
  currency_mint: string;
  amount_smallest_unit: string | bigint;
  start_time: number | string;
  end_time: number | string;
  status: 'pending' | 'paid' | 'expired' | 'cancelled';
  tx_sig: string | null;
}

export type VerifyResult =
  | { paid: true; tx_sig: string; blockTime: number }
  | { paid: false; reason: 'not_found' | 'expired' | 'already_marked_paid' };

export interface VerifyContext {
  pool: QueryablePool;
  connection: Connection;
  treasuryPubkey: PublicKey;
  treasuryUsdcAta?: () => Promise<string>;
}

/** Lazy-memoized treasury USDC ATA. Invalidates on rejection so a transient
 *  failure doesn't lock in the error. */
export function makeTreasuryUsdcAtaCache(treasuryPubkey: PublicKey): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return (): Promise<string> => {
    if (cached) return cached;
    cached = getAssociatedTokenAddress(new PublicKey(USDC_MINT), treasuryPubkey)
      .then((pk) => pk.toBase58())
      .catch((e) => {
        cached = null;
        throw e;
      });
    return cached;
  };
}

/**
 * Returns paid: true only when a single on-chain tx satisfies ALL of:
 *  - Memo instruction with data equal to String(invoice.memo)
 *  - SOL transfer user → treasury for exactly invoice.amount, OR
 *    USDC transfer from user wallet → treasury's USDC ATA for exactly invoice.amount
 *  - blockTime within [start_time - skew, end_time + grace]
 */
export async function verifyInvoiceOnChain(
  ctx: VerifyContext,
  opts: { memo: bigint },
): Promise<VerifyResult> {
  const { rows } = await ctx.pool.query(
    `SELECT memo, user_wallet, currency_mint, amount_smallest_unit,
            start_time, end_time, status, tx_sig
       FROM payment_invoice
      WHERE memo = $1
      LIMIT 1`,
    [opts.memo.toString()],
  );
  if (rows.length === 0) return { paid: false, reason: 'not_found' };

  const inv = rows[0] as InvoiceRow;
  if (inv.status === 'paid' && inv.tx_sig) {
    return { paid: true, tx_sig: inv.tx_sig, blockTime: 0 };
  }
  if (inv.status !== 'pending') return { paid: false, reason: 'already_marked_paid' };

  const now = Math.floor(Date.now() / 1000);
  const endTime = Number(inv.end_time);
  if (now > endTime + GRACE_PAST_END_SECONDS) {
    return { paid: false, reason: 'expired' };
  }

  const sigs = await ctx.connection.getSignaturesForAddress(
    ctx.treasuryPubkey,
    { limit: SIGNATURE_PAGE_SIZE },
  );

  const windowStart = Number(inv.start_time) - CLOCK_SKEW_SECONDS;
  const windowEnd = endTime + GRACE_PAST_END_SECONDS;
  const candidates = sigs.filter(
    (s) => s.blockTime != null && s.blockTime >= windowStart && s.blockTime <= windowEnd,
  );
  if (candidates.length === 0) return { paid: false, reason: 'not_found' };

  const batch = await ctx.connection.getParsedTransactions(
    candidates.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  );

  const isSol = inv.currency_mint === WSOL_MINT;
  const userPubkey = new PublicKey(inv.user_wallet);
  const expectedMemo = opts.memo.toString();
  const expectedAmount = BigInt(inv.amount_smallest_unit);
  const expectedTreasuryAta = isSol
    ? null
    : await (ctx.treasuryUsdcAta ?? makeTreasuryUsdcAtaCache(ctx.treasuryPubkey))();

  for (let i = 0; i < batch.length; i++) {
    const tx = batch[i];
    if (!tx?.meta || tx.meta.err) continue;

    const ixs = tx.transaction.message.instructions;
    if (!ixs.some((ix) => instructionIsMemo(ix, expectedMemo))) continue;

    const payMatch = isSol
      ? ixs.some((ix) => instructionIsSolTransfer(ix, userPubkey, ctx.treasuryPubkey, expectedAmount))
      : ixs.some((ix) => instructionIsUsdcTransfer(ix, userPubkey, expectedTreasuryAta!, expectedAmount));
    if (!payMatch) continue;

    return { paid: true, tx_sig: candidates[i].signature, blockTime: tx.blockTime ?? 0 };
  }

  return { paid: false, reason: 'not_found' };
}

type Ix = ParsedInstruction | PartiallyDecodedInstruction;

export function instructionIsMemo(ix: Ix, expectedMemo: string): boolean {
  if (ix.programId.toBase58() !== MEMO_PROGRAM_ID) return false;
  // jsonParsed form: { parsed: <memo string> }
  if ('parsed' in ix && typeof ix.parsed === 'string') return ix.parsed === expectedMemo;
  // Raw form: data is base58-encoded UTF-8 memo bytes
  if ('data' in ix && typeof ix.data === 'string') {
    return Buffer.from(bs58.decode(ix.data)).toString('utf8') === expectedMemo;
  }
  return false;
}

export function instructionIsSolTransfer(
  ix: Ix,
  from: PublicKey,
  to: PublicKey,
  lamports: bigint,
): boolean {
  if (ix.programId.toBase58() !== SYSTEM_PROGRAM_ID) return false;
  if (!('parsed' in ix) || ix.parsed?.type !== 'transfer') return false;
  const info = ix.parsed.info as {
    source: string;
    destination: string;
    lamports: number | string;
  };
  return (
    info.source === from.toBase58() &&
    info.destination === to.toBase58() &&
    BigInt(info.lamports) === lamports
  );
}

export function instructionIsUsdcTransfer(
  ix: Ix,
  userWallet: PublicKey,
  treasuryAta: string,
  amount: bigint,
): boolean {
  if (ix.programId.toBase58() !== TOKEN_PROGRAM_ID) return false;
  if (!('parsed' in ix)) return false;
  const t = ix.parsed?.type;
  if (t !== 'transferChecked' && t !== 'transfer') return false;

  const info = ix.parsed.info as {
    source: string;
    destination: string;
    authority?: string;
    owner?: string;
    tokenAmount?: { amount: string; decimals: number };
    amount?: string;
    mint?: string;
  };

  const signer = info.authority ?? info.owner;
  if (signer !== userWallet.toBase58()) return false;
  if (t === 'transferChecked' && info.mint && info.mint !== USDC_MINT) return false;
  if (info.destination !== treasuryAta) return false;

  const amt = info.tokenAmount
    ? BigInt(info.tokenAmount.amount)
    : info.amount ? BigInt(info.amount) : -1n;
  return amt === amount;
}

/** 10×2s retry loop absorbs RPC indexer propagation delay. Returns true only
 *  when the DB UPDATE flipped a 'pending' row (rowCount=1). */
export async function verifyInvoiceWithRetries(
  ctx: VerifyContext,
  memo: bigint,
  retryCount = 10,
  retryDelayMs = 2000,
): Promise<boolean> {
  for (let attempt = 0; attempt < retryCount; attempt++) {
    const result = await verifyInvoiceOnChain(ctx, { memo });
    if (result.paid) {
      const { rowCount } = await ctx.pool.query(
        `UPDATE payment_invoice
           SET status = 'paid', tx_sig = $1, paid_at = now()
         WHERE memo = $2 AND status = 'pending'`,
        [result.tx_sig, memo.toString()],
      );
      return (rowCount ?? 0) === 1;
    }
    if (attempt < retryCount - 1) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}
