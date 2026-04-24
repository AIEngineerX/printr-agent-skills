# Threat Model

## Assumptions

Every threat is analyzed assuming:

1. The adopter runs kit code unmodified except for config.
2. The RPC at `SOLANA_RPC_URL` is honest. A compromised RPC is treated separately below.
3. The adopter uses a custody pattern from `printr-tokenized-agent/references/CUSTODY_PATTERNS.md` — at least Pattern 2.
4. The adopter has rate-limiting in front of the invoice-creation endpoint. The kit does not provide it.

## In-scope threats — the kit mitigates

### Invoice replay

**Attack**: attacker captures a paid invoice's `{memo, amount, user_wallet, start_time, end_time}` tuple and re-submits.

**Mitigation**:

- Memo is 63-bit cryptographically random, server-generated.
- DB `UNIQUE` on memo + `UPDATE ... WHERE status='pending'` returns `rowCount=0` for the second caller.
- Time-window filter rejects signatures outside `[start_time - 60s, end_time + 300s]`.
- Amount, source, destination must match exactly.

**Tests**: `tests/pentest.test.ts` — pre-start-time, post-end-time, attacker-as-source.

### Treasury spoofing

**Attack**: attacker crafts a tx routing SOL to an attacker-controlled destination.

**Mitigation**: the verifier only scans `ctx.treasuryPubkey`. Txs to any other address never enter the candidate set.

**Tests**: `tests/pentest.test.ts` — "tx to wrong treasury is filtered".

### Partial-fill / slippage bust

**Attack**: pool moves between quote and fill; swap confirms but delivers less than expected.

**Mitigation**: `verifySwapOutput` reads the ATA balance after confirmation and throws `SwapBelowMinimumError` if below `quote.otherAmountThreshold`. `startCycle` catches the typed error and flips the `burn_event` row to `status='failed'` with the error message recorded — the partial fill stays in the ATA but is **not** auto-burned; operator review is required (see `tokenized-agent/references/SCENARIOS.md` Scenario 5 for the reconciliation path).

### Post-swap RPC read failure

**Fault**: swap confirms on-chain; the subsequent ATA read inside `verifySwapOutput` fails for transport reasons (timeout, 5xx, connection reset) — distinct from a slippage bust because the on-chain state is unknown to the caller.

**Mitigation**: `startCycle` writes the `burn_event` row with `status='swap_done'` immediately after swap confirmation, **before** the ATA re-read. A thrown non-`SwapBelowMinimumError` leaves the row in place; next tick, `findRecoveryCycle` sees the non-zero ATA balance, finds the open row, and burns the actual (now-readable) amount.

### Swap-succeeds-burn-fails

**Fault**: swap confirms; burn tx fails. Without recovery, tokens sit in the hot ATA forever.

**Mitigation**: `runBuybackCycle` writes the `burn_event` row with `status='swap_done'` immediately after swap confirmation. Next tick, `findRecoveryCycle` sees non-zero ATA balance, finds the open row, burns.

### Malformed RPC data

**Fault**: RPC returns a tx with malformed base58 in memo data.

**Mitigation**: `instructionIsMemo`'s raw-form decode is wrapped in try/catch. One bad tx cannot crash the verifier for subsequent calls.

**Tests**: `tests/pentest.test.ts` — "returns false on malformed base58 data".

### Unknown AMM venue

**Fault**: Meteora renames the AMM label. `getPoolState` returns `'unknown'`.

**Mitigation**: use `getPoolStateOrThrow`, which raises with the observed label.

## Adopter-layer threats — the kit cannot mitigate

### Session fixation via `user_wallet`

**Attack**: if your `/api/pay/invoice` accepts `user_wallet` as a client-supplied parameter without authenticating the session, an attacker creates an invoice bound to their own wallet, pays it themselves, and triggers a credit delivery in the victim's session.

**Your responsibility**: bind `user_wallet` to the authenticated session:

1. Issue `session_id` as an HTTP-only cookie.
2. Require the client to produce an ed25519 signature over `session_id` with the wallet's private key.
3. Verify server-side; only then accept `publicKey` as the session's bound wallet.
4. Use `user_wallet = session.bound_wallet` when creating the invoice.

The core idea: `user_wallet` must come from the server's authenticated session state, never from a request body or query parameter. If your framework is SvelteKit / Next.js / Express, put the signature-verification step in a route-level middleware that runs before any handler under your `/api/pay/*` namespace.

### Rate limiting / DoS on invoice creation

**Your responsibility**: put a rate limiter (per-session, per-IP) in front of `/api/pay/invoice`. The kit does not throttle.

### Key custody

**Your responsibility**: `CUSTODY_PATTERNS.md`. The kit reads `TREASURY_HOT_PRIVATE_KEY` from env; how it's populated, rotated, audited is out of scope.

### RPC compromise

**Attack**: the RPC is MITM'd and returns crafted data.

- A hostile RPC can return a malformed buffer that exploits `bigint-buffer` CVE during SPL account deserialization (see `KNOWN_ISSUES.md`).
- A hostile RPC can return a fake signature list that passes the matchers for a tx that never actually landed.

**Your responsibility**: use a paid RPC you trust, or self-host. The verifier's correctness is bounded by RPC honesty — true of every on-chain client, no way around it short of running a full validator or cross-checking multiple RPCs.

## Out of scope

- Bugs in `@solana/web3.js`, Jupiter API, Printr on-chain program, Meteora pools.
- Solana network reliability.
- Business-logic attacks against consumer apps built on top of the kit (the adopter's agent endpoints, paid-action gating logic, session handling, etc.).
- Social engineering of signers.
- Quantum attacks on ed25519.
