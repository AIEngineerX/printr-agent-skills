# Known Issues

Live issues that can't be fixed inside this repo and the rationale for each. Reviewed on every release.

## Transitive: `bigint-buffer` CVE-2025-3194 (HIGH, accepted)

**Source**: `@solana/spl-token@0.4.x → @solana/buffer-layout-utils@0.2.0 → bigint-buffer@1.1.5`

**Advisory**: [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) — Buffer overflow in `toBigIntLE()` when given a Buffer with length not matching the expected byte width.

**Why we can't patch it here**:
- `bigint-buffer@1.1.5` is the latest publish (Oct 2019). The upstream package appears abandoned.
- The only npm-audit "fix" downgrades `@solana/spl-token` to `0.1.8`, which predates the entire SPL token API we use (`getAssociatedTokenAddress`, `createTransferCheckedInstruction`, `createBurnInstruction`, `getAccount`, `TokenAccountNotFoundError`). Applying it breaks every module that imports from `@solana/spl-token`.
- No maintained fork of `bigint-buffer` exists that `@solana/buffer-layout-utils` recognizes as a drop-in.

**Why our exposure is limited**:
- The vulnerable function `toBigIntLE()` is called by `@solana/buffer-layout-utils` when deserializing buffer-laid-out SPL token account state. Buffers passed to it are produced by Solana RPC responses — not attacker-controlled input in any path this repo exercises.
- Our own code never imports `bigint-buffer` directly. We read token amounts via `getAccount(connection, ata)` (returns `bigint` from web3.js) and write them via `createTransferCheckedInstruction` / `createBurnInstruction` (bigint parameters). Neither calls the vulnerable path in a way that takes untrusted buffer input.

**What would change our mind**:
- A confirmed exploit chain through `@solana/spl-token`'s public API would elevate this from accepted to blocker.
- `@solana/spl-token` releasing a version that drops `@solana/buffer-layout-utils` (or `@solana/buffer-layout-utils` releasing a version that drops `bigint-buffer`) would auto-resolve. We should re-check on every `@solana/*` bump.

**Monitoring**:
- GitHub Dependabot alerts us if the advisory is updated.
- Each release's CHANGELOG records the current residual vuln count.

## Upstream packages we track

These are the parents we bump manually; their transitive tree dictates our audit posture:

| Package | Current | Why pinned |
|---|---|---|
| `@solana/web3.js` | `^1.98.0` | `2.x` is a breaking API redesign; we stay on `1.x` until the ecosystem migrates |
| `@solana/spl-token` | `^0.4.0` | API we rely on landed in `0.4.x`; downgrading breaks every SPL call site |
| `bs58` | `^6.0.0` | Stable, no known vulns |
| `@neondatabase/serverless` | `^0.9.0` | Stable |

## Issue reporting

Security issues: see [`SECURITY.md`](./SECURITY.md).
Non-security bugs: open a GitHub issue.
