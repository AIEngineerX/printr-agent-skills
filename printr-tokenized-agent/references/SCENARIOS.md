# Scenario Tests — printr-tokenized-agent

Eight end-to-end scenarios covering the composed loop. Each walks through `runBuybackCycle` with a specific starting state. **[pattern]** Run **Scenario 7 (dry-run) first** against the real mint before flipping `BUYBACK_DRY_RUN=false` and touching any live SOL.

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

## Scenario 7: Dry-Run — First Cycle Against a New Mint

1. Operator deploys with `BUYBACK_DRY_RUN=true`. Hot wallet funded with enough SOL to exceed threshold (e.g. 0.3 SOL).
2. Cron fires. `runBuybackCycle({ dryRun: true })` invoked.
3. Phase 0 (`findRecoveryCycle`) is **skipped** under dry-run — no ATA read, no DB read. Dry-run does not branch into recovery work.
4. Phase 1 equivalent: reads hot balance, applies threshold check, calls `quoteSwap(SOL → AGENT, amountIn, slippageBps=100)` normally. Quote returns `outAmount` + `otherAmountThreshold` as in a real quote.
5. Instead of `executeServerSwap`, calls `simulateSwap(connection, tx)` from `printr-swap`. Solana RPC returns a `SimulatedTransactionResponse` with `err: null`, `innerInstructions: [...]`, `unitsConsumed: ~56000–120000` (typical range for a Jupiter route through Meteora DAMM v2).
6. Burn tx is built with the simulated output amount and simulated. Expected: `burn.simulatedErr` is non-null (token-balance error) — the hot ATA doesn't actually hold the simulated-swap output. This is NOT a failure; the `'dry_run'` result surfaces it so the caller can verify the burn instruction shape and CU cost.
7. **No DB writes.** `burn_event` table untouched. Subsequent live cycles will not see dry-run artifacts.
8. Returns `{ action: 'dry_run', solIn, expectedBought, wouldBurn, swap: { simulatedErr: null, computeUnitsConsumed, tokenTransferCount }, burn: { simulatedErr: {...}, computeUnitsConsumed } }`.
9. **Operator checks:**
   - `swap.simulatedErr === null` — the swap would land.
   - `expectedBought` close to `otherAmountThreshold` — fill quality will be acceptable.
   - `swap.computeUnitsConsumed < 200000` — under Jupiter's default CU ceiling.
   - Burn simulation's instruction shape looks correct in the logs (invokes the SPL Token Program's `burn` ix on the expected mint).
   - All green → `BUYBACK_DRY_RUN=false` + wait one hour for the first live cycle.
10. **What dry-run does NOT check:** whether Printr POB distribution is live for this telecoin. That's a separate read — `scripts/verify-printr-mechanism.ts` against Printr's API. Run that before spending engineering effort on the loop.

## Scenario 8: POB Mechanism Check Before First Cycle

This is a **separate** check from the dry-run above — different signal, different proof path.

1. Before touching any SOL, operator runs `npx tsx scripts/verify-printr-mechanism.ts <TELECOIN_ID>`.
2. The script queries `POST /v1/staking/list-positions-with-rewards` and `POST /v1/telecoin/buyback-burn-detail` against `api-preview.printr.money`. Reports aggregated claimable + claimed rewards for the telecoin.
3. **Green signal:** non-zero `Σ claimable quote` and/or `Σ claimed quote` across all positions. Mechanism is actively distributing; real stakers have received real SOL.
4. **Yellow signal:** positions exist but rewards are zero. Either no post-graduation trading volume yet, or the distribution job has not fired since stakes began. Buybacks will still work mechanically; they just may not surface rewards until volume builds.
5. **Red signal (don't proceed):** 0 positions returned. Without stakers the POB mechanism has nothing to distribute to. Buybacks will still reduce supply, but the "contribute to fees that stakers draw from" half of the loop is inert. Decide whether to proceed on supply-reduction alone.
6. Note on `buyback-burn-detail`: this endpoint returns `400 telecoin does not have buyback and burn fee sink` for POB model-1 tokens — Printr only tracks its own Fee Model #3 buybacks, not third-party kit-driven buybacks. This is **expected** on model-1, not a failure. Solscan remains canonical source of truth for your cycles' burn txs.

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
| Dry-run returns `burn.simulatedErr` with "insufficient funds" or similar             | Expected — the hot ATA hasn't received the simulated swap output             | Not a failure. The burn-sim error surfaces instruction shape + CU cost for inspection. Ignore the error class, look at `computeUnitsConsumed` and whether the burn program ID matches SPL Token / Token-2022.       |
| `verify-printr-mechanism.ts` reports 0 positions for a supposedly POB model-1 telecoin | Token may not be POB model-1, or no stakers yet                              | Cross-check the fee model on Printr's gitbook / app dashboard. If POB is correct but zero stakers, the buyback loop will still burn supply but the staker-distribution half is inert until someone stakes.          |
| `buyback-burn-detail` returns `400 telecoin does not have buyback and burn fee sink` | Expected on POB model-1 — this endpoint is only for Printr's Fee Model #3    | Not a failure. This kit's buybacks are tracked by Solscan, not by Printr's API, for model-1 tokens.                                                                                                                |
