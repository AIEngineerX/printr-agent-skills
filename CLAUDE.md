# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`@printr/agent-skills` is **two products in one directory**, which both matter for every change:

1. **Agent-facing skills** — three `printr-*/SKILL.md` files with YAML frontmatter (name/description) that auto-trigger in any skill-aware CLI (Claude Code, Copilot CLI, Gemini CLI).
2. **A TypeScript library** — `src/` compiled to `dist/` and re-exported under subpaths (`@printr/agent-skills/swap`, `/payments`, `/staking`, `/tokenized-agent`). The SKILL.md code examples must match what the library actually does, or adopters inlining the kit diverge from adopters importing it.

When you change runtime behavior in `src/`, search the matching `printr-*/SKILL.md` + `references/` files for stale examples or claims.

## Commands

```bash
npm test                 # vitest run — unit + pg-mem integration (mocked RPC)
npm run test:live        # SKILL_LIVE=1 — hits Jupiter live-quote endpoints
npx vitest run tests/swap.test.ts               # single file
npx vitest run tests/swap.test.ts -t "pattern"  # single test by name
npm run build            # tsc --project tsconfig.build.json → dist/
npm run typecheck        # tsc --noEmit against tsconfig.json (wider; includes tests + scripts)
npm run format           # prettier --write .
npx tsx scripts/verify-printr-mechanism.ts <TELECOIN_ID>   # confirm POB is live before enabling cron
npx tsx scripts/dry-run-swap.ts                            # simulate swap, no SOL spent
```

Two tsconfigs: `tsconfig.json` is the dev/typecheck config (`moduleResolution: bundler`, includes tests/scripts/examples). `tsconfig.build.json` is the publish config (`NodeNext`, src-only, emits to `dist/`). The `prepare` npm script auto-runs `build` on `npm install` from a git URL — **adopters installing via git URL get a rebuilt `dist/` without committing it, but if you edit `src/` and forget to rebuild locally, the published exports are stale**. Run `npm run build` before committing when changing exports.

## Architecture — the big picture

The library is four modules under `src/` composed into one public orchestrator:

```
src/swap/         quoteSwap → buildSwapTransaction → executeServerSwap / executeUserSwap
src/payments/     generateInvoiceParams + verifyInvoiceOnChain (treasury-sig-history scan + memo match)
src/staking/      Printr V1 API client — listPositionsWithRewards, claimRewards, claimAllAboveThreshold
src/tokenized-agent/  runBuybackCycle = the full loop; imports from all three above
```

`runBuybackCycle` (src/tokenized-agent/cycle.ts) is the one orchestrator an adopter calls. It has **four phases** with durable state in a `burn_event` Postgres row between each:

1. **Recovery** (`findRecoveryCycle`) — if the hot ATA still holds tokens from a prior swap-succeeded-burn-failed state, burn those and return. Recovery takes precedence over everything else.
2. **Claim** (Phase 0.5, optional, when `cfg.autoClaim` is set) — calls Printr's `/v1/staking/claim-rewards` to top up the hot wallet from POB stake yield.
3. **Swap** (`startCycle`) — Jupiter quote SOL→token, swap, verify via ATA-delta check. Records `status='swap_done'` **immediately after swap confirmation** so any downstream failure is recoverable on the next tick.
4. **Burn** — `createBurnInstruction` against the full ATA balance (not the quoted amount), so any claim-delivered tokens are destroyed alongside the swap output in a single ix.

**The `burn_event` row is the recovery primitive.** A crash between swap-confirmed and burn-submitted leaves `status='swap_done'`; the next tick's recovery phase burns the actual on-chain ATA balance (not the recorded quote amount — survives quote drift). A slippage bust flips `status='failed'` so recovery won't auto-burn a partial fill without operator review.

### Verification flow (src/payments/verify.ts)

Pull-based: scan the treasury's recent signatures (`getSignaturesForAddress`), filter by blockTime window `[start_time - CLOCK_SKEW, end_time + GRACE]`, fetch `getParsedTransactions`, look for a tx with **both** a memo instruction matching `invoice.memo` **and** a SOL/USDC transfer matching `(user, treasury, amount)`. Requires an RPC that returns `jsonParsed` instruction data — public `api.mainnet-beta.solana.com` does NOT. Helius / Ankr / PublicNode do.

