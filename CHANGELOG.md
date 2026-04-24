# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-04-24

**First production cycle lands.** `runBuybackCycle` executed its first
live mainnet run against a graduated Token-2022 POB telecoin on
2026-04-24 — supply verifiably reduced. Solscan: [swap](https://solscan.io/tx/qDQwNKVqsSbZLL4JZ7QwSy2y9oPtHx5wXCkLnfsDCCAESLf2kW2fqZDLRo8BCp6z9rFnXnpgPhCh3LxRJj5613E), [burn](https://solscan.io/tx/5pvuDM4dcPJf3mff57uSvLUQrWBTB2Jp3bvfPtSKA9oohnGQh5ZLtenMsB2JsaaWuMSfpM9pBG4TLkXXjMKNMyZz).

### Maturity status

- `runBuybackCycle` + `tokenProgramId` + `simulateSwap`: **Production-verified** — see the live-cycle Solscan links above.
- `autoClaim` (new in 0.2.0): **Preview** — code complete, unit-tested, not yet run live. Widens blast radius — see `printr-tokenized-agent/SKILL.md` §Funding sources before enabling.
- `printr-agent-payments` skill: **Unproven in production** — 96 unit tests pass, no live invoice-flow verified end-to-end.
- Recovery mode: unit-tested, not triggered in production yet.

### Breaking / adoption-relevant

- **Package now ships a compiled `dist/`** and `main`/`exports` point at `./dist/index.js` + `./dist/<subpath>/index.js`. Previously `main` was the raw `./src/index.ts`, which broke bundlers that don't transform `.ts` files from `node_modules` (observed: Netlify Edge Functions / Deno, some Cloudflare Workers configs). Node-runtime hosts (Netlify Functions, Vercel, Railway, Fly, AWS Lambda, plain Node) now import cleanly without any bundler gymnastics.
- **`src/` still ships** alongside dist, and the `prepare` npm script rebuilds dist on `npm install` from a git URL — adopters can modify src and reinstall without committing dist themselves.
- **`CycleConfig` gained optional fields** across 0.1 → 0.2: `tokenProgramId`, `autoClaim`. Not breaking for existing adopters (both default sensibly), but classic-SPL adopters should now explicitly set `tokenProgramId: TOKEN_PROGRAM_ID` if their token is NOT Token-2022, to make the choice visible.
- **`verifySwapOutput` gained a 6th optional param** (`preSwapBalance`). Additive; existing call sites work unchanged.
- **`StartCycleResult.swapped` gained `totalAtaAmount`**. If you destructure the result you may need to adjust.
- **`CycleResult` variants gained optional `claim?: ClaimPhaseResult`** + `'failed'` gained a new `'claim'` stage. Exhaustive switches may need a new branch.

### Added — staking claim primitive + autoClaim in runBuybackCycle

- **New `@printr/agent-skills/staking` module** — `listPositionsWithRewards`, `claimRewards`, `claimAllAboveThreshold`. Wraps Printr's `/v1/staking/list-positions-with-rewards` + `/v1/staking/claim-rewards`, signs the server-encoded claim tx with the owner keypair, submits + confirms. Public JWT default auth, partner key override via `options.apiKey`.
- **`CycleConfig.autoClaim?`** — optional field on runBuybackCycle. When set, cycle runs a Phase 0.5 between recovery and swap that claims the owner's rewards above `minClaimableLamports`. Funds the cycle from the owner's accrued POB yield — fully-autonomous loop, no manual sweep. Trades blast radius (hot keypair now owns stake positions) for removing the weekly ritual.
- **`verifySwapOutput(...)` 6th param `preSwapBalance?`** — when supplied, slippage check compares the post-swap ATA delta (`account.amount - preSwapBalance`) against `minOutAmount` rather than the absolute amount. Required when autoClaim may have pre-funded the ATA with telecoin rewards; without it a zero-fill swap would silently pass because claim-delivered balance already exceeds minOut.
- **`StartCycleResult.swapped` gains `totalAtaAmount: bigint`** — the full ATA balance after the swap (bought + any pre-existing). `runBuybackCycle` now passes `totalAtaAmount` to `burnAgentTokens` when autoClaim is on, so claimed telecoin rewards are burned in the same ix as the swap output. `bought` still reports just the swap's delivery for accounting.
- **`CycleResult` variants `completed`/`noop`/`failed` gain optional `claim?: ClaimPhaseResult`** — null when autoClaim is off OR nothing was above threshold; populated with `{ signature, claimedLamports, claimedTelecoinAtomic, positionsClaimed }` when a claim ran. The `failed` variant's `stage` union also gains `'claim'` to distinguish claim-phase failures from swap/burn failures.
- **`./staking` package export + new tests** — 8 new tests covering CAIP-10 formatting, API call shape, auth header selection, threshold filtering, and empty-input guards. Total 106/106 passing.

### Added
- `simulateSwap(connection, tx)` in `src/swap/execute.ts` — wraps `connection.simulateTransaction` with `sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true`. Returns `SimulateSwapResult { ok, err, logs, computeUnitsConsumed, innerInstructions, tokenTransferCount }`. Lets adopters validate route resolution + compute cost before enabling a live cron — no SOL spent, no signature required.
- `TOKEN_2022_PROGRAM_ID` exported from `src/payments/constants.ts`. `simulateSwap`'s `tokenTransferCount` covers both classic SPL-Token and Token-2022 — many Printr POB tokens use the Token-2022 standard.
- **Token-2022 support in `runBuybackCycle`** (`CycleConfig.tokenProgramId`) and `verifySwapOutput` (5th param). Defaults to classic SPL for backwards compatibility; pass `TOKEN_2022_PROGRAM_ID` from `@solana/spl-token` for Token-2022 mints. The flag threads through every ATA-touching call site: `getAssociatedTokenAddress` (ATA PDA derivation uses the program ID as a seed), `getAccount` (account parsing), and `createBurnInstruction` (program dispatch). Omitting it on a Token-2022 mint previously produced the wrong ATA address — `TokenAccountNotFoundError` every cycle on the recovery read, and an on-chain burn failure if somehow a swap landed. **Motivated by a Token-2022 adopter integration** that surfaced the ATA-derivation mismatch; any Printr POB token with `owner = TokenzQdB…` on its mint account needs this.
- `scripts/verify-graduation.ts` — Jupiter route classification + pool-depth probes at realistic cycle sizes. Confirms graduation state + slippage feasibility.
- `scripts/dry-run-swap.ts` — one-shot simulated swap against any mint. Parses inner instructions, prints a program-log dump, exits non-zero on program error.
- `scripts/verify-printr-mechanism.ts` — queries Printr's `POST /v1/staking/list-positions-with-rewards` and `POST /v1/telecoin/buyback-burn-detail`. Reports aggregated claimable + claimed staker rewards for a given telecoin. **This is the correct way to verify POB fee distribution is live** — see Corrected below.

### Corrected
- **POB model-1 fee distribution is async, not per-swap.** The README, `printr-tokenized-agent/SKILL.md`, `printr-swap/SKILL.md`, and their SCENARIOS.md companions previously implied a per-swap fee-hook transfer that could be detected in a swap's inner instructions. This was wrong — verified empirically against a graduated Token-2022 POB telecoin on 2026-04-23. POB model-1 tokens accrue fees via Meteora DAMM v2's standard LP-fee accounting, and Printr's SVM program (`T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint`) distributes accumulated SOL to stakers asynchronously. Every POB model-1 swap on-chain looks identical to a plain Meteora DAMM v2 swap. Doc passages + the `possibleFeeHookDetected` field have been removed; `SimulateSwapResult.tokenTransferCount` is retained as a generic route-sanity check with its framing corrected. See `printr-tokenized-agent/SKILL.md` §"How POB Model-1 Fee Distribution Actually Works" for the accurate mechanism.

### Dependencies
- `@neondatabase/serverless` bumped `^0.9.0` → `^1.1.0` (PR #4). Test suite still green against pg-mem; live-Neon validation remains adopter-side per `KNOWN_ISSUES.md`.
- Dev-deps group bumped (PR #3).

## [0.1.0] — 2026-04-23

First tagged release. **Pre-production** — at this point the kit had not yet run a full buyback cycle on a live mainnet integration. Version `0.x` until at least one production cycle lands on a live adopter. (That milestone was reached in 0.2.0 — see above.)

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
