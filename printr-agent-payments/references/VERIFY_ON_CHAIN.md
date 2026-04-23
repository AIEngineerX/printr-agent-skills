# Verify Invoice On-Chain — full implementation

This file exports `verifyInvoiceOnChain` — the server-side payment-verification routine. The function scans the treasury wallet's recent signatures, parses each candidate transaction, and matches memo + payment + time window against the `payment_invoice` row for the given memo.

## Design

**Why scan the treasury wallet and not the user's wallet?** Because the treasury is the known fixed endpoint. The user's wallet is unknown at scan time (we hold the memo, not the payer). Pulling all transfers to the treasury gives us the payment candidates; parsing the memo instruction on the same tx proves which invoice it's settling. **[derived]**

**Why not rely on the client's submitted signature?** Clients can be spoofed. Even if the client provides a `tx_sig`, the server must verify the tx exists, references the correct memo, and has the right amount/sender/recipient. Safety rule 6. **[pattern]**

**Duplicate-pay safety.** Two independent mechanisms:

1. The DB `UPDATE ... WHERE status='pending'` is idempotent — only the first caller flips the row (rowCount=1); all subsequent callers see rowCount=0 and must not credit. **[derived]**
2. Memo + time-window uniqueness means only one tx on chain can satisfy any given invoice row.

## Full implementation

