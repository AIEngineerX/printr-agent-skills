# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-23

First tagged release. **Pre-production** — the kit has not yet run a full buyback cycle on a live mainnet integration. Version `0.x` until at least one production cycle lands on the reference implementation ($INKED).

### Skills (this repo)
- `printr-swap` — Jupiter quote / build / execute primitives.
- `printr-agent-payments` — invoice + on-chain memo-match verification.
- `printr-tokenized-agent` — composed buyback + burn cycle with recovery mode.

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
