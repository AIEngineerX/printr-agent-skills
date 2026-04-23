# Security Policy

## Scope

This repository contains **Claude Code skill documentation** for building tokenized-agent revenue loops on Printr POB tokens. The skills teach patterns; they do not ship runtime code you install and execute directly.

### In scope for security reports

1. **Unsafe patterns in skill documentation** — code examples that, if adopted as-is, would expose adopters to attack. Examples: key leakage, invoice replay vectors, unauthorized access paths, race conditions in the verifier, incorrect retry semantics.
2. **Incorrect safety-rule claims** — any place the documentation says "safe" about something that isn't, or omits a rule that materially affects adopter security.
3. **Provenance drift** — claims tagged `[Printr]` that don't match Printr's live API behavior, or `[pattern]` claims that don't match current Solana / SPL conventions. Drift here can lead adopters to build against stale assumptions.
4. **Supply-chain drift** — pinned dependency versions (`@solana/web3.js@^1.98.0`, etc.) being known-vulnerable or abandoned upstream.

### Out of scope

- Compromise of an adopter's treasury wallet due to custody mistakes. See [`printr-tokenized-agent/references/CUSTODY_PATTERNS.md`](./printr-tokenized-agent/references/CUSTODY_PATTERNS.md) for the adopter's checklist. The kit is custody-agnostic; we document the patterns but do not operate anyone's treasury.
- Bugs in `@solana/web3.js`, Jupiter's Swap API, Printr's on-chain program, Meteora pools, or any other upstream dependency. Report those to their respective maintainers.
- Smart-contract bugs in Printr's Solana program (`T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint`) — report to Printr via `@VikrewW` on Telegram.
- Business-logic bugs in a consumer project built on top of the skills (e.g. $INKED) — report to that project's maintainers.

## Reporting a vulnerability

**Do not open a public GitHub issue for security concerns.** Use one of the private channels below.

### Preferred: GitHub Private Vulnerability Reporting

[github.com/AIEngineerX/printr-agent-skills/security/advisories/new](https://github.com/AIEngineerX/printr-agent-skills/security/advisories/new)

This creates a private advisory visible only to maintainers and you. GitHub tracks the triage + fix + disclosure timeline in one place.

### Alternative channels

- **X DM**: [@Inkedbrrr](https://x.com/Inkedbrrr)
- **Telegram**: [t.me/inkedbrr](https://t.me/inkedbrr)

### What to include

- Clear description of the issue
- Which skill, file, and line range is affected
- A reproduction (minimal repro script, or a paste of the problematic pattern)
- Impact assessment (what an adopter who copies the pattern would be exposed to)
- Proposed fix, if you have one

## Response timeline

| Stage                                                  | SLA                                 |
| ------------------------------------------------------ | ----------------------------------- |
| Initial acknowledgment                                 | Within 72 hours                     |
| Triage decision (in-scope / out-of-scope / needs-info) | Within 1 week                       |
| Fix or coordinated disclosure plan                     | Within 2 weeks for confirmed issues |

This is a solo-operator project. SLAs are best-effort — if a response is overdue, a polite nudge on the same channel is welcome.

## Supported versions

| Version                       | Status    |
| ----------------------------- | --------- |
| `1.0` (current `main` branch) | Supported |

There are no long-term support branches. Always pull from `main` for the latest safety rules and patches.

## Known non-issues (for reporter clarity)

### Public repository contents

The repository is intentionally public and MIT-licensed. The following identifiers appear in the documentation and are **public by design** (already public on-chain or via Printr's public API):

- SPL token mints (e.g. `2qEFJDknuak6xTCkDV7QgPyWRKvMhjvV1Spisgadbrrr` — $INKED)
- Printr telecoin IDs (hex)
- Meteora DAMM v2 pool keys
- Standard Solana program IDs (System, Token, Memo, Compute Budget, Meteora)
- Standard token mints (wSOL, USDC, USDT)

No credentials, private keys, API keys, database URLs, or personal data are committed. Reports about "token mint is exposed" will be closed as not-applicable.

### Hot-wallet blast radius

Skills recommend a capped hot-wallet pattern via `BUYBACK_MAX_LAMPORTS` (default: 1 SOL per cycle). The blast radius of a server compromise is **bounded by this cap plus whatever SOL has accumulated between sweeps**. This is an adopter configuration, not a kit vulnerability. See `CUSTODY_PATTERNS.md` Pattern 3/4 for the recommended setup.

### No shared JWT / SDK

This kit has **no shared authentication artifact** across adopters. No embedded API keys, no shared JWTs, no hosted authority. Every adopter's deployment is fully self-contained — compromise of one adopter does not affect others.

### Transitive `bigint-buffer` CVE-2025-3194

One residual high-severity `npm audit` advisory traces to `bigint-buffer@1.1.5` (pulled transitively via `@solana/spl-token → @solana/buffer-layout-utils`). The upstream package is abandoned (last publish 2019); no patched version or maintained fork exists. Our code never invokes the vulnerable `toBigIntLE()` path directly, and the buffers our SPL calls consume come from Solana RPC responses, not user input. Full rationale + monitoring stance: [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).

Reports that rediscover this specific advisory will be closed as known; reports that demonstrate a new exploitation path **through this repo's public API** are in-scope.

### Memo collision

The skill generates memos via `crypto.randomBytes(8).readBigUInt64BE() & 0x7fff_ffff_ffff_ffffn` — a 63-bit uniform-random value. Collision probability is ~1 in 2^63 per invoice generation. The DB `UNIQUE` constraint on the memo column catches the astronomical-odds collision cleanly. Reports claiming "memos could collide" will be answered with this math unless they include a demonstration of how an attacker could force collisions.

## Researcher recognition

Valid reports will be credited:

- In the relevant commit message fixing the issue
- In a `CHANGELOG.md` entry (once `CHANGELOG.md` exists — created on first material release)
- Optionally in a public security advisory on the repo's Security tab

We do not currently run a paid bug bounty. If the kit sees substantial adoption (measured by the Reference Implementation table in `README.md`), a bounty may be added.

## Coordinated disclosure with upstream

If a confirmed issue traces to an upstream dependency, we follow coordinated-disclosure norms:

| Upstream                             | Contact                                  |
| ------------------------------------ | ---------------------------------------- |
| **Printr** (protocol)                | `@VikrewW` on Telegram                   |
| **Jupiter** (swap API)               | `station.jup.ag` support / their Discord |
| **Meteora** (pools)                  | `app.meteora.ag` / their Discord         |
| **Solana Labs** (web3.js, spl-token) | GitHub issue on the relevant repo        |

This repo will **not** publicly disclose unpatched upstream issues before those teams have had reasonable time to patch.

## Cryptographic caveats

The skills use standard Solana primitives — ed25519 signing, SPL token transfers, Memo program, SPL `burn` instruction. None of the skills invent new cryptography. If you find a cryptographic weakness, it almost certainly belongs upstream (Solana Labs). Please report there first; a skill-level report is welcome for documentation clarity but won't land a cryptographic fix.

## Contact

For non-security questions, use GitHub issues on this repo. Security reports: see "Reporting a vulnerability" above.
