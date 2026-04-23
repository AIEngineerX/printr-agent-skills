# Scenario Tests — printr-tokenized-agent

Six end-to-end scenarios covering the composed loop. Each walks through `runBuybackCycle` with a specific starting state. **[pattern]** Run against a testnet/devnet or the smallest possible mainnet amounts before ever enabling your prod cron.

## Scenario 1: Below-Threshold — No-op

1. Cron fires hourly. `runBuybackCycle` starts.
2. Phase 0: `findRecoveryCycle` reads agent-token ATA balance → `0`. Returns `null`. No recovery work.
3. Phase 1: `startCycle` reads hot SOL balance → `50_000_000` (0.05 SOL).
4. `BUYBACK_THRESHOLD_LAMPORTS = 100_000_000` (0.1 SOL). `50M < 100M`.
5. Returns `{ action: 'noop', reason: 'below_threshold', hotBalance: 50000000n }`.
6. No DB writes. No on-chain activity. Cost: two RPC reads.

## Scenario 2: Happy Path — Complete Cycle

1. Cron fires. Hot balance = `300_000_000` (0.3 SOL). Threshold met.
2. Phase 0: ATA balance `0`. No recovery.
3. Phase 1:
   - `amountIn = min(300M - 10M reserve, BUYBACK_MAX = 1_000M)` = `290M` lamports.
   - `quoteSwap(SOL → AGENT, 290M, slippageBps=100)` → Jupiter returns `outAmount = 750_000_000_000` atomic agent tokens, `otherAmountThreshold = 742_500_000_000`.
   - `buildSwapTransaction({quote, userPublicKey: hot.pubkey})` → VersionedTransaction.
   - `executeServerSwap(...)` → signs, submits, confirms. Returns `swapSig = '5x7a…'`.
   - `verifySwapOutput(AGENT, hot, 742_500_000_000n)` → ATA now holds `748_000_000_000` atomic (≥ threshold). Returns that value.
   - INSERT `burn_event` with `sol_in_lamports=290M, agent_token_bought=748B, status='swap_done', swap_sig='5x7a…'`. Returns `cycleId=42`.
4. Phase 2:
   - `burnAgentTokens(connection, hot, 42, 748_000_000_000n)`
   - Build tx: compute budget + SPL `burn` instruction for 748B atomic units from hot's ATA.
   - Sign, submit, confirm. `burnSig='9q3m…'`.
   - UPDATE `burn_event` SET `agent_token_burned=748B, burn_sig='9q3m…', status='complete', completed_at=now() WHERE id=42`.
5. Return `{ action: 'completed', cycleId: 42, swapSig: '5x7a…', burnSig: '9q3m…', solIn: 290000000n, amountBurned: 748000000000n }`.

## Scenario 3: Swap Succeeds, Burn Fails — Recovery Next Cycle

1. Cycle starts normally. Swap confirms; `burn_event` row written with `status='swap_done'`.
2. Before the burn tx confirms, the server crashes (OOM / deploy restart / RPC timeout after confirmation started).
3. `burn_event` row stays in `status='swap_done'`. ATA holds the bought tokens.
4. **1 hour later — next cron fires:**
   - Phase 0: `findRecoveryCycle` reads ATA balance → `748_000_000_000` atomic. Queries DB for latest `status='swap_done'` row → finds id=42.
   - Returns `{ id: 42, amountToBurn: 748_000_000_000n }` — the **actual ATA balance**, not the DB-recorded `agent_token_bought` (matters if somehow tokens leaked in/out between cycles).
5. `runBuybackCycle` sees `recovery !== null`, calls `burnAgentTokens(...)` with the recovered amount.
6. Burn succeeds. Row flips to `status='complete'`.
7. **Does NOT run Phase 1 for a new cycle this turn.** Next cron picks that up.
8. Returns `{ action: 'recovered', cycleId: 42, burnSig, amountBurned: 748B }`.

## Scenario 4: Orphan Balance — Manual Intervention Required

1. Cron fires. Phase 0 reads ATA → `500_000_000_000` atomic tokens present.
2. DB query for `status='swap_done'` row → **zero rows.**
3. The code throws: `"hot wallet holds 500000000000 agent tokens but no open burn_event row — manual intervention required"`.
4. `runBuybackCycle` returns `{ action: 'failed', stage: 'preflight', error: <thrown message> }`.
5. Cron handler logs the failure. Operator is paged (or sees it in the next status check).
6. **Diagnosis path:**
   - Someone sent the hot wallet agent tokens directly (airdrop? test tx?). Not a cycle output.
   - OR: the DB was restored from a backup that predates a completed cycle, dropping the burn_event row but not the on-chain state.
7. **Manual fix:** insert a reconciliation `burn_event` row with `sol_in_lamports=0, agent_token_bought=<ata_balance>, status='swap_done', swap_sig='<manual-reconcile>'`. Next cron will burn.

## Scenario 5: Slippage Bust — Reduced Fill

