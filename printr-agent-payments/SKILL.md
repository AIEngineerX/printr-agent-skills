---
name: printr-agent-payments
description: >
  Use when building a Solana paywall — charging users for agent actions with on-chain memo-match invoice verification. Generates cryptographically-random memos, builds SOL or USDC transfer transactions for client signing, and verifies payments on-chain by scanning the treasury wallet's signature history. Platform-agnostic — works for any Solana SPL mint and any Solana wallet adapter. Pairs with `printr-swap` and `printr-tokenized-agent` for a full agent-revenue + buyback-and-burn loop on Printr POB tokens.
metadata:
  author: printr-community
  version: '1.0'
---

## Maturity status

**Unproven in production.** 96 unit tests cover invoice creation, memo generation, on-chain verification matchers (SOL + USDC), and replay-protection edges. Coverage is real but no production adopter has yet run a full user-payment → server-verify → paid-action-delivery flow in the wild. The first live adopter of the tokenized-agent loop (see `README.md` §Production track record) deliberately did not ship paid agent actions as part of its initial surface, so this skill has not yet been exercised end-to-end by any known production deployment. If you're the first, please open an issue with results.

## Before Starting Work

**MANDATORY — Do NOT write or modify any code until every item below is answered by the user:**

- [ ] Treasury receiver public key (base58 Solana pubkey — the address that collects user payments)
- [ ] Payment currency decided: **SOL** or **USDC** (the skill supports both; phase-2 can add USDT/USD1)
- [ ] Price / amount confirmed in smallest unit (lamports for SOL; 6-decimal atomic units for USDC)
- [ ] Invoice store backend: **Neon/Postgres** (production) or **in-memory Map** (development only — never use in production)
- [ ] Session correlator decided: the unique ID your app uses to associate an invoice with a user session (your own app's session_id, wallet pubkey, or a random UUID issued per paid action)
- [ ] Framework confirmed: **Next.js**, **SvelteKit**, **Express**, other
- [ ] Solana RPC URL — or a fallback agreed upon

You MUST ask the user for ALL unchecked items in your very first response. Do not assume defaults. Do not proceed until the user has explicitly answered each one.

## Safety Rules

Rules 1–6 are standard Solana / payment-skill practice **[pattern]**. Rule 7 is the meta-rule that prevents spec-drift during generation **[derived]**. Rule 8 is specific to this kit — without an on-chain PDA enforcing invoice uniqueness, we enforce it at the DB layer **[derived]**.

1. **NEVER** log, print, or return private keys or secret key material.
2. **NEVER** sign transactions on behalf of a user — you build the instruction, the user signs.
3. Always validate that `amount > 0` before creating an invoice.
4. Always ensure `endTime > startTime` and both are valid Unix timestamps.
5. Use the correct decimal precision for the currency (6 decimals for USDC, 9 for SOL).
6. **Always verify payments on the server** using `verifyInvoiceOnChain` before delivering any service. Never trust the client alone — clients can be spoofed.
7. **Always verify your code against this skill before finalizing.** Before delivering generated code, re-read the relevant sections of this document and confirm parameter names, types, order, and defaults match exactly.
8. **The memo column in your invoice table MUST have a UNIQUE constraint.** Without it, a collision in the cryptographic-random memo generator would allow an attacker to pay the lowest-priced invoice and redeem the highest.

## Supported Currencies

| Currency    | Decimals | Smallest unit example | Mint address                                   |
| ----------- | -------- | --------------------- | ---------------------------------------------- |
| USDC        | 6        | `1000000` = 1 USDC    | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Wrapped SOL | 9        | `1000000000` = 1 SOL  | `So11111111111111111111111111111111111111112`  |

**SOL vs Wrapped SOL:** The skill builds _native SOL_ transfers via `SystemProgram.transfer` when `CURRENCY_MINT = wSOL`. No wrapping is needed — we take lamports directly. The `wSOL` mint is recorded in the invoice as a consistent currency identifier (so the invoice schema stays uniform across SOL and SPL currencies). **[derived]**

## Environment Variables

Create a `.env` (or `.env.local` for Next.js) with the following:

```env
# Solana RPC — server-side (used to build transactions, fetch blockhash, verify payments)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Solana RPC — client-side (used by wallet adapter in the browser)
NEXT_PUBLIC_SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Treasury wallet that receives user payments.
# This is a PUBLIC key. The private key is NOT needed here — payments flow
# INTO this address; you only spend from it in printr-tokenized-agent
# buyback cycles, where a different env var (TREASURY_HOT_PRIVATE_KEY)
# handles the hot-wallet portion.
TREASURY_RECEIVER_PUBKEY=<base58-pubkey>

# Payment currency mint.
# USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
# SOL (wrapped SPL mint): So11111111111111111111111111111111111111112
CURRENCY_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Database — Neon or any Postgres.
DATABASE_URL=postgres://user:pass@host/db

# (optional) Invoice validity window in seconds. Default: 86400 (24h).
INVOICE_TTL_SECONDS=86400
```

**RPC for mainnet-beta:** The default Solana public RPC (`https://api.mainnet-beta.solana.com`) does **not** support sending transactions. You MUST ask the user which RPC endpoint to use. Present these free mainnet-beta options if the user does not have their own **[pattern]**:

- **Helius** — `https://mainnet.helius-rpc.com/?api-key=<KEY>`
- **Solana Tracker** — `https://rpc.solanatracker.io/public`
- **Ankr** — `https://rpc.ankr.com/solana`
- **PublicNode** — `https://solana-rpc.publicnode.com`

Do NOT silently pick one — wait for the user to confirm before proceeding.

Read these values from `process.env` at runtime. Never hard-code mint addresses or RPC URLs.

## Install

```bash
npm install @solana/web3.js@^1.98.0 @solana/spl-token@^0.4.0 @solana/spl-memo@^0.1.0 bs58@^6.0.0
```

### Dependency Compatibility — IMPORTANT

`@solana/web3.js` + `@solana/spl-token` + `@solana/spl-memo` + `@solana/wallet-adapter-*` must all be on compatible majors. Mismatched versions produce silent serialization bugs. **[pattern]**

**Rules** **[pattern]**:

1. Pin `@solana/web3.js` at a single major across the whole app (currently `^1.98.0`; do NOT mix with `2.x`).
2. Never blindly install "latest". Check peer-dep ranges in `@solana/spl-token` and the wallet-adapter packages first.
3. If the project already has these at different versions, align before adding the payment flow.

## Database Schema

You need one table. The UNIQUE constraint on `memo` is load-bearing per safety rule 8. **[derived]**

```sql
CREATE TABLE payment_invoice (
  memo                    BIGINT        PRIMARY KEY,        -- load-bearing UNIQUE
  session_id              TEXT          NOT NULL,           -- your app's correlator
  user_wallet             TEXT          NOT NULL,           -- base58 payer pubkey
  currency_mint           TEXT          NOT NULL,           -- SOL or USDC mint
  amount_smallest_unit    BIGINT        NOT NULL,
  start_time              BIGINT        NOT NULL,
  end_time                BIGINT        NOT NULL,
  status                  TEXT          NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending','paid','expired','cancelled')),
  tx_sig                  TEXT,                             -- filled on verification
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  paid_at                 TIMESTAMPTZ,
  purpose                 TEXT                              -- e.g. 'deep_analysis', 'export'
);

CREATE INDEX payment_invoice_session_idx ON payment_invoice (session_id, created_at DESC);
CREATE INDEX payment_invoice_pending_idx ON payment_invoice (status) WHERE status = 'pending';
CREATE INDEX payment_invoice_wallet_idx  ON payment_invoice (user_wallet, created_at DESC);
```

For dev-only in-memory mode, the equivalent is a `Map<bigint, Invoice>` guarded with explicit duplicate-memo checks on insert. **The in-memory mode MUST NOT be used in production** — a serverless restart clears the map and allows replay.

## SDK Setup — There Is No SDK

This kit hand-rolls every piece. No external SDK is required. The building blocks: **[derived]**

- `SystemProgram.transfer` — for SOL payments
- `createTransferCheckedInstruction` from `@solana/spl-token` — for USDC payments
- `createMemoInstruction` from `@solana/spl-memo` — for the invoice memo that binds a payment to an invoice row

**Memo program ID** (hard-coded constant in SPL): `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`. **[pattern]**

## Types

```typescript
export type Currency = 'SOL' | 'USDC';

export type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface Invoice {
  memo: bigint;
  session_id: string;
  user_wallet: string;
  currency_mint: string;
  amount_smallest_unit: bigint;
  start_time: number;
  end_time: number;
  status: InvoiceStatus;
  tx_sig: string | null;
  created_at: Date;
  paid_at: Date | null;
  purpose: string | null;
}

export interface CreateInvoiceParams {
  session_id: string;
  user_wallet: string;
  currency: Currency;
  price_smallest_unit: bigint;
  purpose?: string;
  durationSeconds?: number; // default 86400
}

export interface CreateInvoiceResult {
  transaction: string; // base64-encoded unsigned Transaction
  invoice: {
    memo: string; // stringified bigint (JSON-safe)
    user_wallet: string;
    currency_mint: string;
    amount_smallest_unit: string;
    start_time: number;
    end_time: number;
  };
}
```

## Full Transaction Flow — Server to Client

### Step 1: Generate invoice params (server)

```typescript
import crypto from 'node:crypto';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SUPPORTED_MINTS = { SOL: SOL_MINT, USDC: USDC_MINT } as const;

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
  // Validate currency against the supported whitelist. Silent fallback
  // to USDC on an unknown currency would be catastrophic — reject loudly.
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

  // Cryptographically random 63-bit memo. Top bit masked off so the
  // value fits a signed BIGINT column and stringifies compactly.
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
```

### Step 2: Build payment transaction (server)

```typescript
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createMemoInstruction } from '@solana/spl-memo';

// Per-currency decimals. Wrong decimals = amounts mis-scaled by orders
// of magnitude, which is catastrophic on the SPL path.
const DECIMALS: Record<Currency, number> = { SOL: 9, USDC: 6 };

function mintToCurrency(mint: string): Currency | null {
  if (mint === SOL_MINT) return 'SOL';
  if (mint === USDC_MINT) return 'USDC';
  return null;
}

export async function buildPaymentTransaction(
  connection: Connection, // injected — makes this testable against a mock RPC
  params: {
    userWallet: string;
    treasuryReceiver: string;
    memo: bigint;
    currency_mint: string;
    amount_smallest_unit: bigint;
    priorityFeeMicroLamports?: number;
  },
): Promise<string> {
  // Validate the mint against the whitelist — an unknown mint on the SPL
  // path would use the wrong decimals and silently mis-scale the transfer.
  const currency = mintToCurrency(params.currency_mint);
  if (!currency) {
    throw new Error(
      `unsupported currency_mint ${params.currency_mint} — must be one of ${SOL_MINT} (SOL) or ${USDC_MINT} (USDC)`,
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

  // Payment instruction — SOL or SPL. web3.js ^1.98 accepts bigint directly
  // for both lamports and SPL amounts, so no manual conversion below.
  if (currency === 'SOL') {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: treasury,
        lamports: params.amount_smallest_unit,
      }),
    );
  } else {
    // USDC. Caller is responsible for ensuring the treasury's USDC ATA
    // exists — prepend createAssociatedTokenAccountIdempotentInstruction
    // if not already guaranteed.
    const currencyMint = new PublicKey(params.currency_mint);
    const sourceAta = await getAssociatedTokenAddress(currencyMint, user);
    const destAta = await getAssociatedTokenAddress(currencyMint, treasury);
    tx.add(
      createTransferCheckedInstruction(
        sourceAta,
        currencyMint,
        destAta,
        user,
        params.amount_smallest_unit,
        DECIMALS[currency], // looked up — no hard-coded decimals
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = user;

  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
```

### Step 3: Create-invoice route (server)

Combines generate + build + DB insert. **This is the canonical endpoint handler — copy this shape.** **[pattern]**

```typescript
import { Pool } from '@neondatabase/serverless'; // or pg, or any Postgres client

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

export async function createInvoice(req: CreateInvoiceParams): Promise<CreateInvoiceResult> {
  const { memo, currency_mint, amount_smallest_unit, start_time, end_time } = generateInvoiceParams(
    {
      currency: req.currency,
      price_smallest_unit: req.price_smallest_unit,
      durationSeconds: req.durationSeconds,
    },
  );

  const connection = new Connection(process.env.SOLANA_RPC_URL!);
  const txBase64 = await buildPaymentTransaction(connection, {
    userWallet: req.user_wallet,
    treasuryReceiver: process.env.TREASURY_RECEIVER_PUBKEY!,
    memo,
    currency_mint,
    amount_smallest_unit,
  });

  // UNIQUE constraint on memo enforces replay safety.
  // If the tiny chance of a collision occurs, the insert throws and the
  // caller retries with a fresh memo. Do NOT silently ignore a duplicate.
  await pool.query(
    `INSERT INTO payment_invoice
      (memo, session_id, user_wallet, currency_mint, amount_smallest_unit,
       start_time, end_time, status, purpose)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
    [
      memo.toString(),
      req.session_id,
      req.user_wallet,
      currency_mint,
      amount_smallest_unit.toString(),
      start_time,
      end_time,
      req.purpose ?? null,
    ],
  );

  return {
    transaction: txBase64,
    invoice: {
      memo: memo.toString(),
      user_wallet: req.user_wallet,
      currency_mint,
      amount_smallest_unit: amount_smallest_unit.toString(),
      start_time,
      end_time,
    },
  };
}
```

### Step 4: Client signs and submits

Standard Solana wallet-adapter submission — platform-agnostic:

```typescript
// Client (browser)
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';

