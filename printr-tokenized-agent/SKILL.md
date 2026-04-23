---
name: printr-tokenized-agent
description: >
  Build a tokenized-agent loop on a Printr POB token. Composes `printr-agent-payments` (accept user SOL/USDC) with `printr-swap` (Jupiter buyback) and adds SPL burn plus a scheduled buyback cycle. Mirrors pump.fun's Tokenized Agents mechanic but hand-rolls everything (the @pump-fun/agent-payments-sdk only works on pump.fun tokens) and runs the buyback+burn under the creator's own treasury. Adds "double-effect" over pump.fun's model: on POB-model-1 tokens, the buyback trade itself pays the staking pool on its way to the burn. Triggers on "Printr tokenized agent", "agent revenue burn", "buyback and burn for a Printr POB token", "first tokenized agent on Printr", or composing the `printr-swap` + `printr-agent-payments` skills into one loop. Does NOT trigger for pump.fun-launched tokens.
metadata:
  author: printr-community
  version: "1.0"
---

## Before Starting Work

**MANDATORY — Do NOT write or modify any code until every item below is answered by the user:**

This skill composes two sub-skills. You MUST gather prerequisites for both, plus the composition-specific ones.

### From `printr-agent-payments` pre-work

- [ ] Treasury receiver public key (base58)
- [ ] Payment currency (**SOL** or **USDC**)
- [ ] Price / amount per paid action (smallest unit)
- [ ] Invoice store backend (Neon/Postgres in prod; in-memory dev-only)
- [ ] Session correlator (your app's session_id or equivalent)
- [ ] Framework (Next.js, SvelteKit, Express, …)

### From `printr-swap` pre-work

- [ ] Agent token mint (the POB token to buy back)
- [ ] Agent token `telecoin_id` (0x… from Printr's V1 API) — optional, only if you display pool stats
- [ ] Signer source for swaps: **server-signed** is the only valid answer for automated buybacks
- [ ] Slippage tolerance in bps (recommend 100 = 1%)

### Composition-specific pre-work

- [ ] Burn policy: **100% burn** / **split** (e.g. 80% burn + 20% treasury stake) — ship 100% first, revisit
- [ ] Buyback threshold in lamports (recommend `100_000_000` = 0.1 SOL)
- [ ] Buyback max per cycle in lamports (recommend `1_000_000_000` = 1 SOL, or 50% of typical hot-wallet balance — whichever is lower)
- [ ] Cadence (default `0 * * * *` = hourly) — confirm your scheduler supports cron
- [ ] Treasury custody tier — **Pattern 1, 2, 3, or 4** from `references/CUSTODY_PATTERNS.md`
- [ ] Solana RPC URL (production-grade recommended — Helius paid tier or equivalent)

You MUST ask the user for ALL unchecked items in your very first response. Do not assume defaults. Do not proceed until the user has explicitly answered each one.

## Safety Rules

Rules 1–7 are **[pump.fun]** lifted from the tokenized-agents skill and apply to the payment side. Rules 8–12 are composition-specific. Rule 13 is your own Neo Trader learning, and is **[derived]** — the single most expensive lesson in this ecosystem.

1. **NEVER** log, print, or return private keys or secret key material.
2. **NEVER** sign transactions on behalf of a user when the signer is a wallet adapter.
3. Always validate `amount > 0` before creating an invoice.
4. Always ensure `endTime > startTime` and both are valid Unix timestamps.
5. Use correct decimal precision for the currency (6 USDC, 9 SOL).
6. **Always verify payments on the server** using `verifyInvoiceOnChain` before delivering any service.
7. **Always verify your code against this skill before finalizing** — check parameter names, types, ordering, defaults, and import paths.
8. **Memo column MUST have a UNIQUE constraint.** No DB enforcement = replay attack window. **[derived]**
9. **Hot wallet balance MUST be capped.** Enforce `BUYBACK_MAX_LAMPORTS` before every swap; skip cycle if hot balance exceeds cap without first sweeping overflow to cold. **[derived]**
10. **Verify swap output before burning.** A swap that confirms on-chain may still have filled below expected due to slippage. Burn only the amount actually present in the ATA, not the quoted amount. **[pattern]**
11. **Burn idempotency.** Record the swap signature in the DB BEFORE executing the burn. If the burn fails after the swap succeeds, the next cycle detects a non-zero agent-token balance in the hot wallet and retries the burn only (does not re-swap).
12. **Never hot-wire the cold key.** The cold wallet's private key must never touch the server process that runs the scheduled buyback. Manual sweep (via Squads or hardware wallet) is the only legitimate way to fund the hot. **[derived]**
13. **Never accept an authority-handoff from a third-party contract.** Authority-gated operations are one-way doors: if you transfer control of your treasury or fee routing to a protocol contract, only that protocol's support can reverse it. **[derived — Neo Trader CLAUDE.md, learned the hard way after pump.fun's authority contract permanently consumed a dev wallet's buyback authority.]**

## Composes With

- **`printr-agent-payments`** — `createInvoice`, `verifyInvoiceWithRetries`, invoice-gate logic. Required.
- **`printr-swap`** — `loadHotKeypair`, `quoteSwap`, `buildSwapTransaction`, `executeServerSwap`, `verifySwapOutput`. Required.
- **`printr-eco`** — ecosystem knowledge (POB mechanics, telecoin_id, fee model #1). Recommended for background context, not required at runtime.

Your project's code calls functions from both sub-skills. If you have not implemented them yet, invoke each sub-skill first and work bottom-up.

## Environment Variables

Superset of both sub-skills, with composition-specific additions. **The hot private key lives here; the cold key MUST NOT.**

```env
# ---- From printr-agent-payments ----
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
NEXT_PUBLIC_SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
TREASURY_RECEIVER_PUBKEY=<cold-wallet-pubkey>       # where users pay in
CURRENCY_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
DATABASE_URL=postgres://user:pass@host/db
INVOICE_TTL_SECONDS=86400

# ---- From printr-swap ----
JUPITER_API_URL=https://lite-api.jup.ag
TREASURY_HOT_PRIVATE_KEY=<base58-secret-key>        # ONLY the hot wallet's key. NEVER the cold.

# ---- Composition-specific ----
AGENT_TOKEN_MINT=<base58-spl-mint>                  # the POB token to buy back
TREASURY_COLD_PUBKEY=<squads-multisig-pubkey>       # public key only — the cold wallet
BUYBACK_THRESHOLD_LAMPORTS=100000000                # 0.1 SOL
BUYBACK_MAX_LAMPORTS=1000000000                     # 1 SOL
BUYBACK_SLIPPAGE_BPS=100                            # 1%
BUYBACK_CADENCE=0 * * * *                           # hourly
BURN_SPLIT_BURN_BPS=10000                           # 10000 = 100% burn. 8000 = 80% burn / 20% stake
```

**`TREASURY_RECEIVER_PUBKEY` vs `TREASURY_COLD_PUBKEY`:** In the recommended custody setup (Pattern 3 or 4, see `references/CUSTODY_PATTERNS.md`), these are the same address — users pay directly into the cold wallet. Some teams prefer a dedicated "mailbox" receiver that forwards to cold periodically; in that case the two env vars differ. The skill works either way; just be deliberate about which pattern you choose.

## Install

Everything from both sub-skills:

```bash
npm install @solana/web3.js@^1.98.0 @solana/spl-token@^0.4.0 @solana/spl-memo@^0.1.0 bs58@^6.0.0
```

Plus whatever DB client your framework uses. Example for SvelteKit on Neon:

```bash
npm install @neondatabase/serverless
```

## Database Schema

Extends the `payment_invoice` table from `printr-agent-payments` with a new `burn_event` table. **[derived]**

```sql
-- payment_invoice table from printr-agent-payments stays as-is.

CREATE TABLE burn_event (
  id                      BIGSERIAL     PRIMARY KEY,
  sol_in_lamports         BIGINT        NOT NULL,        -- SOL spent on the buyback
  agent_token_bought      BIGINT        NOT NULL,        -- atomic units received
  agent_token_burned      BIGINT        NOT NULL,        -- atomic units burned (may be < bought if split)
  agent_token_staked      BIGINT        NOT NULL DEFAULT 0, -- atomic units staked (if split policy)
  swap_sig                TEXT          NOT NULL,
  burn_sig                TEXT,                           -- null until burn confirms
  stake_sig               TEXT,                           -- null unless split policy + successful
  status                  TEXT          NOT NULL DEFAULT 'swap_done'
                                        CHECK (status IN
                                          ('swap_done','burn_done','stake_done','complete','failed')),
  error                   TEXT,                           -- populated on status='failed'
  cycle_started_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ
);

CREATE INDEX burn_event_status_idx ON burn_event (status, cycle_started_at DESC);
CREATE INDEX burn_event_recent_idx ON burn_event (cycle_started_at DESC);
```

## Core flow — the buyback cycle

This is the money code. One function per phase; each is idempotent; together they form `runBuybackCycle`.

### Phase 0: Pre-flight — recovery check

Before anything else, check whether the last cycle left the hot wallet holding un-burned agent tokens. If so, finish that cycle first instead of starting a new swap. **[derived — rule 11]**

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import { Pool } from '@neondatabase/serverless';
import { loadHotKeypair } from './printr-swap-code.js';  // from printr-swap skill

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

export async function findRecoveryCycle(
  connection: Connection,
  hotKeypair: import('@solana/web3.js').Keypair,
): Promise<{ id: number; amountToBurn: bigint } | null> {
  const mint = new PublicKey(process.env.AGENT_TOKEN_MINT!);
  const ata = await getAssociatedTokenAddress(mint, hotKeypair.publicKey);

  let ataBalance: bigint;
  try {
    const acct = await getAccount(connection, ata, 'confirmed');
    ataBalance = acct.amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return null;
    throw e;
  }

  if (ataBalance === 0n) return null;

  // We hold agent tokens. There MUST be a burn_event row in status='swap_done'.
  const { rows } = await pool.query(
    `SELECT id, agent_token_bought
       FROM burn_event
      WHERE status = 'swap_done'
      ORDER BY cycle_started_at DESC
      LIMIT 1`,
  );

  if (rows.length === 0) {
    // Orphan balance — tokens present but no open cycle. Log and abort.
    throw new Error(
      `hot wallet holds ${ataBalance} agent tokens but no open burn_event row — manual intervention required`,
    );
  }

  return {
    id: rows[0].id as number,
    amountToBurn: ataBalance,  // burn the actual ATA balance, not the recorded quote
  };
}
```

### Phase 1: Threshold check + quote + swap

```typescript
import { SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { quoteSwap, buildSwapTransaction, executeServerSwap, verifySwapOutput } from './printr-swap-code.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const FEE_RESERVE_LAMPORTS = 10_000_000n;  // 0.01 SOL held back for tx fees

export async function startCycle(
  connection: Connection,
  hotKeypair: import('@solana/web3.js').Keypair,
): Promise<
  | { action: 'noop'; reason: 'below_threshold'; hotBalance: bigint }
  | { action: 'swapped'; cycleId: number; swapSig: string; bought: bigint; solIn: bigint }
> {
  const threshold = BigInt(process.env.BUYBACK_THRESHOLD_LAMPORTS!);
  const maxPerCycle = BigInt(process.env.BUYBACK_MAX_LAMPORTS!);
  const slippageBps = Number(process.env.BUYBACK_SLIPPAGE_BPS!);

  const hotBalanceLamports = BigInt(await connection.getBalance(hotKeypair.publicKey, 'confirmed'));
  const available = hotBalanceLamports - FEE_RESERVE_LAMPORTS;
  const amountIn = available < maxPerCycle ? available : maxPerCycle;

  // Below threshold OR insufficient to cover fee reserve → no-op
  if (hotBalanceLamports < threshold || amountIn <= 0n) {
    return { action: 'noop', reason: 'below_threshold', hotBalance: hotBalanceLamports };
  }

  const quote = await quoteSwap({
    inputMint: SOL_MINT,
    outputMint: process.env.AGENT_TOKEN_MINT!,
    amount: amountIn,
    slippageBps,
  });

  const { tx, lastValidBlockHeight } = await buildSwapTransaction({
    quote,
    userPublicKey: hotKeypair.publicKey,
  });

  const swapSig = await executeServerSwap(connection, tx, lastValidBlockHeight, hotKeypair);

  const minOut = BigInt(quote.otherAmountThreshold);
  const actualOut = await verifySwapOutput(
    connection,
    new PublicKey(process.env.AGENT_TOKEN_MINT!),
    hotKeypair.publicKey,
    minOut,
  );

  // Record the swap IMMEDIATELY — before the burn runs. Rule 11.
  const { rows } = await pool.query(
    `INSERT INTO burn_event
       (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
     VALUES ($1, $2, 0, $3, 'swap_done')
     RETURNING id`,
    [amountIn.toString(), actualOut.toString(), swapSig],
  );
  const cycleId = rows[0].id as number;

  return { action: 'swapped', cycleId, swapSig, bought: actualOut, solIn: amountIn };
}
```

### Phase 2: Burn (and optionally stake)

SPL `burn` is instruction variant 8 of the Token program. It destroys tokens from the caller's ATA — provably irreversible. We prefer this over transferring to a null address. **[pattern]**

```typescript
import {
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createBurnInstruction,
  getAssociatedTokenAddress,
  getMint,
} from '@solana/spl-token';

export async function burnAgentTokens(
  connection: Connection,
  hotKeypair: import('@solana/web3.js').Keypair,
  cycleId: number,
  amountToBurn: bigint,
): Promise<string> {
  const mint = new PublicKey(process.env.AGENT_TOKEN_MINT!);
  const ata = await getAssociatedTokenAddress(mint, hotKeypair.publicKey);

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    createBurnInstruction(
      ata,
      mint,
      hotKeypair.publicKey,
      amountToBurn,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = hotKeypair.publicKey;
  tx.sign(hotKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`burn failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }

  await pool.query(
    `UPDATE burn_event
        SET agent_token_burned = $1,
            burn_sig = $2,
            status = CASE
              WHEN agent_token_staked = 0 THEN 'complete'
              ELSE 'burn_done'
            END,
            completed_at = CASE
              WHEN agent_token_staked = 0 THEN now()
              ELSE completed_at
            END
      WHERE id = $3`,
    [amountToBurn.toString(), sig, cycleId],
  );

  return sig;
}
```

**Split policy (optional).** If `BURN_SPLIT_BURN_BPS < 10000`, burn the `burnBps` fraction and stake the rest. Staking on Printr uses the V1 staking API (`POST /v1/staking/create-position`) — see `printr-eco` skill for the client pattern. Keep staking **out of this skill's critical path**: run it in a follow-up phase so a staking-API outage doesn't block burns.

```typescript
// Pseudocode for split:
// const bought = event.agent_token_bought;
// const burnBps = Number(process.env.BURN_SPLIT_BURN_BPS ?? '10000');
// const toBurn = (bought * BigInt(burnBps)) / 10_000n;
// const toStake = bought - toBurn;
// burnAgentTokens(..., toBurn);
// if (toStake > 0n) { stakeOnPrintr(..., toStake); }
```

### Phase 3: Top-level orchestrator

```typescript
export type CycleResult =
  | { action: 'noop'; reason: 'below_threshold'; hotBalance: bigint }
  | { action: 'recovered'; cycleId: number; burnSig: string; amountBurned: bigint }
  | { action: 'completed'; cycleId: number; swapSig: string; burnSig: string; solIn: bigint; amountBurned: bigint }
  | { action: 'failed'; stage: 'swap' | 'burn' | 'preflight'; error: string };

export async function runBuybackCycle(): Promise<CycleResult> {
  const connection = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
  const hotKeypair = loadHotKeypair();
  let stage: 'preflight' | 'swap' | 'burn' = 'preflight';

  try {
    // Phase 0 — recover any previously-partial cycle before starting new work.
    const recovery = await findRecoveryCycle(connection, hotKeypair);
    if (recovery) {
      stage = 'burn';
      const burnSig = await burnAgentTokens(connection, hotKeypair, recovery.id, recovery.amountToBurn);
      return { action: 'recovered', cycleId: recovery.id, burnSig, amountBurned: recovery.amountToBurn };
    }

    // Phase 1 — fresh cycle (quote + swap).
    stage = 'swap';
    const start = await startCycle(connection, hotKeypair);
    if (start.action === 'noop') {
      return { action: 'noop', reason: 'below_threshold', hotBalance: start.hotBalance };
    }

    // Phase 2 — burn.
    stage = 'burn';
    const burnSig = await burnAgentTokens(connection, hotKeypair, start.cycleId, start.bought);
    return {
      action: 'completed',
      cycleId: start.cycleId,
      swapSig: start.swapSig,
      burnSig,
      solIn: start.solIn,
      amountBurned: start.bought,
    };
  } catch (e) {
    // All three phases report structured failures to the scheduler instead of
    // throwing. Without this wrapper `{ action: 'failed' }` in CycleResult is
    // unreachable — SCENARIOS.md §4 and §6 both rely on it.
    return { action: 'failed', stage, error: e instanceof Error ? e.message : String(e) };
  }
}
```

## Scheduled cadence

Hourly by default. The scheduler depends on your host:

### Netlify Scheduled Functions

```toml
# netlify.toml
[[functions."api/admin/buyback"]]
schedule = "0 * * * *"   # hourly, BUYBACK_CADENCE
```

Endpoint handler wraps `runBuybackCycle()` and returns the `CycleResult` as JSON. The cron trigger is automatic; no inbound request validation needed (Netlify guarantees the cron invocation comes from their infra).

### Vercel Cron

```json
// vercel.json
{
  "crons": [
    { "path": "/api/admin/buyback", "schedule": "0 * * * *" }
  ]
}
```

Vercel calls your endpoint with a `CRON_SECRET` bearer; **verify it** in the handler. Do not accept unauthenticated POSTs.

### GitHub Actions (fallback)

```yaml
# .github/workflows/buyback.yml
on:
  schedule:
    - cron: '0 * * * *'
jobs:
  buyback:
    runs-on: ubuntu-latest
    steps:
      - run: curl -sS -X POST -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" https://your-app/api/admin/buyback
```

## Paid-action gating — how to use this from your agent

The tokenized-agent loop is not useful unless your agent *charges for something*. A minimal gate:

```typescript
// In your agent tool handler:
async function handleDeepAnalysisTool(sessionId: string, walletPubkey: string, ...args: unknown[]) {
  // 1. Check if this session has a paid invoice already
  const { rows } = await pool.query(
    `SELECT memo FROM payment_invoice
      WHERE session_id = $1 AND purpose = 'deep_analysis'
        AND status = 'paid' AND paid_at > now() - interval '24 hours'
      ORDER BY paid_at DESC LIMIT 1`,
    [sessionId],
  );

  if (rows.length > 0) {
    // Already paid — run the expensive action
    return runDeepAnalysis(walletPubkey, ...args);
  }

  // 2. Not paid — return a 402 Payment Required with an invoice request hint
  return {
    paid: false,
    action: 'request_payment',
    price_smallest_unit: '50000000',   // 0.05 SOL
    currency: 'SOL',
    purpose: 'deep_analysis',
  };
}
```

The client sees `paid: false`, fires the `PaymentButton` flow from `printr-agent-payments/references/WALLET_INTEGRATION.md`, then retries the tool call.

## Scenario Tests & Troubleshooting

See `references/SCENARIOS.md` for the six canonical end-to-end scenarios (below-threshold noop, completed cycle, swap-succeeds-burn-fails recovery, orphan balance, slippage bust, Jupiter route missing) and a troubleshooting table.

## Custody

See `references/CUSTODY_PATTERNS.md` for the four supported patterns with blast-radius analysis per each. This skill is **custody-agnostic** — the code above works with any of the four patterns unchanged.

## When NOT to use

- **pump.fun-launched tokens.** Use `@pump-fun/agent-payments-sdk` directly — their hosted authority contract handles buyback automatically and protects against treasury-key loss.
- **Non-Solana tokens.** The code here is Solana-specific (SPL, Jupiter, Meteora). EVM equivalents require Uniswap v4 / 0x + ERC20 burn().
- **Pre-graduation tokens** if your narrative depends on POB stakers being paid. Pre-graduation, the Meteora DBC doesn't apply Printr's custom fee — buybacks still reduce float but don't feed the pool. See `printr-swap` bonding-curve scenario.
- **Projects without persistent DB** in production. The invoice + burn_event state is load-bearing; serverless instance restarts must not lose it.
- **Treasuries too small to absorb occasional slippage.** At <$20k pool liquidity and 0.1 SOL cycle size, expect ~0.5% worst-case slippage per cycle. Smaller pools need smaller cycles.

## Reference implementation

`github.com/AIEngineerX/inked` (the $INKED project) — the first production consumer of this skill. Relevant paths once shipped:

- `src/routes/api/pay/invoice/+server.ts`, `src/routes/api/pay/verify/+server.ts` — from `printr-agent-payments`
- `src/routes/api/admin/buyback/+server.ts` — this skill's `runBuybackCycle`
- `src/lib/server/pay/*`, `src/lib/server/buyback/*`, `src/lib/server/burn/*`
- `migrations/013_ink_payment.sql` — `payment_invoice` + `burn_event`
- `src/routes/burn/+page.svelte` — public dashboard (convention, not required by this skill)

Adopters: PR yourself into this list once you've run a production cycle.
