# Verify Invoice On-Chain — full implementation

This file exports `verifyInvoiceOnChain`, the hand-rolled equivalent of pump.fun's `validateInvoicePayment` **[pump.fun]**. The function scans the treasury wallet's recent signatures, parses each candidate transaction, and matches memo + payment + time window against the `payment_invoice` row for the given memo.

## Design

**Why scan the treasury wallet and not the user's wallet?** Because the treasury is the known fixed endpoint. The user's wallet is unknown at scan time (we hold the memo, not the payer). Printing all SPL transfers to the treasury gives us the payment candidates; parsing the memo instruction on the same tx proves which invoice it's settling. **[derived]**

**Why not rely on the client's submitted signature?** Clients can be spoofed. Even if the client provides a `tx_sig`, the server must verify the tx exists, references the correct memo, and has the right amount/sender/recipient. Safety rule 6. **[pump.fun]**

**Duplicate-pay safety.** Two independent mechanisms:
1. The DB `UPDATE ... WHERE status='pending'` has RETURN / rowCount; only the first caller flips the row. **[derived]**
2. Even without the DB, the on-chain memo uniqueness plus the UNIQUE constraint on the memo column makes replay impossible per invoice.

## Program IDs

```typescript
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
```

## Full implementation

```typescript
import { Connection, PublicKey, ParsedInstruction, PartiallyDecodedInstruction } from '@solana/web3.js';
import { Pool } from '@neondatabase/serverless';

const MEMO_PROGRAM_ID   = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL_MINT         = 'So11111111111111111111111111111111111111112';
const USDC_MINT         = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

export type VerifyResult =
  | { paid: true; tx_sig: string; blockTime: number }
  | { paid: false; reason: 'not_found' | 'expired' | 'already_marked_paid' };

/**
 * Scan the treasury wallet for a payment matching the invoice row keyed by memo.
 *
 * Returns paid: true only when all of the following hold on the same transaction:
 *  - Memo instruction data === String(invoice.memo)
 *  - Native SOL transfer user → treasury for exactly invoice.amount lamports, OR
 *    SPL transfer of USDC from user's ATA → treasury's ATA for exactly invoice.amount atomic units
 *  - Transaction blockTime within invoice.start_time .. invoice.end_time
 */
export async function verifyInvoiceOnChain(opts: { memo: bigint }): Promise<VerifyResult> {
  // Step 1. Load invoice. Look up by memo PK; bail if missing or already settled.
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
  if (inv.status !== 'pending') {
    return { paid: false, reason: 'already_marked_paid' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > Number(inv.end_time) + 300) {
    // 5-min grace window past end_time to absorb RPC propagation delay.
    return { paid: false, reason: 'expired' };
  }

  // Step 2. List recent signatures on the treasury wallet.
  const connection = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
  const treasury = new PublicKey(process.env.TREASURY_RECEIVER_PUBKEY!);

  // limit=200 covers ~5 min of high-traffic treasury activity and stays
  // under the free-tier RPC page size. Bump to 500 if your treasury is
  // hotter than that.
  const sigs = await connection.getSignaturesForAddress(treasury, { limit: 200 });

  // Filter to signatures within the invoice's time window (with grace).
  const windowStart = Number(inv.start_time) - 60;   // allow 1-min clock skew
  const windowEnd   = Number(inv.end_time) + 300;
  const candidates = sigs.filter((s) => {
    if (!s.blockTime) return false;
    return s.blockTime >= windowStart && s.blockTime <= windowEnd;
  });

  if (candidates.length === 0) return { paid: false, reason: 'not_found' };

  // Step 3. Walk candidates newest-first. Parse each. Stop on first match.
  // We batch-fetch to minimize RPC round-trips.
  const batch = await connection.getParsedTransactions(
    candidates.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  );

  const isSol = inv.currency_mint === WSOL_MINT;
  const userPubkey = new PublicKey(inv.user_wallet);
  const expectedMemo = opts.memo.toString();
  const expectedAmount = BigInt(inv.amount_smallest_unit);

  for (let i = 0; i < batch.length; i++) {
    const tx = batch[i];
    if (!tx || !tx.meta || tx.meta.err) continue;

    const ixs = tx.transaction.message.instructions;

    // Must contain a memo instruction with our exact memo.
    const hasMemo = ixs.some((ix) => instructionIsMemo(ix, expectedMemo));
    if (!hasMemo) continue;

    // Must contain the payment instruction with exact amount, correct sender+recipient.
    const payMatch = isSol
      ? ixs.some((ix) => instructionIsSolTransfer(ix, userPubkey, treasury, expectedAmount))
      : ixs.some((ix) => instructionIsUsdcTransfer(ix, userPubkey, treasury, expectedAmount));
    if (!payMatch) continue;

    return {
      paid: true,
      tx_sig: candidates[i].signature,
      blockTime: tx.blockTime ?? 0,
    };
  }

  return { paid: false, reason: 'not_found' };
}

// ---- instruction matchers ----

function instructionIsMemo(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
  expectedMemo: string,
): boolean {
  if (ix.programId.toBase58() !== MEMO_PROGRAM_ID) return false;
  // Parsed form: { programId, program: 'spl-memo', parsed: <string> }
  // Raw form:    { programId, accounts, data: base58 }
  if ('parsed' in ix && typeof ix.parsed === 'string') {
    return ix.parsed === expectedMemo;
  }
  if ('data' in ix && typeof ix.data === 'string') {
    // data is base58-encoded UTF-8 memo text.
    const decoded = Buffer.from(bs58Decode(ix.data)).toString('utf8');
    return decoded === expectedMemo;
  }
  return false;
}

function instructionIsSolTransfer(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
  from: PublicKey,
  to: PublicKey,
  lamports: bigint,
): boolean {
  if (ix.programId.toBase58() !== SYSTEM_PROGRAM_ID) return false;
  if (!('parsed' in ix)) return false;
  if (ix.parsed?.type !== 'transfer') return false;
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

function instructionIsUsdcTransfer(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
  userWallet: PublicKey,
  treasury: PublicKey,
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

  const amt =
    info.tokenAmount
      ? BigInt(info.tokenAmount.amount)
      : info.amount
        ? BigInt(info.amount)
        : -1n;
  if (amt !== amount) return false;

  // Source/destination are ATA addresses, not wallet pubkeys. To strictly
  // verify "the treasury's USDC ATA received this," we'd need to compute
  // the expected ATA and compare. That's in the next helper.
  return ataBelongsTo(info.destination, treasury);
}

// ATA verification — the destination field of a transferChecked is an ATA,
// not the wallet. Confirm the ATA is owned by the treasury wallet.
function ataBelongsTo(ata: string, _owner: PublicKey): boolean {
  // In a fully-wired version, compute getAssociatedTokenAddress(USDC_MINT, _owner)
  // and compare. For the SKILL reference code we delegate that to the caller's
  // cache — the helper below precomputes it.
  return ata === _cachedTreasuryUsdcAta ?? '';
}

// Precompute the treasury's USDC ATA at module load time.
// (In production, import getAssociatedTokenAddress from @solana/spl-token
// and await the result here.)
let _cachedTreasuryUsdcAta: string | null = null;
export async function primeTreasuryAtaCache(): Promise<void> {
  const { getAssociatedTokenAddress } = await import('@solana/spl-token');
  const ata = await getAssociatedTokenAddress(
    new PublicKey(USDC_MINT),
    new PublicKey(process.env.TREASURY_RECEIVER_PUBKEY!),
  );
  _cachedTreasuryUsdcAta = ata.toBase58();
}

// Tiny inline bs58 decoder to avoid import loops for this reference file.
// In production, use the `bs58` package directly.
function bs58Decode(s: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (const c of s) {
    let carry = ALPHABET.indexOf(c);
    if (carry < 0) throw new Error(`invalid bs58 char: ${c}`);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
```

## Before first use

Call `primeTreasuryAtaCache()` once at server boot:

```typescript
import { primeTreasuryAtaCache } from './verify-on-chain.js';

await primeTreasuryAtaCache();
// now verifyInvoiceOnChain is ready
```

## Why 200 sigs?

Solana's default `getSignaturesForAddress` returns up to 1000. We cap at 200 because:

- Invoice TTL defaults to 24h; 200 sigs on a mid-traffic treasury covers ~1–6 hours under real load.
- Free-tier RPCs (Helius, Ankr) rate-limit at ~5 RPS. 200 × getParsedTransactions batched = 1 compute-heavy RPC call.
- If your treasury is hot enough that 200 doesn't cover your shortest invoice window, switch to webhook-driven verification (Helius Enhanced Webhooks) — push model instead of pull.

See `printr-eco` for the Helius webhook pattern if you outgrow this.
