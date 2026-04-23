# Treasury Custody Patterns

Four supported patterns for custody of the buyback treasury. Pick based on scale, blast-radius tolerance, and operational overhead. **[derived]** The `printr-tokenized-agent` skill's code is agnostic — the same `runBuybackCycle` works with any of them.

## The two-wallet model (recommended)

Every pattern below uses the **two-wallet model**:

- **Cold wallet** — holds the bulk of accumulated revenue. Never has its private key touch the server that runs the cron. Funded by user payments (if receiver = cold) or by manual sweeps.
- **Hot wallet** — single-signer keypair, private key in server env. Holds only ≤ `BUYBACK_MAX_LAMPORTS` worth of SOL. Signs hourly buybacks + burns. If compromised, blast radius is the hot cap.

The only variable across the four patterns is **what the cold wallet is**. The hot is always the same.

## Blast-radius definition

Blast radius = worst-case SOL lost given a single compromise event. A compromise is any of: server env leaked, Netlify account breached, Postgres dump stolen (if keys were there — they shouldn't be), developer device pwned, social-engineering of signer, private-key git-commit accident.

## Pattern 1 — Single hot key

**Setup**

- One wallet. Private key in `TREASURY_HOT_PRIVATE_KEY` env var.
- `TREASURY_RECEIVER_PUBKEY` = `TREASURY_COLD_PUBKEY` = this same wallet's pubkey.
- No cold storage.

**Blast radius** = **entire treasury**, including all unswept user revenue.

**When it's OK**

- Prototyping only. Single-digit SOL in flight. Expected lifetime < 2 weeks.
- You accept that a compromise drains everything.

**When it's not OK**

- Any production deployment.
- Any treasury that has exceeded ~10 SOL in accumulated revenue.

## Pattern 2 — Two-key role separation (poor-man's multisig)

**Setup**

- Two wallets, both private keys on the same server.
- **Receiver** (`TREASURY_RECEIVER_PRIVATE_KEY`) — users pay INTO this. Only sweeps to hot on schedule (scripted).
- **Operator hot** (`TREASURY_HOT_PRIVATE_KEY`) — executes swaps + burns. Funded by receiver sweeps.

**Blast radius** = **both wallets combined**, because a server compromise exposes both env vars.

**Mild improvement over Pattern 1:**

- Store the two keys in different secret backends (Netlify env for hot; Doppler / 1Password Connect / AWS Secrets Manager for receiver). Now a compromise needs to breach two systems.
- Or: run the sweep script from a separate GitHub Actions runner using an entirely different IAM scope. Attacker now needs to breach both the prod Netlify AND your GitHub org.

**When it's OK**

- Small prod deployment (< 50 SOL monthly revenue).
- You have separate secret backends genuinely enforcing different trust boundaries.

**When it's not OK**

- Both keys in the same `.env` or the same Netlify project's env. You haven't actually gained anything over Pattern 1.
- Anyone who tells you this counts as "multisig." It doesn't. Multisig is on-chain.

## Pattern 3 — Squads Pro + capped hot (RECOMMENDED default)

**Setup**

- **Cold** = Squads Pro (Personal Vault). On-chain smart wallet. Single-user, with optional social recovery (backup signer you trust) and Ledger support. Docs: `squads.so`.
  - Receives user payments directly OR receives periodic sweeps from a mailbox pattern.
  - `TREASURY_COLD_PUBKEY` = Squads vault address.
- **Hot** = standard ed25519 keypair. Private key in `TREASURY_HOT_PRIVATE_KEY` env. Capped at `BUYBACK_MAX_LAMPORTS`.
- **Sweep** = manual. Once per week (or when hot dips below threshold), you open Squads, approve a transfer of `N × BUYBACK_MAX_LAMPORTS` to the hot. Human-in-the-loop.

**Blast radius** = **`BUYBACK_MAX_LAMPORTS` plus current hot balance**. Typical = 1–2 SOL. Cold is protected by Squads' on-chain logic + your recovery signer.

**Overhead**

- Setup: ~10 minutes (Squads account + vault creation).
- Operation: ~1 min/week to approve a sweep.

**Why this is the default recommendation**

- Near-zero key-theft risk on the bulk.
- Automation still works (hot runs the cron unattended).
- You keep full self-custody — no platform can freeze or seize.
- Recovery if hot is compromised: drain hot, rotate key, resume.

## Pattern 4 — Squads V4 multisig + capped hot

**Setup**

- **Cold** = Squads V4 Multisig (2-of-2, 2-of-3, or 3-of-5 depending on your team). Same Squads platform, but _multiple_ signers required for any outgoing tx.
  - `TREASURY_COLD_PUBKEY` = multisig vault address.
- **Hot** = same as Pattern 3.
- **Sweep** = requires quorum approval. Slower.

**Blast radius** = **`BUYBACK_MAX_LAMPORTS` plus current hot balance.** Cold is protected by the multisig — a single compromised signer device doesn't drain.

**Overhead**

- Setup: ~30 minutes (create multisig, invite signers, test).
- Operation: every sweep requires quorum. If signers are distributed across time zones, sweeps can take hours of calendar time.

**When this is better than Pattern 3**

- Multi-person team. Any single team member's laptop being stolen cannot drain the treasury.
- Treasury size justifies the overhead (roughly > 100 SOL in cold).
- You want explicit multi-party audit trail for governance reasons.

**When Pattern 3 beats this**

- Solo operator. You're the only signer. 2-of-2 with yourself-on-two-devices helps a little against single-device loss, but Squads Pro + Ledger as recovery already handles that case more ergonomically.

## Comparison table

| Pattern               | Cold mechanism                      | Blast radius          | Setup time | Sweep cadence       | Recommended for               |
| --------------------- | ----------------------------------- | --------------------- | ---------- | ------------------- | ----------------------------- |
| 1. Single hot         | None                                | Entire treasury       | 0 min      | N/A                 | Prototype only                |
| 2. Role separation    | Second env-var wallet               | Both wallets combined | 30 min     | Scripted, automatic | Small prod; not real multisig |
| 3. Squads Pro         | On-chain smart wallet with recovery | Hot cap only          | 10 min     | Manual, weekly      | **Default — solo operator**   |
| 4. Squads V4 multisig | On-chain M-of-N multisig            | Hot cap only          | 30 min     | Manual, quorum      | Teams; large treasuries       |

## The choice is not permanent

You can migrate between patterns without changing skill code. The skill reads `TREASURY_HOT_PRIVATE_KEY` and `TREASURY_COLD_PUBKEY` and treats them as opaque. Migrate by:

1. Create new cold wallet per the new pattern.
2. Sweep old cold → new cold (requires old cold's signer).
3. Update `TREASURY_COLD_PUBKEY` env var.
4. If `TREASURY_RECEIVER_PUBKEY` also changed, update users' deposit instructions and any on-chain/off-chain display.
5. Hot wallet unchanged across migrations.

## Anti-patterns (do not do any of these)

- **Storing the cold private key on the server "just for emergencies."** The whole point of cold is that the server cannot access it. If the server has the key, you don't have cold — you have Pattern 1 with extra steps.
- **Using the same key for `TREASURY_RECEIVER_PUBKEY` and `TREASURY_HOT_PRIVATE_KEY`.** User funds land in the hot wallet instantly, breaking the cap. At minimum use Pattern 2; prefer Pattern 3.
- **Committing any of these keys to git.** Even accidentally, even in a config file meant to be "example only." The keys are worth real money the moment they're created.
- **Accepting an authority-handoff from any third-party contract.** Authority-gated operations are one-way doors. There is at least one documented case of a dev wallet permanently losing buyback-configuration authority to a third-party launchpad's authority contract — only the protocol's support desk could even theoretically reverse it. If a protocol asks you to hand over authority, assume you lose it forever.
- **Skipping the hot-wallet cap.** The cap is the only thing bounding blast radius in Patterns 3 and 4. A cron bug + uncapped hot = entire cold drained at next cycle.

## External references

- Squads Pro: `squads.so/personal`
- Squads V4 Multisig: `squads.so`
- Squads security model: `docs.squads.so`
- Solana Labs on hot/cold separation: `solana.com/developers/guides/security` (general Solana guidance)
