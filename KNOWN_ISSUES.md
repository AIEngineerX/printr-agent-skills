# Known Issues

Live issues that can't be fixed inside this repo and the rationale for each. Reviewed on every release.

## Transitive: `bigint-buffer` CVE-2025-3194 (HIGH, accepted)

**Source**: `@solana/spl-token@0.4.x → @solana/buffer-layout-utils@0.2.0 → bigint-buffer@1.1.5`

**Advisory**: [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) — Buffer overflow in `toBigIntLE()` when given a Buffer with length not matching the expected byte width.

**Why we can't patch it here**:

- `bigint-buffer@1.1.5` is the latest publish (Oct 2019). The upstream package appears abandoned.
- The only npm-audit "fix" downgrades `@solana/spl-token` to `0.1.8`, which predates the entire SPL token API we use (`getAssociatedTokenAddress`, `createTransferCheckedInstruction`, `createBurnInstruction`, `getAccount`, `TokenAccountNotFoundError`). Applying it breaks every module that imports from `@solana/spl-token`.
- No maintained fork of `bigint-buffer` exists that `@solana/buffer-layout-utils` recognizes as a drop-in.

**What our exposure actually looks like** (being honest, this is weaker than "we don't invoke it"):

- `@solana/buffer-layout-utils` calls `bigint-buffer`'s `toBigIntLE()` during SPL token account deserialization. Every time we call `getAccount(connection, ata)` in the kit — which happens in `findRecoveryCycle`, `verifySwapOutput`, and every USDC-path verification — that function runs.
- The mitigation is **trust in the buffer source**: the bytes fed to `toBigIntLE()` here come from a Solana RPC response, not from user-submitted input. An attacker would need a compromised or malicious RPC provider that crafts a malformed account buffer specifically to trigger the overflow.
- This is a real reduction in exposure compared to the classic "user-supplies-buffer" attack surface the CVE was filed against, but it is **not zero risk**. A compromised RPC is in-scope in some threat models (e.g. MITM on a free public endpoint).
- If your threat model treats your RPC as potentially hostile, either (a) use a paid RPC you trust, (b) pin `@solana/*` packages to whatever version ships the fix once upstream patches, or (c) sandbox the SPL account reads.

**What would change our mind**:

- A confirmed exploit chain through `@solana/spl-token`'s public API would elevate this from accepted to blocker.
- `@solana/spl-token` releasing a version that drops `@solana/buffer-layout-utils` (or `@solana/buffer-layout-utils` releasing a version that drops `bigint-buffer`) would auto-resolve. We should re-check on every `@solana/*` bump.

**Monitoring**:

- GitHub Dependabot alerts us if the advisory is updated.
- Each release's CHANGELOG records the current residual vuln count.

## Upstream packages we track

These are the parents we bump manually; their transitive tree dictates our audit posture:

| Package                    | Current   | Why pinned                                                                      |
| -------------------------- | --------- | ------------------------------------------------------------------------------- |
| `@solana/web3.js`          | `^1.98.0` | `2.x` is a breaking API redesign; we stay on `1.x` until the ecosystem migrates |
| `@solana/spl-token`        | `^0.4.0`  | API we rely on landed in `0.4.x`; downgrading breaks every SPL call site        |
| `bs58`                     | `^6.0.0`  | Stable, no known vulns                                                          |
| `@neondatabase/serverless` | `^1.1.0`  | Stable                                                                          |

## Runtime assumptions

Adopters should double-check these match their environment:

| Assumption                                               | Why it matters                                                                                                                                                                                            | How to verify                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Node.js 18 or later**                                  | `AbortSignal.timeout` + modern bigint support in `Buffer` are 18+ only                                                                                                                                    | `node -v` at deploy time; enforced via `engines` in `package.json`                                                           |
| **RPC returns `jsonParsed` instruction data**            | The verifier's matchers (`instructionIsSolTransfer`, `instructionIsUsdcTransfer`) read `ix.parsed.info.*` — raw-only RPCs silently fail every match                                                       | Call `getParsedTransactions` against your RPC with a known memo-tagged tx; confirm `instructions[].parsed.info` is populated |
| **Meteora AMM labels stay `"DAMM v2"` / `"DBC"`**        | `getPoolState` classifies pools by substring-matching the label; a rename (e.g. to `"DAMM v3"`) silently degrades to `'unknown'`                                                                          | `getPoolStateOrThrow` is the safer variant for crons; it aborts on unclassified labels                                       |
| **Clock skew < 60s vs. chain time**                      | The verifier grants a 60s pre-start window and 300s post-end grace; larger drift causes legitimate invoices to read as not-found or expired                                                               | NTP sync your host; monitor `time since last RPC block`                                                                      |
| **Postgres locks behave like real-PG under concurrency** | Tests use `pg-mem` which emulates most SQL but has documented divergence on locking semantics. The `UPDATE ... WHERE status='pending'` idempotency pattern has not been load-tested against real Postgres | Run an integration test against a real Neon/PG before high-traffic deployment                                                |
| **Jupiter `lite-api.jup.ag` stays online**               | `quoteSwap` + `buildSwapTransaction` depend on Jupiter being reachable; there's no fallback route planner                                                                                                 | Monitor Jupiter status; for production traffic, use paid tier with `JUPITER_API_URL` override                                |
| **`@solana/web3.js` pinned at `1.x`**                    | The kit imports v1 APIs (`Transaction`, `VersionedTransaction.deserialize` legacy shape, `ComputeBudgetProgram`); v2 is a breaking redesign                                                               | `npm ls @solana/web3.js` — should resolve to a single `1.x` version across the whole tree                                    |

## Issue reporting

Security issues: see [`SECURITY.md`](./SECURITY.md).
Non-security bugs: open a GitHub issue.
