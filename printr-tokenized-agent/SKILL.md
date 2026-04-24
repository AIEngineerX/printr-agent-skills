---
name: printr-tokenized-agent
description: >
  Build a tokenized-agent revenue loop on a Printr POB token. Composes `printr-agent-payments` (accept user SOL/USDC for agent actions) with `printr-swap` (Jupiter buyback) and adds SPL `burn` plus a scheduled hourly cycle, all under the creator's own treasury. On Printr POB-model-1 tokens the buyback contributes to the DAMM v2 pool's LP-fee accrual, which Printr's POB program distributes to stakers asynchronously — the buyback both reduces supply and feeds the pool that downstream stakers draw from (second-order effect, not a per-swap hook). Triggers on "Printr tokenized agent", "agent revenue burn", "buyback and burn for a Printr POB token", "first tokenized agent on Printr", or when composing the `printr-swap` + `printr-agent-payments` skills into one loop.
metadata:
  author: printr-community
  version: '1.0'
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
- [ ] Agent token program ID: **classic SPL** or **Token-2022**? Check by running `getAccountInfo(mint)` and looking at the `owner` field — `TokenkegQ…` = classic SPL, `TokenzQdB…` = Token-2022. Many POB tokens graduated post-mid-2025 are Token-2022.
- [ ] Signer source for swaps: **server-signed** is the only valid answer for automated buybacks
- [ ] Slippage tolerance in bps (recommend 100 = 1%)

### Composition-specific pre-work

- [ ] Burn policy: **100% burn** / **split** (e.g. 80% burn + 20% treasury stake) — ship 100% first, revisit
- [ ] Buyback threshold in lamports (recommend `100_000_000` = 0.1 SOL)
- [ ] Buyback max per cycle in lamports (recommend `1_000_000_000` = 1 SOL, or 50% of typical hot-wallet balance — whichever is lower)
- [ ] Cadence (default `0 * * * *` = hourly) — confirm your scheduler supports cron
- [ ] Treasury custody tier — **Pattern 1, 2, 3, or 4** from `references/CUSTODY_PATTERNS.md`
- [ ] Solana RPC URL (production-grade recommended — Helius paid tier or equivalent)
- [ ] **Dry-run acknowledgment:** have you run at least one successful `BUYBACK_DRY_RUN=true` cycle against the live mint, confirmed the simulated swap routes through the expected pool, and verified the inner-instruction output is plausible? A live cycle MUST NOT run before this. See §Dry-Run Mode.

You MUST ask the user for ALL unchecked items in your very first response. Do not assume defaults. Do not proceed until the user has explicitly answered each one.

## Safety Rules

Rules 1–6 are standard Solana / payment-skill practice **[pattern]**. Rule 7 is the meta-rule that prevents spec-drift during generation **[derived]**. Rules 8–12 are composition-specific (mostly **[derived]**). Rule 13 is the single most expensive lesson in this ecosystem **[derived]**.

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
13. **Never accept an authority-handoff from a third-party contract.** Authority-gated operations are one-way doors: if you transfer control of your treasury or fee routing to a protocol contract, only that protocol's support can reverse it. **[derived — learned the hard way when a third-party launchpad's authority contract permanently consumed a dev wallet's buyback-configuration authority; the dev wallet could no longer change buyback settings or recover control.]**
14. **Dry-run before first live cycle.** Always run with `BUYBACK_DRY_RUN=true` against the actual mint at least once before enabling the cron. Dry-run runs through the full cycle using `connection.simulateTransaction` — no SOL spent, no DB writes — and surfaces any issue that would cause a live cycle to fail or fill unexpectedly. First production adopters on a new token MUST NOT skip this step. **[derived]**

## Composes With

