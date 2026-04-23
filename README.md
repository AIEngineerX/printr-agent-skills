# printr-agent-skills

Agent Skills for building **tokenized-agent revenue loops** on [Printr](https://printr.money) — the omnichain Proof-of-Belief (POB) token launchpad.

Three composable skills:

- **`printr-swap`** — Jupiter-routed buy/sell on Meteora DBC or DAMM v2 pools. Standalone primitive; testable with a 0.001 SOL quote.
- **`printr-agent-payments`** — accept SOL or USDC payments for paid agent actions, with on-chain memo-match verification.
- **`printr-tokenized-agent`** — composes the two above, adds SPL `burn` and a scheduled hourly buyback cycle, custody-agnostic (four patterns).

Each skill auto-triggers in any compatible agent CLI when you describe a matching task, and walks you through a mandatory pre-work checklist before writing any code.

## Why this exists for Printr

Printr POB tokens live on Meteora DBC (bonding curve) and migrate to Meteora DAMM v2 on graduation. This kit builds an agent-revenue → buyback → burn loop directly on that stack: Jupiter for routing, SPL `burn` for supply reduction, memo-matched on-chain invoice verification for payment acceptance. On top of Printr's POB model the mechanic gets a genuine upgrade: **model-1 tokens pay the staking pool on every trade**, including the buyback itself. Each cycle both reduces supply AND pays stakers on its way to the burn — a double-effect that's structurally unique to Printr's fee model.

## Available Skills

| Skill | Purpose |
|-------|---------|
| [`printr-swap`](./printr-swap/SKILL.md) | Buy or sell a Printr POB token via Jupiter. Handles user-signed (wallet adapter) and server-signed (automated buyback) flows. Auto-detects bonding-curve vs graduated pool state, applies slippage protection, verifies ATA balance post-swap. |
| [`printr-agent-payments`](./printr-agent-payments/SKILL.md) | Accept SOL or USDC for paid agent actions. Generates unique memos, builds transfer txs for client signing, verifies invoices on-chain by scanning treasury signatures. UNIQUE-memo DB constraint prevents replay. |
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

## Install — any agent that supports the skill format

The YAML frontmatter format used here is supported by most modern agent CLIs. Drop the three skill directories into your agent's skills folder.

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

Copilot auto-discovers skills from installed plugins. Install as a plugin via your Copilot config, or point Copilot at a local clone.

### Gemini CLI

Activate via `activate_skill` — Gemini CLI reads the same `name` / `description` frontmatter.

### Cursor / other rule-based IDEs

Copy the SKILL.md body into your editor's rules directory (e.g. `.cursor/rules/`). The checklists and safety rules still apply; the triggering is manual rather than automatic.

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
- *"Quote a swap from SOL to `<MINT>` via Jupiter, then execute it from my treasury wallet"*
- *"Buy 0.1 SOL worth of `<MINT>` for me, signed with my Phantom wallet"*
- *"Is this token pre-graduation or graduated? Check via Jupiter route."*

**`printr-agent-payments`**
- *"Build a paywall where users pay 0.1 SOL to unlock a paid action"*
- *"Add a paid-action gate to my agent — charge 0.05 SOL per deep-analysis call"*
- *"Verify if invoice `<MEMO>` was paid on-chain"*

**`printr-tokenized-agent`**
- *"Set up a buyback-and-burn loop for my Printr POB token `<MINT>`"*
- *"Build a tokenized agent on Printr, using $INKED as the reference"*
- *"Compose `printr-swap` + `printr-agent-payments` into a full revenue loop"*

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

| Tag | Meaning |
|---|---|
| `[Printr]` | Verifiable against [printr.gitbook.io/printr-docs](https://printr.gitbook.io/printr-docs) or `api-preview.printr.money` |
| `[pattern]` | Standard Solana / SPL / Jupiter / Web3.js convention, not platform-specific |
| `[derived]` | Author's judgment. Most likely to need revision as the ecosystem evolves |

Grep for `[derived]` in any SKILL.md to see exactly what's my call vs. what's upstream-grounded fact.

## Reference Implementation

[`github.com/AIEngineerX/inked`](https://github.com/AIEngineerX/inked) — **$INKED**, the first production consumer of this kit.

| Project | Token | Live since | Notes |
|---|---|---|---|
| [$INKED](https://inked.money) | `2qEFJDknuak6xTCkDV7QgPyWRKvMhjvV1Spisgadbrrr` | TBD | POB model #1 reference implementation |

Adopters: PR yourself into this table once you've run a production cycle.

## Platforms / Hosts Tested

| Host | Status | Notes |
|---|---|---|
| Netlify (SvelteKit + Scheduled Functions) | Reference | `netlify.toml` cron pattern |
| Vercel (Next.js + Cron) | Compatible | `vercel.json` crons; validate `CRON_SECRET` |
| Cloudflare Workers | Partial | Edge endpoints work; buyback cron needs Node-compat mode for `@solana/web3.js` |
| Railway (Express, Node) | Compatible | Standard Node runtime |

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for PR standards, provenance-tagging rules, and how to add a new sibling skill (e.g. a `printr-stake` primitive).

## Related Skills (not bundled here)

- `printr-eco` — Printr ecosystem primer (POB math, fee models, telecoin_id). Orthogonal; install separately if you want deep Printr knowledge.
- `helius-docs` — advanced on-chain reads + webhook-push verification as an upgrade from the RPC-pull pattern in `printr-agent-payments/references/VERIFY_ON_CHAIN.md`.

## Security

See [`SECURITY.md`](./SECURITY.md) for the vulnerability reporting policy, response SLAs, and known non-issues.

## License

MIT — see [`LICENSE`](./LICENSE).
