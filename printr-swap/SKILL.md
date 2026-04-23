---
name: printr-swap
description: >
  Use when the user wants to buy or sell a Printr POB token (or any Solana SPL token with a Meteora DBC bonding curve or DAMM v2 pool) via Jupiter routing. Handles both user-signed swaps (wallet adapter) and server-signed swaps (automated buybacks). Auto-detects bonding-curve vs graduated pool state. Standalone primitive — composable inside `printr-agent-payments` + `printr-tokenized-agent`, or usable alone.
metadata:
  author: printr-community
  version: "1.0"
---

## Before Starting Work

**MANDATORY — Do NOT write or modify any code until every item below is answered by the user:**

- [ ] Token mint address (the SPL mint you want to buy or sell)
- [ ] Swap direction confirmed: **buy** (`SOL → mint`) or **sell** (`mint → SOL`)
- [ ] Input amount in the input currency's smallest unit (lamports for SOL, atomic units for the mint)
- [ ] Slippage tolerance in basis points (e.g. `100` = 1%)
- [ ] Signer source: **user-signed** (browser wallet adapter) or **server-signed** (server-held keypair for automation)
- [ ] Solana RPC URL — or a fallback agreed upon

You MUST ask the user for ALL unchecked items in your very first response. Do not assume defaults. Do not proceed until the user has explicitly answered each one.

## Safety Rules

Every rule below is **[pump.fun]** unless marked otherwise — lifted near-verbatim from `pump-fun-skills/tokenized-agents/SKILL.md` and carried through for platform parity.

- **NEVER** log, print, or return private keys or secret key material.
- **NEVER** sign transactions on behalf of a user when the signer is a wallet adapter — you build the transaction, the user signs.
- For **server-signed** swaps, cap per-cycle amount via `BUYBACK_MAX_LAMPORTS` (or equivalent config) before calling `executeSwap`. No exceptions. **[derived]**
- Always validate `amount > 0` and `slippageBps > 0` before calling Jupiter.
- Validate `slippageBps <= 5000` (5%) and warn the caller above `500` (5%) — slippage above 5% on a buyback usually indicates broken liquidity, not acceptable cost. **[derived]**
- Always inspect the quote's `routePlan` before signing: if the route length is 0 or the output mint doesn't match the expected mint, abort. **[derived]**
- Always verify post-swap that the ATA balance increased by at least `quote.outAmount * (1 - slippageBps/10_000)` — if not, the swap filled below tolerance or failed silently. **[pattern]**
- **Always verify your code against this skill before finalizing.** Re-read parameter names, the quote/swap call sequence, and the Jupiter endpoint paths before delivering generated code. **[pump.fun]**

## Supported Pool Types

Printr POB tokens live in exactly one of two pool states. Your swap code needs to handle both without branching on `telecoin_id` — Jupiter abstracts it, but the UX and fee behavior differ:

| Pool type | Ammkey label (Jupiter routePlan) | POB fees active? | Typical characteristics |
| --- | --- | --- | --- |
| **Meteora DBC** (bonding curve) | `"Meteora DBC"` or `"Meteora Dynamic Bonding Curve"` | **No** (pre-graduation — Printr V2 disables custom fees on the curve) | Steeper price impact per unit; curve-formula pricing; no deep liquidity. **[Printr]** |
| **Meteora DAMM v2** (graduated) | `"Meteora DAMM v2"` or `"Meteora DAMM"` | **Yes** (POB fee model applies on every trade) | Regular DEX pool; constant-product-ish; liquidity proportional to what the bonding curve migrated. **[Printr]** |

**Graduation check:** call `quote` and read `routePlan[0].swapInfo.label`. If it contains `"DBC"`, the token is pre-graduation. Only then should you warn the caller "POB fees are not active yet — buybacks during this phase do NOT pay stakers." **[Printr]**

## Environment Variables

Create a `.env` (or `.env.local` for Next.js) with the following:

```env
# Solana RPC — used for all on-chain reads + submitting the swap tx.
# Do NOT use https://api.mainnet-beta.solana.com — it does NOT support
# sendTransaction. Pick one of the free public options below, OR supply
# a paid RPC (Helius, Triton, QuickNode).
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Optional override for Jupiter. Default lite-api is free, rate-limited.
# Paid Jupiter API: https://api.jup.ag (requires API key header).
JUPITER_API_URL=https://lite-api.jup.ag

# Only when using server-signed swaps (automated buybacks).
# base58-encoded ed25519 secret key. Cap treasury balance here per
# custody rules; see printr-tokenized-agent/references/CUSTODY_PATTERNS.md.
TREASURY_HOT_PRIVATE_KEY=<base58-secret-key>
```

**RPC for mainnet-beta:** The default Solana public RPC (`https://api.mainnet-beta.solana.com`) does **not** support sending transactions. You MUST ask the user which RPC endpoint to use. Present these free mainnet-beta options if the user does not have their own: **[pump.fun]**

