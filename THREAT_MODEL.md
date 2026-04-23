# Threat Model

What this kit protects against, what it relies on the adopter to protect against, and what's explicitly out of scope.

## Assumptions

Every threat listed below is analyzed under the following assumptions. If your environment breaks one, re-evaluate.

1. The adopter's server runs code this kit ships, unmodified except for config.
2. The RPC endpoint at `SOLANA_RPC_URL` is honest — it returns signatures and parsed transactions that actually landed on chain. A compromised RPC is treated separately below.
3. The adopter uses a custody pattern from `printr-tokenized-agent/references/CUSTODY_PATTERNS.md` — specifically at least Pattern 2 (no raw keys in the same env as user input).
4. The adopter has rate-limiting in front of the invoice-creation endpoint. The kit does not provide it.

## In-scope threats — the kit mitigates

### Invoice replay

**Attack**: attacker captures a paid invoice's `{memo, amount, user_wallet, start_time, end_time}` tuple and attempts to re-submit.

**Mitigation**:

- Memo is 63-bit cryptographically random, generated server-side. Not guessable, not chosen by the client.
- DB `UNIQUE` constraint on memo + `UPDATE ... WHERE status='pending'` returns `rowCount=0` on the second caller.
- Time-window filter rejects any signature outside `[start_time - 60s, end_time + 300s]`.
- Amount, source, and destination must match exactly. A replay with wrong values fails silently.

**Test coverage**: `tests/pentest.test.ts` — pre-start-time, post-end-time-with-grace, attacker-as-source.

### Treasury spoofing

**Attack**: attacker crafts a tx that looks like the expected payment but routes SOL to an attacker-controlled destination.

**Mitigation**: the verifier pulls signatures from `ctx.treasuryPubkey` (the configured treasury). Transactions to any other address never enter the candidate set. The attacker's tx is invisible to our scan.

**Test coverage**: `tests/pentest.test.ts` — "tx to wrong treasury is filtered".

### Partial-fill / slippage bust

**Attack**: pool moves between quote and fill, swap confirms but delivers less than expected output.

**Mitigation**: `verifySwapOutput` reads the ATA balance after swap confirmation and throws if below `quote.otherAmountThreshold`. The orphan balance is then picked up by `findRecoveryCycle` on the next cron tick.

### Swap-succeeds-burn-fails

**Attack / fault**: swap confirms; burn tx fails (RPC timeout, CU exceeded, etc.). Without recovery, tokens sit in the hot ATA forever.

**Mitigation**: `runBuybackCycle` writes the `burn_event` row with `status='swap_done'` immediately after swap confirmation. On the next tick, `findRecoveryCycle` sees a non-zero ATA balance, finds the open row, and burns.

### Malformed RPC data

**Attack / fault**: RPC returns a tx with malformed base58 in the memo data field.

**Mitigation**: `instructionIsMemo`'s raw-form decode is wrapped in try/catch. A single bad tx in treasury history cannot crash the verifier for subsequent calls.

**Test coverage**: `tests/pentest.test.ts` — "returns false on malformed base58 data".

### Unknown AMM venue

**Attack / fault**: Meteora renames the AMM label Jupiter reports. `getPoolState` returns `'unknown'`.

**Mitigation**: buyback cron should use `getPoolStateOrThrow`, which raises with the observed label — fail loudly rather than trade into an unclassified venue.

## Adopter-layer threats — the kit cannot mitigate

### Session fixation via `user_wallet` parameter

**Attack**: the verifier matches on the `user_wallet` stored in the invoice row. If your `/api/pay/invoice` endpoint accepts `user_wallet` as a client-supplied parameter without authenticating the session, an attacker can create an invoice bound to their own wallet and pay it themselves to trigger a credit delivery in the victim's session.

**Your responsibility**: bind `user_wallet` to the authenticated session, not to a client-supplied field. Standard pattern:

1. Issue a `session_id` as an HTTP-only cookie.
2. Require the client to produce an ed25519 signature over the `session_id` using the wallet's private key.
3. Verify the signature on the server; only then accept `publicKey` as the session's bound wallet.
4. Store `user_wallet = session.bound_wallet` when creating the invoice.

The INKED reference implementation at `src/routes/api/ink/session-resolve.ts` demonstrates this pattern.

### Rate limiting / DoS on invoice creation

**Attack**: attacker floods `/api/pay/invoice` to fill the DB.

**Your responsibility**: put a rate limiter (per-session, per-IP, or both) in front of the endpoint. The kit generates invoices on request; it does not throttle.

### Key leakage / custody

**Your responsibility**: everything in `CUSTODY_PATTERNS.md`. The kit reads `TREASURY_HOT_PRIVATE_KEY` from env; how that env gets populated, rotated, and audited is out of scope.

### RPC compromise

**Attack**: the RPC endpoint configured in `SOLANA_RPC_URL` is MITM'd, returns crafted data to influence the verifier.

**Your responsibility**: use a paid RPC from a provider you trust, or self-host. Specifically:

- A hostile RPC could return a malformed buffer that exploits the unfixed `bigint-buffer` CVE during SPL account deserialization (see `KNOWN_ISSUES.md`).
- A hostile RPC could return a fake signature list that passes the memo + transfer matchers for a tx that never actually landed — the kit cannot distinguish this from a real landing because it trusts the RPC.

The honest framing: **the verifier's correctness is bounded by RPC honesty**. This is true of every on-chain-reading client; there's no way around it short of running a full validator or cross-checking against multiple RPCs.

### Pre-graduation buybacks

**Non-attack**: buying a Printr POB token via Jupiter while it's still on the Meteora DBC bonding curve does not pay staking-pool fees (POB model is inactive pre-graduation). This isn't a bug; it's documented. `getPoolStateOrThrow` surfaces the state before you proceed.

## Out of scope

- Bugs in `@solana/web3.js`, Jupiter's API, Printr's on-chain program, Meteora pools.
- The reliability of the underlying Solana network.
- Business-logic attacks against specific consumer applications (e.g. $INKED's agent endpoints).
- Social engineering of signers.
- Quantum attacks on ed25519.

## Reporting

If you believe you've found a threat the kit should mitigate that it doesn't, see `SECURITY.md` for the reporting channel.
