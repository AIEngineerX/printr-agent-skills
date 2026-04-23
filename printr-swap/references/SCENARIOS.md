# Scenario Tests — printr-swap

Five scenarios. Run each against a **small** amount (0.001 SOL) first to exercise the code path without material cost.

## Scenario 1: Happy Path — Graduated Pool, Buy

1. Token `X` has graduated to Meteora DAMM v2. Jupiter indexes it.
2. Caller invokes `quoteSwap({ inputMint: SOL, outputMint: X, amount: 1_000_000n, slippageBps: 100 })`.
3. `JupiterQuote.routePlan[0].swapInfo.label` includes `"Meteora DAMM v2"`. `outAmount` is populated; `priceImpactPct` < 1%.
4. Caller builds tx with `buildSwapTransaction`, user signs, `executeUserSwap` submits.
5. After confirmation, `verifySwapOutput(X, userPubkey, BigInt(quote.otherAmountThreshold))` returns a non-zero `amount`.
6. Done — ATA now holds token X.

## Scenario 2: Bonding-Curve Warning — Pre-Graduation

1. Token `Y` is freshly launched on Printr — still on the Meteora DBC bonding curve, not yet graduated.
2. Caller invokes `quoteSwap(...)`.
3. `routePlan[0].swapInfo.label` contains `"DBC"`.
4. **Expected:** caller sees the bonding-curve label, emits a warning "POB fees are not active on this token yet — buybacks here do NOT pay stakers," and either aborts or proceeds knowing the flywheel is inactive.
5. If proceeding: the swap still works — Jupiter routes through DBC — but the caller has explicitly acknowledged the gap.

## Scenario 3: Server-Signed Buyback — Automated Cycle

1. Scheduled cron invokes `runBuybackCycle` (from `printr-tokenized-agent`).
2. Cycle loads `TREASURY_HOT_PRIVATE_KEY` via `loadHotKeypair()`. Reads hot balance; threshold met.
3. `quoteSwap({ inputMint: SOL, outputMint: AGENT_TOKEN_MINT, amount: hotBalance - fees, slippageBps: 100 })`.
4. `buildSwapTransaction({ quote, userPublicKey: hotKeypair.publicKey })` returns a VersionedTransaction.
5. `executeServerSwap(connection, tx, lastValidBlockHeight, hotKeypair)` signs and submits. Returns signature on confirmation.
6. `verifySwapOutput(AGENT_TOKEN_MINT, hotKeypair.publicKey, BigInt(quote.otherAmountThreshold))` confirms the ATA received the minimum.
7. Downstream: SPL burn of the full received amount. See `printr-tokenized-agent/SKILL.md`.

## Scenario 4: Route Unavailable — Un-Indexed Token

1. Token `Z` exists on-chain but Jupiter has not indexed its curve/pool (happens for tokens in the first few minutes after deployment).
2. `quoteSwap` returns `{ routePlan: [] }` → the helper throws `"No route available for SOL -> Z"`.
3. **Expected caller behavior:** do not retry immediately. Either wait 1–5 minutes and retry, or skip this cycle and log — Jupiter's indexer has a propagation delay.
4. If the cycle is mission-critical: call Meteora's pool API directly as a fallback. Out of scope for this skill.

## Scenario 5: Output Below Minimum — Slippage Bust

1. Buyback cycle runs. Quote `otherAmountThreshold` = 250,000,000,000 (250 tokens).
2. Pool liquidity drops between quote and swap submission (common under high volatility).
3. Swap confirms, but fills at 200,000,000,000 — 20% worse than quoted.
4. `verifySwapOutput` throws `"swap output below minimum: got 200000000000, expected >= 250000000000"`.
5. **Expected caller behavior:** this is a deliberate failure — the tx still went through on-chain (tokens are in the ATA, just less than expected). The caller treats the cycle as partially completed:
   - Record the actual `amount` received in `burn_event` with a `status='slippage_bust'` flag.
   - Burn the actual received amount (not the quoted amount).
   - Do not retry the swap — next cycle will pick up from the new hot balance.

---

## Troubleshooting

| Error                                         | Cause                                                                  | Fix                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Jupiter quote failed: 429 Too Many Requests` | Free lite-api hit rate limit                                           | Add backoff (30s); for production traffic, upgrade to paid `api.jup.ag` with `x-api-key` header                                                                          |
| `No route available for ... -> ...`           | Token un-indexed or all pools drained                                  | Wait 1–5 min for Jupiter indexer; if persistent, check DexScreener for pool existence                                                                                    |
| `Jupiter returned wrong output mint`          | Someone tampered with the quote response, or you passed the wrong mint | Re-check the `outputMint` param; NEVER submit a swap tx whose output mint differs from your target                                                                       |
| `swap output below minimum`                   | Pool moved between quote and fill                                      | Expected under volatility; record actual received amount and proceed with reduced output                                                                                 |
| `swap failed on-chain: InsufficientFunds`     | Hot wallet drained below cycle size                                    | Sweep from cold; or cap `BUYBACK_MAX_LAMPORTS` lower                                                                                                                     |
| `signature not confirmed within ... blocks`   | `lastValidBlockHeight` expired                                         | Re-build + re-submit; Jupiter's swap-build TTL is ~60–150 slots                                                                                                          |
| `TREASURY_HOT_PRIVATE_KEY not set`            | Running server-signed path without env var                             | Either supply the key or use the user-signed path                                                                                                                        |
| `expected 64-byte secret, got 32`             | Key stored as seed, not full secret                                    | bs58-decode full keypair export from Solana CLI: `solana-keygen pubkey --outfile /tmp/key.json; cat key.json` returns an array — convert to base58 before putting in env |