- **`printr-agent-payments`** — `createInvoice`, `verifyInvoiceWithRetries`, invoice-gate logic. Required when the funding source is user payments.
- **`printr-swap`** — `loadHotKeypair`, `quoteSwap`, `buildSwapTransaction`, `executeServerSwap`, `verifySwapOutput`. Required.
- **`@printr/agent-skills/staking`** — `listPositionsWithRewards`, `claimRewards`, `claimAllAboveThreshold`. Required when `autoClaim` is enabled — funds the cycle from the owner's accrued POB yield instead of user payments.
- **`printr-eco`** — ecosystem knowledge (POB mechanics, telecoin_id, fee model #1). Recommended for background context, not required at runtime.

Your project's code calls functions from the sub-skills. If you have not implemented them yet, invoke each sub-skill first and work bottom-up.

## Funding sources — two patterns

The cycle needs SOL in the hot wallet to run. Two architectures depending on where that SOL comes from:

### A. Payment-funded (the classic pump.fun pattern)

Users pay the agent for actions via `printr-agent-payments`. Revenue accumulates in the hot wallet. Cron swaps + burns.

- **Keys on server:** hot wallet only
- **Blast radius if compromised:** ≤ one cycle of SOL
- **Manual ritual:** none — users feed the loop via paid actions
- **Use `autoClaim`:** no, leave it unset

### B. Stake-reward-funded (POB-native pattern)

The owner's own staked position accrues SOL rewards from POB fee distribution (`docs/references/printr-api/V2_FEATURES.md` §POB mechanics). The cycle claims those rewards at the top of each run, funding itself from the owner's passive yield.

- **Keys on server:** `hotKeypair` is also the position owner
- **Blast radius if compromised:** everything staked + all claimable rewards + stake principal after lock expiry
- **Manual ritual:** none — fully autonomous
- **Use `autoClaim`:** yes (see configuration below)

Pattern B is an upgrade over the classic pump.fun loop for POB tokens specifically: stake rewards are continuous, creator-attributable, and explicitly part of Printr's fee-distribution design. The cost is widening the blast radius. Pattern A stays strictly better for adopters with significant staked principal who accept the manual ritual.

### Auto-claim configuration

```typescript
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const cycleCfg: CycleConfig = {
  pool,
  connection,
  hotKeypair, // also owns the stake positions
  agentTokenMint: new PublicKey('…'),
  tokenProgramId: TOKEN_2022_PROGRAM_ID,
  thresholdLamports: 100_000_000n,
  maxPerCycleLamports: 1_000_000_000n,
  slippageBps: 100,
  autoClaim: {
    telecoinIds: ['0x…'], // optional — filter to a specific telecoin
    minClaimableLamports: 10_000_000n, // 0.01 SOL floor, avoid dust claims + tx fee waste
    // printrOptions?: { apiKey, apiBase, timeoutMs }
  },
};
```

### Phase order when autoClaim is set

1. **Phase 0 — Recovery** (unchanged). Runs first; a swap-succeeded-burn-failed state from a previous cycle is resolved before any new work. Recovery burns are not mixed with claim-delivered tokens.
2. **Phase 0.5 — Claim (NEW).** `claimAllAboveThreshold(ownerKeypair=hotKeypair, telecoinIds, minClaimableLamports, connection)` — queries `/v1/staking/list-positions-with-rewards`, filters positions with claimable SOL ≥ threshold, submits one claim tx. SOL lands in the hot wallet; claimed telecoin rewards land in the hot ATA alongside what the swap will deliver.
3. **Phase 1 — Swap** (unchanged). startCycle snapshots the ATA balance pre-swap and uses the delta for slippage verification — so claimed telecoin rewards pre-populating the ATA don't hide a slippage-busted swap.
4. **Phase 2 — Burn** (updated). Passes the **total ATA balance** (claimed + bought) to `burnAgentTokens` in a single burn ix. Both the claimed telecoin rewards and the freshly-bought telecoin are destroyed in one tx.

### CycleResult — claim field

`CycleResult` gains an optional `claim?: ClaimPhaseResult` field on `completed`, `noop`, and `failed` variants:

```typescript
interface ClaimPhaseResult {
  signature: string;
  claimedLamports: bigint;
  claimedTelecoinAtomic: bigint;
  positionsClaimed: number;
}
```

Null when `autoClaim` wasn't configured OR nothing was above the threshold.

### New failure stage

`'failed'` CycleResult's `stage` enum gains `'claim'` for claim-phase failures (Printr API errors, sign-send failures, etc.). The partial `claim?` field may or may not be present depending on where in the claim phase it died.

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

# Dry-run toggle. When 'true', runBuybackCycle simulates swap + burn via
# connection.simulateTransaction, returns what WOULD happen, writes nothing
# to the DB, and sends no tx. Required to be 'true' for the first cycle
# against any new mint. Flip to 'false' only after a successful dry-run.
BUYBACK_DRY_RUN=true
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
import { loadHotKeypair } from './printr-swap-code.js'; // from printr-swap skill

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
    amountToBurn: ataBalance, // burn the actual ATA balance, not the recorded quote
  };
}
```

### Phase 1: Threshold check + quote + swap

```typescript
import { SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  quoteSwap,
  buildSwapTransaction,
  executeServerSwap,
  verifySwapOutput,
  SwapBelowMinimumError,
} from './printr-swap-code.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const FEE_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL held back for tx fees

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

  // Record the swap_done row IMMEDIATELY after swap confirmation — before the
  // ATA re-read. Rule 11. Any failure past this point leaves a durable row:
  // a transient RPC error in verifySwapOutput keeps status='swap_done' so
  // findRecoveryCycle picks up the ATA balance next tick; a real slippage
  // bust is caught below and flips the row to 'failed' so recovery does not
  // auto-burn a partial fill without operator review. agent_token_bought is
  // seeded with the quote minimum and rewritten with the verified amount on
  // the happy path.
  const inserted = await pool.query(
    `INSERT INTO burn_event
       (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
     VALUES ($1, $2, 0, $3, 'swap_done')
     RETURNING id`,
    [amountIn.toString(), quote.otherAmountThreshold, swapSig],
  );
  const cycleId = inserted.rows[0].id as number;

  const minOut = BigInt(quote.otherAmountThreshold);
  let actualOut: bigint;
  try {
    actualOut = await verifySwapOutput(
      connection,
      new PublicKey(process.env.AGENT_TOKEN_MINT!),
      hotKeypair.publicKey,
      minOut,
    );
  } catch (e) {
    if (e instanceof SwapBelowMinimumError) {
      await pool.query(`UPDATE burn_event SET status = 'failed', error = $1 WHERE id = $2`, [
        e.message,
        cycleId,
      ]);
    }
    throw e;
  }

  await pool.query(`UPDATE burn_event SET agent_token_bought = $1 WHERE id = $2`, [
    actualOut.toString(),
    cycleId,
  ]);

  return { action: 'swapped', cycleId, swapSig, bought: actualOut, solIn: amountIn };
}
```

### Phase 2: Burn (and optionally stake)

SPL `burn` is instruction variant 8 of the Token program. It destroys tokens from the caller's ATA — provably irreversible. We prefer this over transferring to a null address. **[pattern]**

```typescript
import { Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createBurnInstruction, getAssociatedTokenAddress, getMint } from '@solana/spl-token';

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
    createBurnInstruction(ata, mint, hotKeypair.publicKey, amountToBurn),
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
  | {
      action: 'completed';
      cycleId: number;
      swapSig: string;
      burnSig: string;
      solIn: bigint;
      amountBurned: bigint;
    }
  | {
      action: 'dry_run';
      solIn: bigint;
      expectedBought: bigint;
      wouldBurn: bigint;
      swap: {
        simulatedErr: unknown;
        computeUnitsConsumed: number | null;
        tokenTransferCount: number | null;
      };
      burn: {
        simulatedErr: unknown;
        computeUnitsConsumed: number | null;
      };
    }
  | { action: 'failed'; stage: 'swap' | 'burn' | 'preflight'; error: string };

