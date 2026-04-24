# Examples

Minimal, copy-paste starting points for using `@printr/agent-skills`.

## `minimal-cron.ts`

Full buyback cycle wired up from env vars. Shows:

- `@printr/agent-skills/tokenized-agent` → `runBuybackCycle`
- Neon Postgres HTTP driver adapted to the kit's `QueryablePool` shape
- Token-2022 program-ID routing for POB tokens (most Printr POB tokens graduated after mid-2025 are Token-2022)
- Classic + auto-claim configurations (auto-claim commented out by default)

Set the env vars in `.env`, apply the `burn_event` migration (schema in
`printr-tokenized-agent/SKILL.md` §"Database Schema"), then:

```bash
npx tsx examples/minimal-cron.ts
```

Output is a `CycleResult` serialized as JSON — inspect it for `action`, tx sigs, amounts.

## Wiring this into your scheduler

| Host                                  | How                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Netlify Functions** (Node)          | Drop into `netlify/functions/buyback.ts`; schedule via `netlify.toml`                                                              |
| **Vercel Cron** (Node)                | Mount at `/api/admin/buyback/route.ts`; schedule in `vercel.json`                                                                  |
| **Railway / Fly / VPS**               | Wrap with `node-cron` or systemd timer                                                                                             |
| **GitHub Actions**                    | Workflow on `schedule:`, curl the endpoint with a secret                                                                           |
| **Netlify Edge / Cloudflare Workers** | Currently not supported — Deno/Edge runtimes reject `node:buffer` requires in the Solana stack. See README §Runtime compatibility. |

## Adding auto-claim

Uncomment the `autoClaim` field in `minimal-cron.ts`:

```ts
autoClaim: {
  telecoinIds: ['0x...'],           // the Printr telecoin_id (hex, 32 bytes)
  minClaimableLamports: 10_000_000n, // 0.01 SOL floor — don't burn fees on dust
},
```

Requires the `hotKeypair` to own the stake positions. That widens the blast radius on a server compromise — see `printr-tokenized-agent/SKILL.md` §"Funding sources" for the security tradeoff.