```typescript
import {
  Connection,
  PublicKey,
  ParsedInstruction,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { Pool } from '@neondatabase/serverless';
import bs58 from 'bs58';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const GRACE_PAST_END_SECONDS = 300; // accept confirmations up to 5 min past end_time
const CLOCK_SKEW_SECONDS = 60; // allow 1 min of clock skew at start_time
const SIGNATURE_PAGE_SIZE = 200; // see "Why 200 sigs?" below

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

/**
 * Treasury USDC ATA — lazy-memoized on first verify call.
 * The ATA is deterministic (derived from mint + wallet pubkey) so the
 * Promise is safe to cache for the process lifetime. Concurrent callers
 * share a single in-flight getAssociatedTokenAddress call, not N.
 */
let treasuryUsdcAtaPromise: Promise<string> | null = null;
function treasuryUsdcAta(): Promise<string> {
  if (!treasuryUsdcAtaPromise) {
    treasuryUsdcAtaPromise = getAssociatedTokenAddress(
      new PublicKey(USDC_MINT),
      new PublicKey(process.env.TREASURY_RECEIVER_PUBKEY!),
    ).then((pk) => pk.toBase58());
  }
  return treasuryUsdcAtaPromise;
}

export type VerifyResult =
  | { paid: true; tx_sig: string; blockTime: number }
  | { paid: false; reason: 'not_found' | 'expired' | 'already_marked_paid' };

/**
 * Returns paid: true only when a single on-chain tx satisfies ALL of:
 *  - Memo instruction data === String(invoice.memo)
 *  - Native SOL transfer user → treasury for exactly invoice.amount lamports, OR
 *    SPL transfer of USDC from user wallet → treasury's USDC ATA for exactly invoice.amount
 *  - Transaction blockTime within invoice.start_time .. invoice.end_time (with grace)
 */
export async function verifyInvoiceOnChain(opts: { memo: bigint }): Promise<VerifyResult> {
  // 1. Load invoice. Bail on missing / already-settled / expired.
  const { rows } = await pool.query(
    `SELECT memo, user_wallet, currency_mint, amount_smallest_unit,
            start_time, end_time, status, tx_sig
       FROM payment_invoice
      WHERE memo = $1
      LIMIT 1`,
    [opts.memo.toString()],
  );
  if (rows.length === 0) return { paid: false, reason: 'not_found' };

  const inv = rows[0];
  if (inv.status === 'paid' && inv.tx_sig) {
    return { paid: true, tx_sig: inv.tx_sig, blockTime: 0 };
  }
  if (inv.status !== 'pending') return { paid: false, reason: 'already_marked_paid' };

  const now = Math.floor(Date.now() / 1000);
  if (now > Number(inv.end_time) + GRACE_PAST_END_SECONDS) {
    return { paid: false, reason: 'expired' };
  }

  // 2. Pull recent treasury signatures, filter to the invoice time window.
  const connection = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
  const treasury = new PublicKey(process.env.TREASURY_RECEIVER_PUBKEY!);
  const sigs = await connection.getSignaturesForAddress(treasury, { limit: SIGNATURE_PAGE_SIZE });

  const windowStart = Number(inv.start_time) - CLOCK_SKEW_SECONDS;
  const windowEnd = Number(inv.end_time) + GRACE_PAST_END_SECONDS;
  const candidates = sigs.filter(
    (s) => s.blockTime != null && s.blockTime >= windowStart && s.blockTime <= windowEnd,
  );
  if (candidates.length === 0) return { paid: false, reason: 'not_found' };

  // 3. Batch-fetch parsed txs; stop on first memo+payment match.
  const batch = await connection.getParsedTransactions(
    candidates.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  );

  const isSol = inv.currency_mint === WSOL_MINT;
  const userPubkey = new PublicKey(inv.user_wallet);
  const expectedMemo = opts.memo.toString();
  const expectedAmount = BigInt(inv.amount_smallest_unit);
  const expectedTreasuryAta = isSol ? null : await treasuryUsdcAta();

  for (let i = 0; i < batch.length; i++) {
    const tx = batch[i];
    if (!tx?.meta || tx.meta.err) continue;

    const ixs = tx.transaction.message.instructions;
    if (!ixs.some((ix) => instructionIsMemo(ix, expectedMemo))) continue;

    const payMatch = isSol
      ? ixs.some((ix) => instructionIsSolTransfer(ix, userPubkey, treasury, expectedAmount))
      : ixs.some((ix) =>
          instructionIsUsdcTransfer(ix, userPubkey, expectedTreasuryAta!, expectedAmount),
        );
    if (!payMatch) continue;

    return { paid: true, tx_sig: candidates[i].signature, blockTime: tx.blockTime ?? 0 };
  }

  return { paid: false, reason: 'not_found' };
}

// ---- instruction matchers ----

type Ix = ParsedInstruction | PartiallyDecodedInstruction;

function instructionIsMemo(ix: Ix, expectedMemo: string): boolean {
  if (ix.programId.toBase58() !== MEMO_PROGRAM_ID) return false;
  // Parsed form: { programId, program: 'spl-memo', parsed: <memo string> }
  if ('parsed' in ix && typeof ix.parsed === 'string') return ix.parsed === expectedMemo;
  // Raw form: { programId, accounts, data: base58-encoded UTF-8 memo bytes }
  if ('data' in ix && typeof ix.data === 'string') {
    return Buffer.from(bs58.decode(ix.data)).toString('utf8') === expectedMemo;
  }
  return false;
}

function instructionIsSolTransfer(
  ix: Ix,
  from: PublicKey,
  to: PublicKey,
  lamports: bigint,
): boolean {
  if (ix.programId.toBase58() !== SYSTEM_PROGRAM_ID) return false;
  if (!('parsed' in ix) || ix.parsed?.type !== 'transfer') return false;
  const info = ix.parsed.info as { source: string; destination: string; lamports: number | string };
  return (
    info.source === from.toBase58() &&
    info.destination === to.toBase58() &&
    BigInt(info.lamports) === lamports
  );
}

function instructionIsUsdcTransfer(
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
    : info.amount
      ? BigInt(info.amount)
      : -1n;
  return amt === amount;
}
```

No boot-time setup required — the treasury ATA is derived on first verify call and cached for the process lifetime.

## Why 200 sigs?

Solana's default `getSignaturesForAddress` returns up to 1000. We cap at `SIGNATURE_PAGE_SIZE = 200` because:

- Invoice TTL defaults to 24h; 200 sigs on a mid-traffic treasury covers ~1–6 hours under real load.
- Free-tier RPCs (Helius, Ankr) rate-limit at ~5 RPS. 200 × getParsedTransactions batched = 1 compute-heavy RPC call.
- If your treasury is hot enough that 200 doesn't cover your shortest invoice window, switch to webhook-driven verification (Helius Enhanced Webhooks) — push model instead of pull.

See the sibling `printr-eco` skill for the Helius webhook pattern if you outgrow this.