- **Helius** — `https://mainnet.helius-rpc.com/?api-key=<KEY>` (free tier, requires signup)
- **Solana Tracker** — `https://rpc.solanatracker.io/public`
- **Ankr** — `https://rpc.ankr.com/solana`
- **PublicNode** — `https://solana-rpc.publicnode.com`

Do NOT silently pick one — wait for the user to confirm before proceeding.

Read these values from `process.env` at runtime. Never hard-code mint addresses or RPC URLs.

## Install

```bash
npm install @solana/web3.js@^1.98.0 bs58@^6.0.0
```

No SDK for Jupiter — we call its public HTTP endpoints directly. This keeps the dep footprint small and avoids the dependency-compatibility class of bug that bundle-bound SDKs introduce.

### Dependency Compatibility — IMPORTANT

Jupiter returns a base64-serialized `VersionedTransaction`. Your `@solana/web3.js` major version MUST match whatever the rest of your project uses. Mismatched majors can produce serialization bugs that silently drop instructions. **[pump.fun]**

**Rules:** **[pump.fun]**

1. Before installing `@solana/web3.js`, check what version every other Solana package in your project expects (inspect `package.json` and `package-lock.json`). Pin to a single major (currently `^1.98.0`).
2. Never blindly install "latest". Version 2.x of `@solana/web3.js` is a breaking redesign and incompatible with the code in this skill.
3. `bs58` is required for base58 decoding of server-held keypair secrets. No alternative library.

## Jupiter API — endpoints used

**[pattern]** The whole skill uses only two endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/swap/v1/quote` | Price discovery + route construction |
| `POST` | `/swap/v1/swap` | Returns a signed-ready `VersionedTransaction` |

Full docs: https://station.jup.ag/docs/apis/swap-api

## Detecting Pool State (Pre-graduation vs Graduated)

Call quote, inspect the first route. The check itself is cheap (~50ms) — always do it before a buyback:

```typescript
type PoolState = 'bonding-curve' | 'graduated' | 'unknown';

export async function getPoolState(
  inputMint: string,
  outputMint: string,
  probeAmount: bigint,
): Promise<{ state: PoolState; quote: unknown }> {
  const jupBase = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag';
  const url = `${jupBase}/swap/v1/quote`
    + `?inputMint=${inputMint}`
    + `&outputMint=${outputMint}`
    + `&amount=${probeAmount}`
    + `&slippageBps=100`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }

  const quote = await res.json() as { routePlan?: Array<{ swapInfo: { label: string } }> };
  const plan = quote.routePlan ?? [];
  if (plan.length === 0) return { state: 'unknown', quote };

  const label = plan[0].swapInfo.label;
  if (label.includes('DBC') || label.includes('Dynamic Bonding Curve')) {
    return { state: 'bonding-curve', quote };
  }
  if (label.includes('DAMM')) {
    return { state: 'graduated', quote };
  }
  return { state: 'unknown', quote };
}
```

## Core flow — quote and swap

### Step 1: Quote

```typescript
export type QuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: bigint;          // smallest unit of inputMint
  slippageBps: number;
};

export type JupiterQuote = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string };
    percent: number;
  }>;
};

export async function quoteSwap(params: QuoteParams): Promise<JupiterQuote> {
  if (params.amount <= 0n) throw new Error('amount must be > 0');
  if (params.slippageBps <= 0) throw new Error('slippageBps must be > 0');
  if (params.slippageBps > 5000) throw new Error('slippageBps must be <= 5000 (5%)');

  const jupBase = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag';
  const url = `${jupBase}/swap/v1/quote`
    + `?inputMint=${params.inputMint}`
    + `&outputMint=${params.outputMint}`
    + `&amount=${params.amount}`
    + `&slippageBps=${params.slippageBps}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }
  const quote = await res.json() as JupiterQuote;

  if (!quote.routePlan || quote.routePlan.length === 0) {
    throw new Error(`No route available for ${params.inputMint} -> ${params.outputMint}`);
  }
  if (quote.outputMint !== params.outputMint) {
    throw new Error(`Jupiter returned wrong output mint: expected ${params.outputMint}, got ${quote.outputMint}`);
  }
  return quote;
}
```

### Step 2: Build swap transaction (server side)

Jupiter's `/swap/v1/swap` endpoint takes the quote and the signer's public key, and returns a **base64-encoded serialized VersionedTransaction**. No BYO instructions.

```typescript
import { Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';

export type BuildSwapParams = {
  quote: JupiterQuote;
  userPublicKey: PublicKey;
  wrapAndUnwrapSol?: boolean;       // default true — auto-handles wSOL
  priorityFee?:                     // default 'auto' — Jupiter picks based on congestion
    | 'auto'
    | { maxLamports: number; level: 'low' | 'medium' | 'high' | 'veryHigh' };
};

export async function buildSwapTransaction(
  params: BuildSwapParams,
): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
  const jupBase = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag';
  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey.toBase58(),
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    prioritizationFeeLamports:
      !params.priorityFee || params.priorityFee === 'auto'
        ? 'auto'
        : {
            priorityLevelWithMaxLamports: {
              maxLamports: params.priorityFee.maxLamports,
              priorityLevel: params.priorityFee.level,
            },
          },
  };

  const res = await fetch(`${jupBase}/swap/v1/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);
  }
  const { swapTransaction, lastValidBlockHeight } = await res.json() as {
    swapTransaction: string;
    lastValidBlockHeight: number;
  };

  const buf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(buf);
  return { tx, lastValidBlockHeight };
}
```

### Step 3a: User-signed swap (browser / wallet adapter)

```typescript
// Client (browser) — uses @solana/wallet-adapter-react
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';