export async function runBuybackCycle(cfg?: { dryRun?: boolean }): Promise<CycleResult> {
  const connection = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
  const hotKeypair = loadHotKeypair();
  const dryRun = cfg?.dryRun ?? process.env.BUYBACK_DRY_RUN === 'true';
  let stage: 'preflight' | 'swap' | 'burn' = 'preflight';

  try {
    // Dry-run short-circuits the live path. See §Dry-Run Mode.
    if (dryRun) {
      stage = 'swap';
      return await runDryRunCycle(connection, hotKeypair);
    }

    // Phase 0 — recover any previously-partial cycle before starting new work.
    const recovery = await findRecoveryCycle(connection, hotKeypair);
    if (recovery) {
      stage = 'burn';
      const burnSig = await burnAgentTokens(
        connection,
        hotKeypair,
        recovery.id,
        recovery.amountToBurn,
      );
      return {
        action: 'recovered',
        cycleId: recovery.id,
        burnSig,
        amountBurned: recovery.amountToBurn,
      };
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

## Maturity status

| Component                                         | Status                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runBuybackCycle` — swap + burn cycle             | **Production-verified** — first live cycle on a graduated Token-2022 POB telecoin 2026-04-24. Solscan: [swap](https://solscan.io/tx/qDQwNKVqsSbZLL4JZ7QwSy2y9oPtHx5wXCkLnfsDCCAESLf2kW2fqZDLRo8BCp6z9rFnXnpgPhCh3LxRJj5613E) · [burn](https://solscan.io/tx/5pvuDM4dcPJf3mff57uSvLUQrWBTB2Jp3bvfPtSKA9oohnGQh5ZLtenMsB2JsaaWuMSfpM9pBG4TLkXXjMKNMyZz) |
| `CycleConfig.tokenProgramId` — Token-2022 support | **Production-verified** — used by the first live cycle                                                                                                                                                                                                                                                                                                |
| Recovery mode (swap-succeeds-burn-fails)          | Unit-tested, not triggered in production yet                                                                                                                                                                                                                                                                                                          |
| `simulateSwap` dry-run                            | **Live-tested** on mainnet against a graduated Token-2022 POB telecoin pre-deployment                                                                                                                                                                                                                                                                 |
| `autoClaim` phase (this skill, new in 0.2.0)      | **Preview** — code complete, 106 tests pass, NOT yet run live. Blast-radius-widening (creator key on server); read §Funding sources carefully before enabling                                                                                                                                                                                         |

## How POB Model-1 Fee Distribution Actually Works

**Important mechanism clarification — verified empirically against a graduated Token-2022 POB telecoin on 2026-04-23:**

POB Model-1 does **not** emit a per-swap fee-hook transfer. The mechanism is:

1. Token graduates from Meteora DBC → Meteora DAMM v2.
2. An LP position on the DAMM v2 pool is owned by Printr's SVM program `T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint`.
3. Every trade on the pool accrues LP fees via standard Meteora DAMM v2 fee accounting — **nothing Printr-specific happens during the swap**. Printr's program is NOT invoked on the hot path.
4. **Separately and asynchronously**, Printr's program runs a reward distribution job: reads accrued fees, distributes SOL (and in some cases telecoin) to stakers proportionally by `(staked × lockMultiplier) / totalWeightedStake`.
5. Stakers claim via `POST /v1/staking/claim-rewards`.

**Consequences for this skill:**

- The kit's buybacks contribute to LP-fee accrual on the DAMM v2 pool as a second-order effect. They do NOT pay stakers synchronously during the swap. Any skill doc or README passage that implies a per-swap payout is misleading — corrected as of 2026-04-23.
- `simulateSwap` can verify the route + compute cost, but it **cannot** verify the POB mechanism. The mechanism is proved by reading Printr's API, not by inspecting a swap's inner instructions.
- Every POB model-1 swap on-chain looks identical to a plain Meteora DAMM v2 swap. There is no extra transfer to look for. **[Printr]**

**Canonical mechanism check** — `scripts/verify-printr-mechanism.ts` in this kit:

```bash
npx tsx scripts/verify-printr-mechanism.ts <TELECOIN_ID>
```

Queries `POST /v1/staking/list-positions-with-rewards` + `POST /v1/telecoin/buyback-burn-detail` and reports aggregated claimable/claimed rewards. Non-zero = mechanism is live for this telecoin.

## Dry-Run Mode

**Mandatory for the first cycle against any new mint.** When `BUYBACK_DRY_RUN=true` (or `CycleConfig.dryRun=true`), `runBuybackCycle` runs through the full flow but:

- Calls `simulateSwap` (from `printr-swap`) instead of `executeServerSwap`. No tx submitted.
- Uses Solana's `connection.simulateTransaction` under the hood with `sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true` — no SOL spent, no signature required. **[pattern]**
- Builds the burn tx at the simulated output amount and simulates it as well. The burn simulation will fail with a token-balance error because the hot wallet's ATA hasn't actually received the swap output — **this is expected** and the `'dry_run'` CycleResult surfaces it as `burn.simulatedErr` so the caller can inspect compute cost and instruction shape without treating it as a real failure.
- Writes nothing to the DB. `burn_event` stays untouched. No `status='swap_done'` row means `findRecoveryCycle` on the next live cycle will not try to recover a dry-run.
- Returns a `'dry_run'` CycleResult variant with:
  - `solIn` — the lamports that would have been spent.
  - `expectedBought` — the output amount Jupiter's simulation says the ATA would receive.
  - `wouldBurn` — the amount the burn instruction was built for (same as `expectedBought` under 100% burn policy).
  - `swap.tokenTransferCount` — count of Token Program transfers in simulated inner instructions (covers both SPL-Token and Token-2022 since many POB tokens are Token-2022). Sanity check that the swap routed at all; NOT a proxy for fee-hook detection (see §"How POB Model-1 Fee Distribution Actually Works").

### What a successful dry-run proves

1. **Jupiter route exists** for the mint and resolves at the target `BUYBACK_MAX_LAMPORTS`.
2. **Pool is classified** (DAMM v2 vs DBC) — the swap won't silently route through an un-classified venue.
3. **`quote.otherAmountThreshold` is plausible** — `expectedBought` from simulation should track it closely.
4. **Compute-unit cost is within budget** — `swap.computeUnitsConsumed` should land well under 200,000 CUs (Jupiter's default limit).
5. **Hot wallet keypair loads** — `loadHotKeypair` succeeds.

### What a dry-run does NOT prove

- Network conditions at the time of the real tx. Compute-unit pricing, MEV, slot congestion all vary.
- The tx will land within `lastValidBlockHeight` on the real run. Network-level retries are not part of simulation.
- Persistent-DB lock semantics under concurrent cron firings. Dry-run skips all DB writes.
- **POB fee distribution is live for this telecoin.** Separate concern — use `scripts/verify-printr-mechanism.ts`.

### Wiring

```typescript
// CycleConfig:
export interface CycleConfig {
  pool: QueryablePool;
  connection: Connection;
  hotKeypair: Keypair;
  agentTokenMint: PublicKey;
  thresholdLamports: bigint;
  maxPerCycleLamports: bigint;
  slippageBps: number;
  /** Optional. Defaults to classic SPL (TokenkegQ...). Pass
   *  `TOKEN_2022_PROGRAM_ID` from `@solana/spl-token` for Token-2022
   *  mints — threads through to getAssociatedTokenAddress, getAccount,
   *  and createBurnInstruction so the ATA is derived correctly and the
   *  burn ix addresses the right program. **[Printr]** */
  tokenProgramId?: PublicKey;
  dryRun?: boolean; // default false. When true, no submission + no DB writes.
}

// Scheduler handler reads env and threads through:
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

export async function handler(): Promise<CycleResult> {
  return runBuybackCycle({
    // ...existing config...
    tokenProgramId: process.env.AGENT_TOKEN_IS_2022 === 'true' ? TOKEN_2022_PROGRAM_ID : undefined,
    dryRun: process.env.BUYBACK_DRY_RUN === 'true',
  });
}
```

### Pattern for first production run

1. **Mechanism check first** — `npx tsx scripts/verify-printr-mechanism.ts <TELECOIN_ID>`. Confirm POB distribution is live before spending engineering effort on the buyback loop.
2. Deploy with `BUYBACK_DRY_RUN=true` + `BUYBACK_ENABLED=true` (kill-switch). Cron fires hourly.
3. Inspect the first few dry-run results via logs. Confirm: Jupiter routed DAMM v2, `expectedBought` ≈ `quote.otherAmountThreshold`, compute cost plausible.
4. If all green for at least 2–3 consecutive dry runs across different slots, flip `BUYBACK_DRY_RUN=false`. The next cron fires a live cycle.
5. First live cycle's burn is the evidence you can PR into the adopters table.

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
  "crons": [{ "path": "/api/admin/buyback", "schedule": "0 * * * *" }]
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

The tokenized-agent loop is not useful unless your agent _charges for something_. A minimal gate:

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
    price_smallest_unit: '50000000', // 0.05 SOL
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

- **Non-Solana tokens.** The code here is Solana-specific (SPL, Jupiter, Meteora). EVM equivalents require Uniswap v4 / 0x + ERC20 burn().
- **Tokens on launchpads that provide their own hosted buyback primitives.** If your launchpad already handles auto-buyback via a hosted authority contract, use that — this kit is for platforms that don't.
- **Pre-graduation tokens** if your narrative depends on POB stakers being paid. Pre-graduation, the Meteora DBC doesn't apply Printr's custom fee — buybacks still reduce float but don't feed the pool. See `printr-swap` bonding-curve scenario.
- **Projects without persistent DB** in production. The invoice + burn_event state is load-bearing; serverless instance restarts must not lose it.
- **Treasuries too small to absorb occasional slippage.** At <$20k pool liquidity and 0.1 SOL cycle size, expect ~0.5% worst-case slippage per cycle. Smaller pools need smaller cycles.

## Production track record

First production cycle: 2026-04-24, graduated Token-2022 POB telecoin, Netlify Scheduled Function (Node 22.x) + Neon Postgres. Solscan: [swap](https://solscan.io/tx/qDQwNKVqsSbZLL4JZ7QwSy2y9oPtHx5wXCkLnfsDCCAESLf2kW2fqZDLRo8BCp6z9rFnXnpgPhCh3LxRJj5613E) · [burn](https://solscan.io/tx/5pvuDM4dcPJf3mff57uSvLUQrWBTB2Jp3bvfPtSKA9oohnGQh5ZLtenMsB2JsaaWuMSfpM9pBG4TLkXXjMKNMyZz).

Typical deployment:

- `/api/pay/invoice` + `/api/pay/verify` — `printr-agent-payments` endpoints
- `/api/admin/buyback` — scheduled endpoint calling `runBuybackCycle()`
- One migration installing both `payment_invoice` + `burn_event`
- Optional `/burn` dashboard reading recent rows for public transparency

Adopters: open a PR linking your first burn tx so it can be added to `README.md` §Production track record.
