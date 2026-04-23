# Scenario Tests — printr-agent-payments

Five scenarios, directly parallel to `pump-fun-skills/tokenized-agents/SCENARIOS.md` with the one-item-per-scenario structural match **[pump.fun]**, adapted for the hand-rolled memo-match verification path.

## Scenario 1: Happy Path — Pay and Verify

1. Agent calls `createInvoice({ session_id: 'sess-abc', user_wallet: <USER>, currency: 'USDC', price_smallest_unit: 1_000_000n, purpose: 'deep_analysis' })`.
2. Server generates memo `9842315678` (random), inserts `payment_invoice` row with `status='pending'`, builds a tx containing a memo instruction with data `"9842315678"` and a `transferChecked` instruction for 1,000,000 atomic USDC from the user's ATA to the treasury's ATA.
3. Server returns `{ transaction: <base64>, invoice: { memo: '9842315678', ... } }`.
4. Client deserializes, `signTransaction` prompts the user, submits. Tx confirms.
5. Client POSTs `{ memo: '9842315678' }` to `/api/pay/verify`.
6. Server calls `verifyInvoiceOnChain({ memo: 9842315678n })`:
   - Loads row, status is 'pending'
   - `getSignaturesForAddress(treasury, { limit: 200 })` returns a list including the user's just-submitted signature
   - `getParsedTransactions(...)` batch-fetches
   - Matches: memo instruction data = "9842315678", transferChecked from user's ATA, 1,000,000 USDC, destination ATA = treasury's USDC ATA, blockTime in window
   - Returns `{ paid: true, tx_sig, blockTime }`
7. Server `UPDATE payment_invoice SET status='paid', tx_sig=..., paid_at=now() WHERE memo=$1 AND status='pending'` — rowCount = 1.
8. Returns `{ paid: true }` to the client. Client is granted the paid action.

## Scenario 2: Verify Before Payment — Returns Unpaid

1. Agent creates invoice with `memo=5555`, `amount=500_000` (0.5 USDC), `end_time` = now + 3600.
2. Client does NOT submit the payment — closes tab.
3. 30 seconds later, client (or a retry bot) POSTs `/api/pay/verify { memo: 5555 }`.
4. `verifyInvoiceOnChain` loads row (status='pending'), scans treasury sigs, finds no matching tx.
5. `verifyInvoiceWithRetries` tries 10 × 2s = 20s of retries; all miss.
6. Returns `false`. Server returns `{ paid: false, reason: 'not_found' }` to client.
7. Agent tells user "payment not confirmed — retry after paying." **[pump.fun]**

## Scenario 3: Duplicate Payment — DB + On-Chain Rejection

1. Agent creates invoice `memo=7777`. User pays successfully. `verifyInvoiceWithRetries` returns `true`. Row flipped to `status='paid'`.
2. Attacker replays the same signed tx (no change to memo or amount).
3. Solana rejects at the RPC level — the blockhash used in the original tx has expired AND the signature is a duplicate (same `tx_sig` the RPC already saw).
4. Even if by some unusual timing the duplicate slips through on-chain: `verifyInvoiceOnChain` loads row, sees `status='paid' AND tx_sig` populated, returns `{ paid: true, tx_sig: <original> }` — the verification is idempotent and does not re-credit. **[derived]**
5. Second `UPDATE ... WHERE status='pending'` returns rowCount=0 — no double-delivery.

## Scenario 4: Mismatched Parameters — Wrong Amount

1. Agent creates invoice `memo=555, amount=1_000_000` (1 USDC).
2. Attacker builds their own tx with memo `"555"` and amount `500_000` (0.5 USDC), paying half price.
3. Tx confirms on-chain with the correct memo.
4. `verifyInvoiceOnChain` loads the row (expected amount 1_000_000). Walks candidates:
   - Candidate tx: memo matches ✓, transferChecked amount = 500_000 ✗ (expected 1_000_000)
   - No match → `paid: false, reason: 'not_found'`
5. Agent does NOT deliver the service. Attacker's SOL/USDC is still in the treasury (this is a feature — they paid, but for a non-existent invoice). The treasury operator can sweep, refund, or ignore at their discretion.

## Scenario 5: Expired Invoice — Time Window Rejected

1. Agent creates invoice `memo=8888` with `start_time = 1700000000, end_time = 1700003600` (1-hour window).
2. User pays 2 hours later.
3. Transaction confirms on-chain.
4. `verifyInvoiceOnChain` loads row. `now > end_time + 300` → returns `{ paid: false, reason: 'expired' }` WITHOUT scanning RPC.
5. Even if `/api/pay/verify` is called during the window: scan filter rejects the signature (blockTime > end_time + 300), and matching fails.
6. Server returns `{ paid: false }` to client. Agent asks user to create a new invoice.

**Edge case — grace window:** We allow `+300` seconds past `end_time` to absorb RPC propagation lag. Real-world: an invoice created at T=0 with a 60s window can still verify up to T+360 if the user signed quickly but the RPC indexer took 5 min to surface the tx. Without the grace, a legitimately-paid invoice would be rejected.

---

## Troubleshooting

| Error | Cause | Fix |
| --- | --- | --- |
| `verifyInvoiceOnChain` returns `{ paid: false, reason: 'not_found' }` but user says they paid | Tx still confirming, or client's wallet sent to a different treasury | Wait 2–5s and retry. Confirm `TREASURY_RECEIVER_PUBKEY` matches what the client tx targets. Use Solana Explorer to check sigs on treasury and verify the memo is exactly `memo.toString()` with no prefix/suffix. |
| `verifyInvoiceOnChain` returns `'expired'` immediately | Invoice `end_time` is in the past (plus 300s grace) | Generate a new invoice. Check `INVOICE_TTL_SECONDS` — default 86400 should be plenty. |
| DB insert fails with `duplicate key value violates unique constraint` on `memo` | Astronomical collision (1 in 2^63 per call) OR memo was reused manually | Regenerate with `generateInvoiceParams` and retry. Never re-use memos across invoices. |
| `getSignaturesForAddress` returns `429 Too Many Requests` | Free-tier RPC rate limit | Back off 30s. If persistent, upgrade to paid RPC OR switch to Helius Enhanced Webhook push model (see `printr-eco`). |
| `transferChecked` missing from parsed tx | RPC returned un-parsed tx (raw instruction data) | Most RPCs support `jsonParsed` encoding by default. If yours doesn't, set `encoding: 'jsonParsed'` on `getParsedTransactions`, or decode the raw instruction data manually. |
| Payment succeeded but `/api/pay/verify` always returns unpaid | Treasury ATA mismatch — you're looking for a USDC transfer to the wrong ATA | Check that `primeTreasuryAtaCache()` was called at server boot. Verify that `TREASURY_RECEIVER_PUBKEY` owns the USDC ATA the client tx targets. Solana Explorer → Treasury wallet → Tokens tab. |
| Memo instruction data doesn't decode to expected string | `createMemoInstruction` was called with base64 or hex instead of the decimal string | Use `memo.toString()` (base 10) — that's what `instructionIsMemo` expects. |
| Invoice marked paid but client never received confirmation | Race between two `/api/pay/verify` calls | The `UPDATE ... WHERE status='pending'` only affects one row; the second call sees row already paid and the code path returns the cached tx_sig. Client just needs to re-fetch invoice status. |
