# Contributing

Adding a new skill, improving an existing one, or fixing a documentation bug? Thank you.

## Quality bar

Every skill follows the same structural layout. Use any of the three existing skills as your template.

### Required for every SKILL.md

1. **YAML frontmatter** with `name` (must match directory name), `description` (the trigger — include specific keywords and example task phrasings), and `metadata` (author + version).
2. **`## Before Starting Work` hard-blocking checklist.** Tells the adopting agent to stop and gather prerequisites before writing any code. Use this exact phrasing: *"You MUST ask the user for ALL unchecked items in your very first response. Do not assume defaults. Do not proceed until the user has explicitly answered each one."*
3. **Safety Rules** section. Cover the universal Solana dev rules (never log private keys, never sign for user, validate amount > 0, decimal precision, always verify server-side). Add new rules as `[derived]` and document why they're needed.
4. **Environment Variables** section with the RPC guardrail (warn that public mainnet-beta doesn't support `sendTransaction`, list Helius / Ankr / PublicNode as alternatives).
5. **Install** section with explicitly pinned versions (`^1.98.0`, not `latest`).
6. **Dependency Compatibility** warning block where peer-dep mismatches are possible.
7. **Runnable TypeScript code** for every step of the flow. No pseudocode, no stubs, no `TODO:`.
8. **End-to-End Flow** numbered summary at the bottom.
9. **Composes With / When NOT to use** sections so adopters know where your skill fits in the stack.

### Required sibling files

At minimum:

- `references/SCENARIOS.md` — 3+ named scenarios ("Scenario N: Title"), each with numbered steps and expected outcomes. Include a closing **Troubleshooting** table (error → cause → fix).

Optional (add if your skill has a natural split):

- `references/WALLET_INTEGRATION.md` — if your skill has a frontend component
- `references/<DOMAIN>.md` — deep-dive technical references (e.g. `VERIFY_ON_CHAIN.md`, `CUSTODY_PATTERNS.md`)

## Provenance tags

Every non-obvious claim in a SKILL.md must be tagged with one of:

| Tag | Meaning |
|---|---|
| `[Printr]` | Verifiable against Printr's docs or live API |
| `[pattern]` | Standard Solana / SPL / Jupiter / Web3.js convention |
| `[derived]` | Author's judgment call, not grounded in any upstream spec |

Untagged claims are assumed obvious to a mid-level Solana developer. Tag when in doubt — readers need to know what to trust vs. verify.

## Testing a skill before PR

1. Copy your new skill into `~/.claude/skills/` on your dev machine.
2. Restart your agent (Claude Code, Copilot CLI, Gemini CLI, etc.).
3. Paste one of the example prompts from your skill's `description` field.
4. Confirm: (a) the skill triggers (the agent announces it), and (b) the agent walks you through the pre-work checklist before writing any code.
5. If either step fails, revise the `description` field — it's the trigger, and a bad description is the most common reason skills don't activate.

## Adding a new skill

Most likely candidates:

- **`printr-stake`** — client-side primitive for staking into POB positions (using Printr's V1 staking API). Complements `printr-swap` + `printr-agent-payments`.
- **`printr-leaderboard`** — cross-token POB ranking by stake volume / fees / stakers. Pure data-fetch + aggregation skill.
- **`printr-webhook-verify`** — Helius Enhanced Webhook alternative to `printr-agent-payments/references/VERIFY_ON_CHAIN.md`'s pull-based verify. Push model scales better for high-traffic treasuries.

If you're adding one of these (or something new), also update the root `README.md` skills table and the composition diagram.

## PR checklist

- [ ] New skill directory follows the standard layout
- [ ] `SKILL.md` has valid YAML frontmatter (parseable)
- [ ] `description` field includes concrete trigger words
- [ ] "Before Starting Work" checklist is a hard block
- [ ] Safety rules present; new rules tagged `[derived]`
- [ ] At least one sibling file in `references/`, including `SCENARIOS.md`
- [ ] All non-obvious claims are provenance-tagged
- [ ] Tested locally — skill triggers on example prompt
- [ ] Root `README.md` updated if adding a new skill
- [ ] No secrets, private keys, or `.env` content committed

## Code style inside SKILL.md examples

- **TypeScript only** for runtime code. `@solana/web3.js` + `@solana/spl-token` are TypeScript-first; adopters expect types.
- **Explicit imports.** Every example must compile as-is if pasted into a fresh project. No `// import { ... }` placeholder comments.
- **Strict types.** `bigint` for on-chain amounts, not `number`. `PublicKey` for pubkeys, not `string`. String-ify at JSON boundaries.
- **`??` for env defaults, not `||`.** Empty-string env vars should override the default only if deliberately empty; `||` falls back on empty-string, `??` only on undefined/null.
- **No try/catch for cosmetic reasons.** If you catch, explain what you're catching and why the fallback is safe. Otherwise let the error propagate — this is infrastructure, not a UI.

## Questions

Open an issue on this repo, or ping `@AIEngineerX` on X / Telegram.
