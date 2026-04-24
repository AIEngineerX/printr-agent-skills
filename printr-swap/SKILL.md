---
name: printr-swap
description: >
  Use when the user wants to buy or sell a Printr POB token (or any Solana SPL token with a Meteora DBC bonding curve or DAMM v2 pool) via Jupiter routing. Handles both user-signed swaps (wallet adapter) and server-signed swaps (automated buybacks). Auto-detects bonding-curve vs graduated pool state. Standalone primitive — composable inside `printr-agent-payments` + `printr-tokenized-agent`, or usable alone.
metadata:
  author: printr-community
  version: '1.0'
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

- **NEVER** log, print, or return private keys or secret key material. **[pattern]**
- **NEVER** sign transactions on behalf of a user when the signer is a wallet adapter — you build the transaction, the user signs. **[pattern]**
- For **server-signed** swaps, cap per-cycle amount via `BUYBACK_MAX_LAMPORTS` (or equivalent config) before calling `executeSwap`. No exceptions. **[derived]**
- Always validate `amount > 0` and `slippageBps > 0` before calling Jupiter. **[pattern]**
- Validate `slippageBps <= 5000` (5%) and warn the caller above `500` (5%) — slippage above 5% on a buyback usually indicates broken liquidity, not acceptable cost. **[derived]**
- Always inspect the quote's `routePlan` before signing: if the route length is 0 or the output mint doesn't match the expected mint, abort. **[derived]**
- Always verify post-swap that the ATA balance increased by at least `quote.outAmount * (1 - slippageBps/10_000)` — if not, the swap filled below tolerance or failed silently. **[pattern]**
- **Always verify your code against this skill before finalizing.** Re-read parameter names, the quote/swap call sequence, and the Jupiter endpoint paths before delivering generated code. **[derived]**

## Supported Pool Types

Printr POB tokens live in exactly one of two pool states. Your swap code needs to handle both without branching on `telecoin_id` — Jupiter abstracts it, but the UX and fee behavior differ:

| Pool type                       | Ammkey label (Jupiter routePlan)                     | POB fees active?                                                      | Typical characteristics                                                                                         |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Meteora DBC** (bonding curve) | `"Meteora DBC"` or `"Meteora Dynamic Bonding Curve"` | **No** (pre-graduation — Printr V2 disables custom fees on the curve) | Steeper price impact per unit; curve-formula pricing; no deep liquidity. **[Printr]**                           |
| **Meteora DAMM v2** (graduated) | `"Meteora DAMM v2"` or `"Meteora DAMM"`              | **Yes** (POB fee model applies on every trade)                        | Regular DEX pool; constant-product-ish; liquidity proportional to what the bonding curve migrated. **[Printr]** |

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

**RPC for mainnet-beta:** The default Solana public RPC (`https://api.mainnet-beta.solana.com`) does **not** support sending transactions. You MUST ask the user which RPC endpoint to use. Present these free mainnet-beta options if the user does not have their own **[pattern]**:

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

Jupiter returns a base64-serialized `VersionedTransaction`. Your `@solana/web3.js` major version MUST match whatever the rest of your project uses. Mismatched majors can produce serialization bugs that silently drop instructions. **[pattern]**

**Rules** **[pattern]**:

1. Before installing `@solana/web3.js`, check what version every other Solana package in your project expects (inspect `package.json` and `package-lock.json`). Pin to a single major (currently `^1.98.0`).
2. Never blindly install "latest". Version 2.x of `@solana/web3.js` is a breaking redesign and incompatible with the code in this skill.
3. `bs58` is required for base58 decoding of server-held keypair secrets. No alternative library.

## Jupiter API — endpoints used

**[pattern]** The whole skill uses only two endpoints:

| Method | Path             | Purpose                                       |
| ------ | ---------------- | --------------------------------------------- |
| `GET`  | `/swap/v1/quote` | Price discovery + route construction          |
| `POST` | `/swap/v1/swap`  | Returns a signed-ready `VersionedTransaction` |

Full docs: https://station.jup.ag/docs/apis/swap-api

## Shared module constants & helper

All three Jupiter-calling functions below share these. Include once at the top of your module when copying the code:

```typescript
const JUPITER_BASE = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag';
const JUPITER_TIMEOUT_MS = 10_000;

async function jupiterFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${JUPITER_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Jupiter ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}
```

## Detecting Pool State (Pre-graduation vs Graduated)

Call quote, inspect the first route. The check itself is cheap (~50–150ms) — always do it before a buyback. Callers MUST handle `'unknown'` explicitly — do not treat it as "safe to proceed". An unknown label means Jupiter found a route but we couldn't classify the venue; the safest action is to abort and investigate, or tighten `slippageBps` and retry.

```typescript
type PoolState = 'bonding-curve' | 'graduated' | 'unknown';

export async function getPoolState(
  inputMint: string,
  outputMint: string,
  probeAmount: bigint,
): Promise<{ state: PoolState; quote: unknown }> {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(probeAmount),
    slippageBps: '100',
  });
  const res = await jupiterFetch(`/swap/v1/quote?${qs}`);
  const quote = (await res.json()) as { routePlan?: Array<{ swapInfo: { label: string } }> };

  const label = quote.routePlan?.[0]?.swapInfo.label ?? '';
  if (label.includes('DBC') || label.includes('Dynamic Bonding Curve')) {
    return { state: 'bonding-curve', quote };
  }
  if (label.includes('DAMM')) return { state: 'graduated', quote };
  return { state: 'unknown', quote }; // caller MUST handle this; don't proceed on unknown
}
```