1. Cycle starts. `amountIn=290M`. Quote returns `outAmount=750B, otherAmountThreshold=742.5B`.
2. Between quote and submission, another trade drains the pool. Our swap tx confirms but fills at `600_000_000_000` — 20% worse than quoted.
3. `startCycle` writes the `burn_event` row with `status='swap_done', agent_token_bought=742.5B` (seeded from `quote.otherAmountThreshold`) immediately after swap confirmation.
4. `verifySwapOutput(...expected 742_500_000_000)` throws `SwapBelowMinimumError`: `"swap output below minimum: got 600000000000, expected >= 742500000000"`.
5. **This is correct behavior.** The swap _did_ go through — tokens are in the ATA — but they're below tolerance.
6. **What happens next:**
   - `startCycle` catches `SwapBelowMinimumError`, flips the row to `status='failed', error='swap output below minimum: …'`, and rethrows.
   - `runBuybackCycle` returns `{ action: 'failed', stage: 'swap', error: '…' }`.
   - Hot wallet holds 600B tokens. The DB has a `failed` row — not a `swap_done` row — so `findRecoveryCycle` does NOT auto-burn the partial fill on the next cycle. Operator review is required.
7. **Operator action:** inspect the `burn_event` row (`id=<cycleId>, status='failed'`). Options:
   - **Accept the partial fill**: `UPDATE burn_event SET status='swap_done' WHERE id=$1`. Next cron's `findRecoveryCycle` will read the 600B ATA balance and burn it.
   - **Reject and move funds**: transfer the 600B tokens out of the hot wallet to cold, and mark the row resolved (e.g. `UPDATE burn_event SET completed_at=now() WHERE id=$1`).
   - **Prevent recurrence**: tighten `BUYBACK_SLIPPAGE_BPS` or lower `BUYBACK_MAX_LAMPORTS` so future cycles are less likely to bust.
8. **Distinguishing slippage bust from transient RPC failure:** if `verifySwapOutput` throws for any reason other than `SwapBelowMinimumError` (e.g. `getAccount` RPC timeout after the swap confirmed), the row stays `status='swap_done'` and `findRecoveryCycle` picks up the ATA balance next tick — see Scenario 3.

## Scenario 6: Jupiter Route Missing — Pre-Graduation or Un-Indexed

1. Cycle starts. Threshold met.
2. `quoteSwap(...)` hits Jupiter `/swap/v1/quote`. Response has `routePlan: []`.
3. The helper throws: `"No route available for <SOL> -> <AGENT_MINT>"`.
4. `startCycle` propagates. `runBuybackCycle` returns `{ action: 'failed', stage: 'swap', error: '...' }`.
5. No DB write. Hot balance untouched.
6. **Diagnosis:**
   - Token has not graduated from Meteora DBC bonding curve → Jupiter hasn't indexed yet.
   - OR: Pool was drained to zero liquidity.
   - OR: Jupiter indexer is lagging (rare, usually resolves in 5–15 min).
7. **Skill behavior:** the cron is hourly — if it's a transient Jupiter issue, next hour's cycle will succeed. If it's pre-graduation, the cycle will no-op (or fail-to-quote) until graduation completes.
8. **Operator action:** check DexScreener for the mint's pool. If pool exists and has liquidity but Jupiter won't quote, file a Jupiter support ticket. If pool doesn't exist (pre-graduation), wait.

---

## Troubleshooting

| Error                                                                               | Cause                                                                        | Fix                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runBuybackCycle` returns `{ action: 'noop' }` for many hours despite user payments | Payments are landing in cold (receiver) not hot                              | Confirm your custody pattern — if receiver ≠ hot, you need a sweep step. See CUSTODY_PATTERNS.md Pattern 3.                                                                                                        |
| `hot wallet holds N agent tokens but no open burn_event row`                        | Orphan balance — DB out of sync with chain                                   | Scenario 4. Manual reconciliation row insert.                                                                                                                                                                      |
| `swap output below minimum`                                                         | Pool moved between quote and fill                                            | Scenario 5. Tighten slippage or reduce cycle size; or switch to accept-actual-fill mode.                                                                                                                           |
| `No route available for ... -> ...`                                                 | Token pre-graduation or Jupiter unindexed                                    | Scenario 6. Wait — automatic retry on next cron.                                                                                                                                                                   |
| `Jupiter quote failed: 429`                                                         | Free lite-api rate-limited                                                   | Upgrade to paid `api.jup.ag` with `x-api-key` header.                                                                                                                                                              |
| `burn failed on-chain: InsufficientFunds`                                           | ATA holds less than requested burn amount                                    | Should not happen given Phase 0 recovery uses ATA balance as source of truth. If it does, check whether another process is spending from the hot wallet's ATA concurrently — this skill assumes exclusive control. |
| `signature not confirmed within N blocks`                                           | `lastValidBlockHeight` expired — network congestion                          | Jupiter regenerates `lastValidBlockHeight` per call; re-run the cycle; if persistent, add priority fee by setting `computeUnitPriceMicroLamports` in the swap build.                                               |
| Unexpected spike in SOL outflow from hot                                            | Cron fired faster than cadence suggests                                      | Check for duplicate schedules. Netlify + Vercel crons on the same repo can double-fire.                                                                                                                            |
| Cold wallet balance grows but never sweeps                                          | Sweeps are manual in Pattern 3/4 — this is intentional                       | Schedule a weekly calendar reminder, or migrate to an automated sweep that still requires a multisig signer (Squads supports scheduled transactions in V4).                                                        |
| Invoice payments confirmed but `payment_invoice` row still `pending`                | `verifyInvoiceWithRetries` ran out of retries before the RPC index caught up | Client should retry `/api/pay/verify` after 30s. Or upgrade to a faster RPC. For a permanent fix: Helius Enhanced Webhooks push verification instead of pull.                                                      |