The UPDATE query is `WHERE status='pending'` — the first concurrent verify wins, subsequent ones return `rowCount=0` without double-crediting. `pg-mem` in tests has known semantic gaps under concurrent UPDATE-with-predicate; live validation remains adopter-side.

## Invariants that bite if violated

- **`tokenProgramId` must match the mint's actual SPL program.** Classic SPL default against a Token-2022 mint gives the wrong ATA PDA (seed includes program ID) → `TokenAccountNotFoundError` every cycle + on-chain burn failure. Many Printr POB tokens graduated post-mid-2025 are Token-2022. The flag threads through `getAssociatedTokenAddress`, `getAccount`, and `createBurnInstruction`; always pass it explicitly in new code.
- **`preSwapBalance` is required when `autoClaim` is on.** A claim may deposit telecoin rewards into the same ATA before the swap. Without the pre-swap snapshot, `verifySwapOutput`'s slippage check compares absolute balance, which already exceeds minOut thanks to the claim — a zero-fill swap silently passes. Snapshot in `startCycle` and pass through.
- **POB model-1 fee distribution is async, NOT per-swap.** Verified empirically against a graduated Token-2022 POB telecoin on 2026-04-23. Fees accrue to Meteora DAMM v2 LP-fee state; Printr's SVM program distributes to stakers on its own schedule. `simulateSwap.tokenTransferCount` is a route-sanity check only — it is NOT a fee-hook detector. If you find older docs implying a per-swap hook, they're wrong; fix them. Verify POB liveness via `scripts/verify-printr-mechanism.ts`.
- **Pin `@solana/web3.js ^1.98.0`** — do not mix with 2.x in the same project.
- **Runtime**: Node 18+ only. Netlify Edge Functions / Vercel Edge / default Cloudflare Workers reject `node:buffer` dynamic require inside `@solana/web3.js` — move the cycle to a regular Node Function. Production-verified on Netlify Functions (Node 22.x).

## Provenance tagging (enforced in SKILL.md files)

Every non-obvious claim in any SKILL.md must carry one of:

- `[Printr]` — verifiable against `printr.gitbook.io/printr-docs` or `api-preview.printr.money`
- `[pattern]` — standard Solana / SPL / Jupiter / Web3.js convention
- `[derived]` — author's judgment; most likely to need revision

Untagged = assumed obvious to a mid-level Solana dev. When adding new claims, tag them. Grep `[derived]` before big changes to see what's still author-judgment vs. grounded.

## Skill structure (when editing SKILL.md files)

Each `printr-*/SKILL.md` starts with a **"Before Starting Work" hard-blocking checklist** — mandatory phrasing: _"You MUST ask the user for ALL unchecked items in your very first response. Do not assume defaults. Do not proceed until the user has explicitly answered each one."_ Do not weaken this; it's the guardrail that stops adopters from running a live buyback against the wrong mint or with an under-funded RPC.

See `CONTRIBUTING.md` for the full required-sections list.

## Git identity

Uses `github-aiengx` (AIEngineerX). Check `git remote get-url origin` before any commit — cross-contamination with the Griffin identity is a blocking error. Commit style: `feat(scope): subject — short description`, e.g. `feat(staking): claim primitive + autoClaim in runBuybackCycle`.

## Release + versioning

`0.x` is pre-production — breaking changes may land on any minor bump. `1.0.0` will be cut after at least one production buyback cycle runs successfully on a live adopter (the 2026-04-24 cycle, linked in `README.md` §Production track record, is the first such evidence). Adopters are told to pin a tag, not `main`. Update `CHANGELOG.md` (Keep-a-Changelog format) with any adopter-relevant change to exports, CycleConfig fields, or runtime compatibility.

## Production track record

`README.md` §Production track record keeps the canonical Solscan tx links for the first live cycle (2026-04-24). Treat those links as the authoritative evidence that the kit runs end-to-end; don't replace them with prose claims elsewhere in the docs.