export async function signAndSendPayment(
  txBase64: string,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  connection: import('@solana/web3.js').Connection,
): Promise<string> {
  if (!signTransaction) throw new Error('Wallet does not support signing');

  const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}
```

See `references/WALLET_INTEGRATION.md` for the full WalletProvider + `PaymentButton` setup.

### Step 5: Verify invoice on-chain (server)

The verifier scans the treasury wallet's recent signatures, parses each candidate tx, and matches:

1. Memo-program instruction with exact memo string.
2. Payment instruction (SystemProgram.transfer for SOL, or spl-token transferChecked for USDC) from user → treasury with exact amount.
3. Tx timestamp within invoice's `start_time .. end_time`.

Full implementation in `references/VERIFY_ON_CHAIN.md`. The exported function signature is:

```typescript
export async function verifyInvoiceOnChain(opts: {
  memo: bigint;
}): Promise<
  | { paid: true; tx_sig: string; blockTime: number }
  | { paid: false; reason: 'not_found' | 'expired' | 'already_marked_paid' }
>;
```

### Step 6: Verification with retries

Transactions take a few seconds to propagate to the RPC's signature index. Use a retry loop (10 attempts × 2s) **[pattern]**:

```typescript
export async function verifyInvoiceWithRetries(memo: bigint): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await verifyInvoiceOnChain({ memo });
    if (result.paid) {
      // Mark paid in DB. UPDATE-then-return-affected-rows pattern prevents
      // double-delivery if two requests race to verify the same invoice.
      const { rowCount } = await pool.query(
        `UPDATE payment_invoice
           SET status = 'paid', tx_sig = $1, paid_at = now()
         WHERE memo = $2 AND status = 'pending'`,
        [result.tx_sig, memo.toString()],
      );
      return rowCount === 1;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
```

## End-to-End Flow

```
1. Client POSTs to /api/pay/invoice with { session_id, user_wallet, currency, price, purpose }.
2. Server:
   - generateInvoiceParams → { memo, start_time, end_time, amount, currency_mint }
   - buildPaymentTransaction → base64 unsigned Transaction
   - INSERT into payment_invoice (status='pending')
   - return { transaction, invoice }
3. Client:
   - Transaction.from(Buffer.from(txBase64, 'base64'))
   - signTransaction(tx)  ← wallet prompts user
   - sendRawTransaction(signed.serialize())
   - confirmTransaction(...)
4. Client POSTs to /api/pay/verify with { memo }.
5. Server:
   - verifyInvoiceWithRetries(memo)
   - On true: status='paid', tx_sig recorded. Return paid.
   - On false (after 10 * 2s): return unpaid.
6. Downstream: the paid-action handler checks payment_invoice.status before delivering.
```

## Scenario Tests & Troubleshooting

See `references/SCENARIOS.md` for the five canonical tests (happy path, verify-before-payment, duplicate rejection, mismatched params, expired invoice) and the troubleshooting table.

## Composes With

- **`printr-swap`** — independent primitive. No overlap; use both when building a full tokenized-agent loop.
- **`printr-tokenized-agent`** — top-level composition that wires `printr-agent-payments` (revenue in) + `printr-swap` (buyback) + SPL burn + scheduled cron.

## When NOT to use

- **Apps that cannot commit to a persistent invoice store in production.** In-memory mode is dev-only; serverless restarts erase it and allow replay attacks.
- **Apps that only need user login without payment.** This skill is payment-gated access. If all you need is wallet auth, use an Ed25519 signature challenge instead — simpler, no on-chain txs required.
- **Cross-chain payments.** This skill is Solana-only. For EVM equivalents, build your own using Permit2 + block-scanning. Out of scope.