## Core flow — quote and swap

### Step 1: Quote

```typescript
export type QuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: bigint; // smallest unit of inputMint
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

  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: String(params.slippageBps),
  });
  const res = await jupiterFetch(`/swap/v1/quote?${qs}`);
  const quote = (await res.json()) as JupiterQuote;

  if (!quote.routePlan?.length) {
    throw new Error(`No route available for ${params.inputMint} -> ${params.outputMint}`);
  }
  if (quote.outputMint !== params.outputMint) {
    throw new Error(
      `Jupiter returned wrong output mint: expected ${params.outputMint}, got ${quote.outputMint}`,
    );
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
  wrapAndUnwrapSol?: boolean; // default true — auto-handles wSOL
  priorityFee?: // default 'auto' — Jupiter picks based on congestion
    'auto' | { maxLamports: number; level: 'low' | 'medium' | 'high' | 'veryHigh' };
};

export async function buildSwapTransaction(
  params: BuildSwapParams,
): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
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

  const res = await jupiterFetch('/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { swapTransaction, lastValidBlockHeight } = (await res.json()) as {
    swapTransaction: string;
    lastValidBlockHeight: number;
  };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
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
  // Use the blockhash already embedded in the Jupiter-built tx — do not
  // fetch a fresh one. confirmTransaction must track the same blockhash
  // the tx was signed against, otherwise the confirmation window doesn't
  // line up with the actual tx's expiry.
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  );
  return sig;
}
```

See [`printr-agent-payments/references/WALLET_INTEGRATION.md`](../printr-agent-payments/references/WALLET_INTEGRATION.md) for the full WalletProvider setup (platform-agnostic — same wallet-adapter stack applies to user-signed swaps).

### Step 3b: Server-signed swap (automated buyback)

Used by `printr-tokenized-agent` for hourly cycles. Signer is a server-held keypair loaded from `TREASURY_HOT_PRIVATE_KEY`.

```typescript
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
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
  // Use the blockhash from the tx itself (set by Jupiter at build time).
  const conf = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`swap failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}
```

### Step 3c: Simulated swap (dry-run)

Used by `printr-tokenized-agent`'s `BUYBACK_DRY_RUN` mode. Runs the full swap tx through Solana's `simulateTransaction` RPC without submission — no SOL spent, no signature required, inner instructions exposed.

```typescript
import {
  Connection,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';

export interface SimulateSwapResult {
  /** True when simulation completed without a program error. */
  ok: boolean;
  /** Program-level error if the simulated tx would have failed. */
  err: unknown;
  /** Per-instruction logs. Useful for inspecting which programs were
   *  invoked and which CPIs they emitted. */
  logs: readonly string[];
  /** Compute units the simulated tx would have consumed. Useful for tuning
   *  `setComputeUnitLimit` in production. */
  computeUnitsConsumed: number | null;
  /** Inner instructions returned by the RPC when
   *  `simulateTransaction({ innerInstructions: true })`. Parsed when the RPC
   *  supports jsonParsed for simulation output (Helius does; Ankr/PublicNode
   *  may return base58 only). */
  innerInstructions: SimulatedTransactionResponse['innerInstructions'];
  /** Count of Token Program transfer/transferChecked ixs across inner
   *  instruction groups. Covers both classic SPL-Token (`Tokenkeg...`) and
   *  Token-2022 (`TokenzQdB...`) — many Printr POB tokens use Token-2022.
   *  Useful as a sanity check that the swap routed at all. NOT a proxy for
   *  POB fee-hook detection: POB model-1 fees accrue via Meteora's standard
   *  LP accounting and are distributed asynchronously by Printr's SVM
   *  program — there is no per-swap transfer to detect. Null when the RPC
   *  didn't return inner instructions in parsed form. **[Printr]** */
  tokenTransferCount: number | null;
}

export async function simulateSwap(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<SimulateSwapResult> {
  // `sigVerify: false` skips signature check (we don't sign in dry-run).
  // `replaceRecentBlockhash: true` avoids stale-blockhash failures — the
  // Jupiter-built tx carries a real blockhash but simulation may lag.
  // `innerInstructions: true` returns the nested CPI tree.
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
        if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) continue;
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
```

**What this does NOT do.** Do not use simulated inner instructions to try to detect POB fee-hook activity. On Printr POB model-1, fee distribution is **async**: trading accrues LP fees in the Meteora DAMM v2 pool via standard LP-fee accounting, and Printr's SVM program (`T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint`) distributes them to stakers on its own schedule. The swap's on-chain shape is indistinguishable from a plain Meteora DAMM v2 swap. To verify POB distribution is live for a given telecoin, query Printr's API via `scripts/verify-printr-mechanism.ts` in the parent kit. **[Printr]**

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
