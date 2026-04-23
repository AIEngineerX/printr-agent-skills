# printr-agent-skills

A collection of Claude Code **Agent Skills** for building agent-revenue loops on **[Printr](https://printr.money)** — the omnichain Proof-of-Belief (POB) token launchpad.

Mirrors the [pump.fun Tokenized Agents](https://github.com/pump-fun/pump-fun-skills/tree/main/tokenized-agents) pattern but hand-rolls the accept-payment flow (the `@pump-fun/agent-payments-sdk` only works for pump.fun-launched tokens) and runs the buyback+burn under the creator's own treasury wallet. Works with any Printr POB token — or any Solana SPL token that has a Jupiter-routable pool.

## Overview

Three composable skills:

- **`printr-swap`** — Jupiter-routed buy/sell on Meteora DBC or DAMM v2 pools. Standalone primitive; testable with a 0.001 SOL quote.
- **`printr-agent-payments`** — accept SOL/USDC payments for paid agent actions, with on-chain memo-match verification (no SDK).
- **`printr-tokenized-agent`** — composes the two above + adds SPL `burn` + scheduled hourly buyback cycle + four custody patterns.

Each skill auto-triggers in Claude Code when you describe a matching task. Each one walks through a mandatory pre-work checklist before writing any code.

## Available Skills

| Skill | Purpose |
|-------|---------|
| [`printr-swap`](./printr-swap/SKILL.md) | Buy or sell a Printr POB token via Jupiter. Handles user-signed (wallet adapter) and server-signed (automated buyback) flows. Auto-detects bonding-curve vs graduated pool state, applies slippage protection, verifies ATA balance post-swap. |
| [`printr-agent-payments`](./printr-agent-payments/SKILL.md) | Accept SOL or USDC for paid agent actions. Generates unique memos, builds transfer txs for client signing, verifies invoices on-chain by scanning treasury signatures. UNIQUE-memo constraint in DB prevents replay. |
| [`printr-tokenized-agent`](./printr-tokenized-agent/SKILL.md) | Composes the two above. Hourly cron reads hot-wallet balance, quotes SOL→token on Jupiter, swaps, and burns via SPL `burn` instruction. Recovery mode handles swap-succeeds-burn-fails. Custody-agnostic — pick one of four patterns. |

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

## Why this exists

[Pump.fun's Tokenized Agents](https://pump.fun/docs/tokenized-agent-disclaimer) shipped 2026-03-14 as a hosted product: creators upload a `skills.md`, pump.fun's authority contract auto-buybacks the token hourly from accumulated agent revenue and burns it. Beautiful mechanic — but locked to pump.fun-launched tokens.

Printr POB tokens can't use it. Their program is different; their fee routing is different; their pool venue is different (Meteora DBC → DAMM v2 on graduation, not pump.fun's bonding curve).

So the mechanic has to be rebuilt. With one genuine advantage: **Printr POB model #1 tokens pay the staking pool on every trade** — including a buyback trade. That gives these tokens a *double-effect* pump.fun can't replicate: every buyback both reduces supply AND pays the believers on its way to the burn. This is documented in the skills where relevant.

## Getting Started

### Install for Claude Code

Drop the three skill directories into your user-global Claude Code skills folder:

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

Restart Claude Code. The three skills will now auto-trigger when you describe a matching task.

### Install for a specific project

If you only want the skills available inside one project (not globally), copy them into the project's `.claude/skills/` directory instead:

```bash
mkdir -p .claude/skills
cp -r /path/to/printr-agent-skills/printr-* .claude/skills/
```

## Example Prompts

Each skill's `description` field in its YAML frontmatter defines what triggers it. A few known-good prompts:

### Triggers `printr-swap`

- *"Quote a swap from SOL to `<MINT>` via Jupiter, then execute it from my treasury wallet"*
- *"Buy 0.1 SOL worth of `<MINT>` for me, signed with my Phantom wallet"*
- *"Is this token pre-graduation or graduated? Check via Jupiter route."*

### Triggers `printr-agent-payments`

- *"Build a paywall where users pay 0.1 SOL to unlock a random-number generator"* *(same shape as pump.fun's example prompt)*
- *"Add a paid-action gate to my agent — charge 0.05 SOL per deep-analysis call"*
- *"Verify if invoice `<MEMO>` was paid on-chain"*

### Triggers `printr-tokenized-agent`

- *"Set up a buyback-and-burn loop for my Printr POB token `<MINT>`"*
- *"Build the first tokenized agent on Printr, using $INKED as the reference"*
- *"Compose `printr-swap` + `printr-agent-payments` into a full revenue loop"*

## Skill Structure

Each skill is a standalone directory following the standard Claude Code skill layout:

```
skill-name/
├── SKILL.md              ← main definition (required)
│                           YAML frontmatter: name, description, metadata
│                           Body: pre-work checklist, safety rules,
│                                 env vars, install, code examples,
│                                 end-to-end flow
└── references/           ← progressive-disclosure docs
    ├── SCENARIOS.md      ← named test scenarios with expected outcomes
    └── ...               ← skill-specific extras
```

Full per-skill layout:

```
printr-agent-skills/
├── README.md                                ← this file
├── LICENSE
├── CONTRIBUTING.md
├── printr-swap/
│   ├── SKILL.md
│   └── references/
│       └── SCENARIOS.md
├── printr-agent-payments/
│   ├── SKILL.md
│   └── references/
│       ├── SCENARIOS.md
│       ├── VERIFY_ON_CHAIN.md               ← the hand-rolled verifier
│       └── WALLET_INTEGRATION.md            ← Next.js / Solana wallet-adapter setup
└── printr-tokenized-agent/
    ├── SKILL.md
    └── references/
        ├── SCENARIOS.md
        └── CUSTODY_PATTERNS.md              ← four treasury custody tiers
```

## Grounding — every claim is traceable

Every non-obvious claim in each `SKILL.md` is tagged with one of four provenance markers so you can tell what's authoritative vs. interpreted:

| Tag | Meaning |
|---|---|
| `[pump.fun]` | Lifted verbatim or near-verbatim from `github.com/pump-fun/pump-fun-skills` or `pump.fun/docs/tokenized-agent-disclaimer` |
| `[Printr]` | Verifiable against [printr.gitbook.io/printr-docs](https://printr.gitbook.io/printr-docs) or `api-preview.printr.money` |
| `[pattern]` | Standard Solana / SPL / Jupiter convention, not platform-specific |
| `[derived]` | Author's judgment. Most likely to need revision as the ecosystem evolves |

Grep for `[derived]` in any SKILL.md to see exactly what's my call vs. what's an upstream-grounded fact.

## Reference Implementation

[`github.com/AIEngineerX/inked`](https://github.com/AIEngineerX/inked) — **$INKED**, the first production consumer of this kit. Relevant paths once shipped:

- Invoice accept/verify: `src/routes/api/pay/invoice/+server.ts`, `src/routes/api/pay/verify/+server.ts`
- Buyback cron: `src/routes/api/admin/buyback/+server.ts`
- Public burn dashboard: `src/routes/burn/+page.svelte`
- Migration: `migrations/013_ink_payment.sql`

Adopters — PR yourself into the table below once you've run a production cycle.

| Project | Token | Live since | Notes |
|---|---|---|---|
| [$INKED](https://inked.money) | `2qEFJDknuak6xTCkDV7QgPyWRKvMhjvV1Spisgadbrrr` | TBD | POB model #1 reference implementation |

## Platforms / Hosts Tested

| Host | Status | Notes |
|---|---|---|
| Netlify (SvelteKit + Scheduled Functions) | Reference | $INKED runs here; cron via `netlify.toml` |
| Vercel (Next.js + Cron) | Compatible | Use `vercel.json` crons; validate `CRON_SECRET` |
| Cloudflare Workers | Partial | Edge-safe endpoints work; buyback cron needs Node-compat mode due to `@solana/web3.js` |
| Railway (Express, Node) | Compatible | See `neo-trader` pattern for Express/Node reference |

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for PR standards, provenance-tagging rules, and how to add a new sibling skill (e.g. a `printr-stake` primitive).

## Related Skills (not bundled here)

- [`pump-fun-skills`](https://github.com/pump-fun/pump-fun-skills) — the upstream inspiration. Use these for pump.fun-launched tokens.
- `printr-eco` — ecosystem primer (POB math, fee models, telecoin_id). Not bundled because it's orthogonal; install separately if you want deep Printr knowledge.
- `helius-docs` — for advanced on-chain reads, webhook-push verification as an upgrade from the RPC-pull pattern in `printr-agent-payments/references/VERIFY_ON_CHAIN.md`.

## License

MIT — see [`LICENSE`](./LICENSE).

## Acknowledgments

- The [pump.fun](https://pump.fun) team for publishing `pump-fun-skills` as an open reference. This kit's structure, safety rules, and many section templates are near-verbatim lifts with source attribution.
- The [Printr](https://printr.money) team for building the POB mechanic that makes the double-effect buyback possible.
- [Jupiter](https://jup.ag) and [Meteora](https://meteora.ag) for the routing and pool infrastructure that the swap primitive relies on.
