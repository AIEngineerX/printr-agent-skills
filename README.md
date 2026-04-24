# printr-agent-skills

[![test](https://github.com/AIEngineerX/printr-agent-skills/actions/workflows/test.yml/badge.svg)](https://github.com/AIEngineerX/printr-agent-skills/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./.nvmrc)
[![release](https://img.shields.io/github/v/release/AIEngineerX/printr-agent-skills?sort=semver)](https://github.com/AIEngineerX/printr-agent-skills/releases)

Agent Skills for building **tokenized-agent revenue loops** on [Printr](https://printr.money) — the omnichain Proof-of-Belief (POB) token launchpad.

> **Works with any agent that reads YAML skill frontmatter.** Tested on Claude Code; compatible by design with GitHub Copilot CLI, Gemini CLI, Cursor, and other CLIs that adopt the same skill format. Also usable as a plain TypeScript library via `import from '@printr/agent-skills/...'`. See [Install — any agent that supports the skill format](#install--any-agent-that-supports-the-skill-format) for per-agent paths.

Three composable skills:

- **`printr-swap`** — Jupiter-routed buy/sell on Meteora DBC or DAMM v2 pools. Standalone primitive; testable with a 0.001 SOL quote.
- **`printr-agent-payments`** — accept SOL or USDC payments for paid agent actions, with on-chain memo-match verification.
- **`printr-tokenized-agent`** — composes the two above, adds SPL `burn` and a scheduled hourly buyback cycle, custody-agnostic (four patterns).

Each skill auto-triggers in any compatible agent CLI when you describe a matching task, and walks you through a mandatory pre-work checklist before writing any code.

## Why this exists for Printr

Printr POB tokens live on Meteora DBC (bonding curve) and migrate to Meteora DAMM v2 on graduation. This kit builds an agent-revenue → buyback → burn loop on that stack: Jupiter for routing, SPL `burn` for supply reduction, memo-matched on-chain invoice verification for payments. Second-order effect on POB model-1 tokens: **buyback swaps deepen DAMM v2 LP-fee accrual that Printr's POB program distributes to stakers asynchronously** — supply shrinks AND the pool stakers draw from grows. Distribution is NOT a per-swap hook. Verify mechanism liveness via `scripts/verify-printr-mechanism.ts` before enabling a cron.

## Available Skills

| Skill                                                         | Purpose                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`printr-swap`](./printr-swap/SKILL.md)                       | Buy or sell a Printr POB token via Jupiter. Handles user-signed (wallet adapter) and server-signed (automated buyback) flows. Auto-detects bonding-curve vs graduated pool state, applies slippage protection, verifies ATA balance post-swap. |
| [`printr-agent-payments`](./printr-agent-payments/SKILL.md)   | Accept SOL or USDC for paid agent actions. Generates unique memos, builds transfer txs for client signing, verifies invoices on-chain by scanning treasury signatures. UNIQUE-memo DB constraint prevents replay.                              |
| [`printr-tokenized-agent`](./printr-tokenized-agent/SKILL.md) | Composes the two above. Hourly cron reads hot-wallet balance, quotes SOL→token on Jupiter, swaps, and burns via SPL `burn` instruction. Recovery mode handles swap-succeeds-burn-fails. Custody-agnostic — pick one of four patterns.          |

## Composition

```
┌───────────────────────────────────────────────────┐
│              printr-tokenized-agent               │
│        (hourly cron; recovery mode; burn)         │
│                                                   │
│   ┌─────────────────┐   ┌─────────────────────┐   │
│   │   printr-swap   │   │ printr-agent-       │   │
│   │                 │   │     payments        │   │
│   │  Jupiter quote  │   │                     │   │
│   │  + sign + send  │   │  invoice + memo +   │   │
│   │  + verify ATA   │   │  on-chain verify    │   │
│   └─────────────────┘   └─────────────────────┘   │
└───────────────────────────────────────────────────┘
```

Each sub-skill is independently usable. Skip `printr-tokenized-agent` if you only need swap or payment functionality separately.

## Install — any agent that supports the skill format

The kit is **agent-agnostic**. The YAML frontmatter format (`name` + `description`) used in every `SKILL.md` is the cross-agent standard adopted by Claude Code, GitHub Copilot CLI, and Gemini CLI. Cursor and rule-based IDEs can use the skill body manually. Drop the three skill directories into your agent's skills folder.

### Claude Code

```bash
# macOS / Linux / Git Bash on Windows
git clone https://github.com/AIEngineerX/printr-agent-skills.git
cp -r printr-agent-skills/printr-* ~/.claude/skills/
```

```powershell
# PowerShell on Windows
git clone https://github.com/AIEngineerX/printr-agent-skills.git
Copy-Item printr-agent-skills\printr-* $env:USERPROFILE\.claude\skills\ -Recurse
```

### GitHub Copilot CLI

Copilot's `skill` tool reads the same YAML frontmatter (`name`, `description`) and is **expected** to auto-discover these skills. **Not yet verified** on Copilot CLI — if you're the first, please open a GitHub issue with your experience.

### Gemini CLI

Gemini CLI's `activate_skill` reads the same frontmatter. **Not yet verified** on Gemini — please open an issue with results.

### Cursor / other rule-based IDEs

Cursor uses `.cursor/rules/*.md` rather than an auto-triggered skill format; you can copy the SKILL.md body into a Cursor rules file and trigger manually. **Not yet verified** on Cursor — the skill body is platform-agnostic but the triggering mechanism differs.

### Project-scoped install (any agent)

If you only want the skills available inside one project:

```bash
mkdir -p .claude/skills   # or .cursor/rules, or equivalent for your agent
cp -r /path/to/printr-agent-skills/printr-* .claude/skills/
```

Restart your agent. The three skills will auto-trigger when you describe a matching task.

## Example Prompts

Each skill's `description` field in its YAML frontmatter defines what triggers it. Known-good prompts:

**`printr-swap`**

- _"Quote a swap from SOL to `<MINT>` via Jupiter, then execute it from my treasury wallet"_
- _"Buy 0.1 SOL worth of `<MINT>` for me, signed with my Phantom wallet"_
- _"Is this token pre-graduation or graduated? Check via Jupiter route."_

**`printr-agent-payments`**

- _"Build a paywall where users pay 0.1 SOL to unlock a paid action"_
- _"Add a paid-action gate to my agent — charge 0.05 SOL per deep-analysis call"_
- _"Verify if invoice `<MEMO>` was paid on-chain"_

**`printr-tokenized-agent`**

- _"Set up a buyback-and-burn loop for my Printr POB token `<MINT>`"_
- _"Run an hourly buyback-and-burn cron against my graduated Token-2022 POB mint"_
- _"Compose `printr-swap` + `printr-agent-payments` into a full revenue loop"_

## Skill Structure

Each skill is a standalone directory:

```
skill-name/
├── SKILL.md              ← main definition (YAML frontmatter + body)
└── references/           ← progressive-disclosure docs
    ├── SCENARIOS.md      ← named test scenarios with expected outcomes
    └── ...               ← skill-specific extras
```

Full per-skill layout:

```
printr-agent-skills/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── SECURITY.md
├── printr-swap/
│   ├── SKILL.md
│   └── references/SCENARIOS.md
├── printr-agent-payments/
│   ├── SKILL.md
│   └── references/
│       ├── SCENARIOS.md
│       ├── VERIFY_ON_CHAIN.md         ← hand-rolled verifier reference
│       └── WALLET_INTEGRATION.md      ← wallet-adapter setup (Next.js etc.)
└── printr-tokenized-agent/
    ├── SKILL.md
    └── references/
        ├── SCENARIOS.md
        └── CUSTODY_PATTERNS.md        ← four treasury custody tiers
```

## Grounding — every claim is traceable

Every non-obvious claim in each `SKILL.md` carries a provenance marker so you can tell what's authoritative vs. interpreted:

| Tag         | Meaning                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `[Printr]`  | Verifiable against [printr.gitbook.io/printr-docs](https://printr.gitbook.io/printr-docs) or `api-preview.printr.money` |
| `[pattern]` | Standard Solana / SPL / Jupiter / Web3.js convention, not platform-specific                                             |
| `[derived]` | Author's judgment. Most likely to need revision as the ecosystem evolves                                                |

Grep for `[derived]` in any SKILL.md to see exactly what's my call vs. what's upstream-grounded fact.

## Production track record

First live mainnet cycle ran 2026-04-24 against a graduated Token-2022 POB telecoin: [swap](https://solscan.io/tx/qDQwNKVqsSbZLL4JZ7QwSy2y9oPtHx5wXCkLnfsDCCAESLf2kW2fqZDLRo8BCp6z9rFnXnpgPhCh3LxRJj5613E) · [burn](https://solscan.io/tx/5pvuDM4dcPJf3mff57uSvLUQrWBTB2Jp3bvfPtSKA9oohnGQh5ZLtenMsB2JsaaWuMSfpM9pBG4TLkXXjMKNMyZz).

## Adopters

No public adopters listed yet. PR yourself in after running a production cycle — include your burn tx on Solscan as evidence.

## Runtime compatibility

`@solana/web3.js` and `@solana/spl-token` use Node APIs (`node:buffer`, dynamic `require`) — the kit only runs on Node-compatible runtimes. As of 0.2.0 the kit publishes a compiled `dist/`, so bundler TS-resolution is no longer an adopter concern.

| Host / runtime                                 | Status                      | Notes                                                                                                                |
| ---------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Netlify Functions** (Node 22.x)              | ✅ **Production-verified**   | Used by the 2026-04-24 live cycle (see "Production track record" above). Import from `@printr/agent-skills/tokenized-agent` into a Scheduled Function handler. |
| Vercel Cron (Node)                             | ✅ Expected to work          | `vercel.json` crons; validate `CRON_SECRET` header                                                                   |
| Railway / Fly / plain Node                     | ✅ Expected to work          | Standard Node 18+ runtime                                                                                            |
| AWS Lambda (Node)                              | ✅ Expected to work          | Node 18+ runtime, import `from '@printr/agent-skills/tokenized-agent'`                                               |
| GitHub Actions (scheduled)                     | ✅ Expected to work          | `ubuntu-latest` + `actions/setup-node@v4`                                                                            |
| **Netlify Edge Functions** (Deno)              | ❌ **Not supported**         | Deno rejects `Dynamic require of "node:buffer"` inside `@solana/web3.js`. Move the cycle to a regular Netlify Function (Node runtime) — the Netlify Functions row above is the production-verified path. |
| Cloudflare Workers (default)                   | ⚠ Partial                   | Default V8 isolate has the same issues as Deno. `nodejs_compat` flag + a bundler that provides `node:buffer` polyfill may work — not verified live yet |
| Vercel Edge Runtime                            | ❌ Not supported             | Same Node-API issue as Netlify Edge                                                                                  |

### A note on inlining vs importing

Early-0.1.x adopters sometimes inlined `runBuybackCycle` into a Netlify Function handler because esbuild stripped the handler when importing from `src/`. 0.2.0's compiled `dist/` fixes that — import from `@printr/agent-skills/tokenized-agent` directly.

## Runtime requirements

- **Node.js 18+** (`AbortSignal.timeout`, modern `crypto.randomBytes` bigint support).
- **Solana RPC that returns `jsonParsed` instruction data** — Helius, Solana Tracker, Ankr, and PublicNode all do. `@solana/web3.js`'s `getParsedTransactions` requires this for the verifier's matchers to see memo + transfer fields. Raw-only RPCs will break verification.
- **Postgres 13+ or Neon** — the `payment_invoice` table uses `BIGINT`, `TIMESTAMPTZ`, `CHECK` constraints, and partial indexes. The tests use `pg-mem` as a stand-in; pg-mem has known semantic gaps from real Postgres under concurrent locks — verify your DB handles the `UPDATE ... WHERE status='pending'` pattern before high-traffic deployment.
- **`@solana/web3.js` `^1.98.0`** — do not mix with `2.x` in the same project.

## Versioning + rollback

**Pin to a tag, not to `main`.** The `main` branch is a moving target; adopters should anchor to a released version.

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/AIEngineerX/printr-agent-skills.git
```

- `0.x.y` is **pre-production**. Breaking changes may land on any bump. Version `1.0.0` will be cut after at least one production buyback cycle runs successfully on a live consumer.
- Post-`1.x`, the project follows strict SemVer.
- Release notes: [`CHANGELOG.md`](./CHANGELOG.md). Tags: [releases](https://github.com/AIEngineerX/printr-agent-skills/releases).

To roll back: check out a previous tag or revert the skills folder in your local install to the previous version's copy.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for PR standards, provenance-tagging rules, and how to add a new sibling skill (e.g. a `printr-stake` primitive).

## Related Skills (not bundled here)

- `printr-eco` — Printr ecosystem primer (POB math, fee models, telecoin_id). Orthogonal; install separately if you want deep Printr knowledge.
- `helius-docs` — advanced on-chain reads + webhook-push verification as an upgrade from the RPC-pull pattern in `printr-agent-payments/references/VERIFY_ON_CHAIN.md`.

## Security

- [`SECURITY.md`](./SECURITY.md) — vulnerability reporting policy, response SLAs, known non-issues.
- [`THREAT_MODEL.md`](./THREAT_MODEL.md) — what the kit protects against, what the adopter must protect against, and what's out of scope.
- [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) — residual `npm audit` advisories and runtime assumptions.

## License

MIT — see [`LICENSE`](./LICENSE).
