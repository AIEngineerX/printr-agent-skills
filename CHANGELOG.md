# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `simulateSwap(connection, tx)` in `src/swap/execute.ts` — wraps `connection.simulateTransaction` with `sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true`. Returns `SimulateSwapResult { ok, err, logs, computeUnitsConsumed, innerInstructions, tokenTransferCount }`. Lets adopters validate route resolution + compute cost before enabling a live cron — no SOL spent, no signature required.
- `TOKEN_2022_PROGRAM_ID` exported from `src/payments/constants.ts`. `simulateSwap`'s `tokenTransferCount` covers both classic SPL-Token and Token-2022 — many Printr POB tokens (including $INKED) use the Token-2022 standard.
- **Token-2022 support in `runBuybackCycle`** (`CycleConfig.tokenProgramId`) and `verifySwapOutput` (5th param). Defaults to classic SPL for backwards compatibility; pass `TOKEN_2022_PROGRAM_ID` from `@solana/spl-token` for Token-2022 mints. The flag threads through every ATA-touching call site: `getAssociatedTokenAddress` (ATA PDA derivation uses the program ID as a seed), `getAccount` (account parsing), and `createBurnInstruction` (program dispatch). Omitting it on a Token-2022 mint previously produced the wrong ATA address — `TokenAccountNotFoundError` every cycle on the recovery read, and an on-chain burn failure if somehow a swap landed. **Motivated by $INKED integration**, which is a Token-2022 mint. Any Printr POB token with `owner = TokenzQdB…` on its mint account needs this.
- `scripts/verify-inked-graduation.ts` — Jupiter route classification + pool-depth probes at realistic cycle sizes. Confirms graduation state + slippage feasibility.
- `scripts/dry-run-swap.ts` — one-shot simulated swap against any mint. Parses inner instructions, prints a program-log dump, exits non-zero on program error.
- `scripts/verify-printr-mechanism.ts` — queries Printr's `POST /v1/staking/list-positions-with-rewards` and `POST /v1/telecoin/buyback-burn-detail`. Reports aggregated claimable + claimed staker rewards for a given telecoin. **This is the correct way to verify POB fee distribution is live** — see Corrected below.

### Corrected
- **POB model-1 fee distribution is async, not per-swap.** The README, `printr-tokenized-agent/SKILL.md`, `printr-swap/SKILL.md`, and their SCENARIOS.md companions previously implied a per-swap fee-hook transfer that could be detected in a swap's inner instructions. This was wrong — verified empirically against $INKED on 2026-04-23. POB model-1 tokens accrue fees via Meteora DAMM v2's standard LP-fee accounting, and Printr's SVM program (`T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint`) distributes accumulated SOL to stakers asynchronously. Every POB model-1 swap on-chain looks identical to a plain Meteora DAMM v2 swap. Doc passages + the `possibleFeeHookDetected` field have been removed; `SimulateSwapResult.tokenTransferCount` is retained as a generic route-sanity check with its framing corrected. See `printr-tokenized-agent/SKILL.md` §"How POB Model-1 Fee Distribution Actually Works" for the accurate mechanism.

### Dependencies
- `@neondatabase/serverless` bumped `^0.9.0` → `^1.1.0` (PR #4). Test suite still green against pg-mem; live-Neon validation remains adopter-side per `KNOWN_ISSUES.md`.
- Dev-deps group bumped (PR #3).

## [0.1.0] — 2026-04-23

First tagged release. **Pre-production** — the kit has not yet run a full buyback cycle on a live mainnet integration. Version `0.x` until at least one production cycle lands on the reference implementation ($INKED).

### Skills (this repo)
- `printr-swap` — Jupiter quote / build / execute primitives.
- `printr-agent-payments` — invoice + on-chain memo-match verification.
- `printr-tokenized-agent` — composed buyback + burn cycle with recovery mode.

### Cross-agent compatibility
- Designed to work with any agent CLI that reads YAML skill frontmatter.
- **Claude Code** — tested end-to-end (reference environment).
- **GitHub Copilot CLI** — compatible by design via its `skill` tool; not yet user-verified.
- **Gemini CLI** — compatible by design via `activate_skill`; not yet user-verified.
- **Cursor / rule-based IDEs** — manual: copy SKILL.md body into `.cursor/rules/`, trigger manually.
- **Any TypeScript project** — `src/` importable as a plain library, agent-independent.

### Library (`src/`)
- TypeScript reference implementation for every skill, importable as a module.
- 67 tests covering real code paths: live Jupiter integration, pg-mem Postgres for DB flows, real `@solana/web3.js` Transaction serialization, matcher coverage for SOL + USDC + memo instructions.
- Validations: invalid currency, unknown mint, zero amount, zero duration, slippage bounds all throw.
- Failure-path propagation in `runBuybackCycle` — `{ action: 'failed', stage, error }` is actually reachable.

### Security
- `SECURITY.md` vulnerability policy with private reporting channels.
- `CODEOWNERS` set to `@AIEngineerX`.
- GitHub secret scanning + push protection + Dependabot alerts enabled.
- Known issue: transitive `bigint-buffer` CVE-2025-3194, upstream-abandoned — accepted risk, documented in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).

### Dependencies
- `@solana/web3.js` `^1.98.0`
- `@solana/spl-token` `^0.4.0`
- `@neondatabase/serverless` `^0.9.0`
- `bs58` `^6.0.0`
- `uuid` override to `^14.0.0` — resolves 6 moderate advisories in the transitive tree.

### Known residual vulns (1 advisory, 3 alerts)
- `bigint-buffer@1.1.5` — HIGH, upstream abandoned, see `KNOWN_ISSUES.md`.

## Versioning policy

- `0.x.y` — pre-production. Breaking changes may land on any bump.
- `1.0.0` — cut after at least one production buyback cycle runs successfully on a live consumer.
- Post-1.x — strict SemVer: breaking changes only on major bumps.

Pin to a tag, not to `main`:

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/AIEngineerX/printr-agent-skills.git
```