export async function executeUserSwap(
  txBase64: string,
  lastValidBlockHeight: number,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  connection: import('@solana/web3.js').Connection,
): Promise<string> {
  if (!signTransaction) throw new Error('Wallet does not support signing');
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
    preflightCommitment: 'confirmed',
  });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}
```

See `references/WALLET_INTEGRATION.md` from `pump-fun-skills/tokenized-agents` (identical, platform-agnostic) for WalletProvider setup.

### Step 3b: Server-signed swap (automated buyback)

Used by `printr-tokenized-agent` for hourly cycles. Signer is a server-held keypair loaded from `TREASURY_HOT_PRIVATE_KEY`.

```typescript
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';

export function loadHotKeypair(): Keypair {
  const secret = process.env.TREASURY_HOT_PRIVATE_KEY;
  if (!secret) throw new Error('TREASURY_HOT_PRIVATE_KEY not set');
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64) {
    throw new Error(`expected 64-byte secret, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}

export async function executeServerSwap(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  keypair: Keypair,
): Promise<string> {
  tx.sign([keypair]);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 2,
    preflightCommitment: 'confirmed',
  });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`swap failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}
```

### Step 4: Post-swap verification

Never trust the confirmation alone — verify the ATA balance actually moved. The tx can confirm without delivering the expected output if the route partially fills or routes through a broken AMM. **[pattern]**

```typescript
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';

export async function verifySwapOutput(
  connection: Connection,
  outputMint: PublicKey,
  owner: PublicKey,
  minOutAmount: bigint,
): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(outputMint, owner);
  const account = await getAccount(connection, ata, 'confirmed');
  if (account.amount < minOutAmount) {
    throw new Error(
      `swap output below minimum: got ${account.amount}, expected >= ${minOutAmount}`,
    );
  }
  return account.amount;
}
```

For buybacks in `printr-tokenized-agent`, `minOutAmount = BigInt(quote.otherAmountThreshold)` — Jupiter's computed worst-case fill.

## End-to-End Flow

```
1. Caller decides direction (buy/sell) + amount + slippage.
2. quoteSwap({...}) → JupiterQuote with routePlan.
3. (optional) Inspect routePlan[0].swapInfo.label → warn if 'bonding-curve'.
4. buildSwapTransaction({quote, userPublicKey}) → VersionedTransaction + lastValidBlockHeight.
5a. User-signed path: client signs → sendRawTransaction → confirmTransaction.
5b. Server-signed path: executeServerSwap(tx, keypair) → same.
6. verifySwapOutput(mint, owner, minOutAmount) → confirm ATA received ≥ threshold.
7. Caller uses `amount - fees = minOutAmount` for downstream logic (e.g. burn).
```

## Scenario Tests & Troubleshooting

See `references/SCENARIOS.md` for the four canonical tests (graduated quote, bonding-curve warning, server-signed buyback, route-unavailable) and a troubleshooting table for common errors.

## Composes With

- **`printr-agent-payments`** — accept user SOL/USDC for paid actions (independent primitive, does not depend on this skill).
- **`printr-tokenized-agent`** — composes this skill with `printr-agent-payments` + SPL burn + scheduled cron. Imports `loadHotKeypair`, `quoteSwap`, `buildSwapTransaction`, `executeServerSwap`, `verifySwapOutput` from the code generated by this skill.

## When NOT to use

- **Tokens not routable by Jupiter.** If `quoteSwap` returns empty `routePlan`, the token has no graduated pool or Jupiter hasn't indexed its curve yet. Wait for graduation or use a DEX-specific SDK.
- **Anything where the user cannot confirm slippage.** Buybacks above 5% slippage usually mean the pool is too thin for the cycle size — cap `BUYBACK_MAX_LAMPORTS` lower instead of raising slippage tolerance.
- **On-chain-program-controlled swaps.** This skill uses HTTP Jupiter, which requires a wallet signer. If your swap must originate from a PDA-controlled authority, use Jupiter's CPI integration or the Meteora program directly — out of scope here.
