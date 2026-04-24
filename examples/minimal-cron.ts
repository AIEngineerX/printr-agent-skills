// Minimal end-to-end buyback cycle.
//
// Run:   node --env-file=.env examples/minimal-cron.js
// (after: npm install + tsc examples/minimal-cron.ts, OR run directly
//  via  npx tsx examples/minimal-cron.ts)
//
// Env vars required:
//   SOLANA_RPC_URL              — Helius / paid RPC recommended
//   DATABASE_URL                — Postgres connection string
//   TREASURY_HOT_PRIVATE_KEY    — base58 secret of the signing wallet
//   AGENT_TOKEN_MINT            — the POB token mint to buy back
//
// Env vars optional (defaults shown):
//   AGENT_TOKEN_PROGRAM=spl     — or "2022" for Token-2022 mints
//   BUYBACK_THRESHOLD_LAMPORTS=100000000
//   BUYBACK_MAX_LAMPORTS=1000000000
//   BUYBACK_SLIPPAGE_BPS=100
//
// Before the first run, apply the burn_event migration in your DB
// (schema in printr-tokenized-agent/SKILL.md §"Database Schema"). Then
// seed the hot wallet with SOL and run. Every subsequent run is
// stateless — the cycle picks up from burn_event for recovery.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

import { runBuybackCycle, type CycleConfig } from '@printr/agent-skills/tokenized-agent';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// Thin adapter from Neon's HTTP driver to the kit's QueryablePool shape.
// If you're using node-postgres, you can pass `pool` directly — it already
// has the right `.query(text, params) → { rows }` signature.
function makeNeonPool(sql: NeonQueryFunction<false, false>) {
  return {
    async query(text: string, params?: readonly unknown[]) {
      const rows = (await sql.query(text, params ? [...params] : [])) as unknown as Record<
        string,
        unknown
      >[];
      return { rows, rowCount: rows.length };
    },
  };
}

async function main() {
  const connection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
  const hotKeypair = Keypair.fromSecretKey(bs58.decode(requireEnv('TREASURY_HOT_PRIVATE_KEY')));
  const agentTokenMint = new PublicKey(requireEnv('AGENT_TOKEN_MINT'));
  const tokenProgramId =
    (process.env.AGENT_TOKEN_PROGRAM ?? '').toLowerCase().startsWith('2022') ||
    process.env.AGENT_TOKEN_PROGRAM?.toLowerCase() === 'token-2022'
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

  const sql = neon(requireEnv('DATABASE_URL'));
  const pool = makeNeonPool(sql);

  const cfg: CycleConfig = {
    pool,
    connection,
    hotKeypair,
    agentTokenMint,
    tokenProgramId,
    thresholdLamports: BigInt(process.env.BUYBACK_THRESHOLD_LAMPORTS ?? '100000000'),
    maxPerCycleLamports: BigInt(process.env.BUYBACK_MAX_LAMPORTS ?? '1000000000'),
    slippageBps: Number(process.env.BUYBACK_SLIPPAGE_BPS ?? '100'),
    // Add `autoClaim: { telecoinIds, minClaimableLamports }` to self-fund
    // from POB stake rewards. Requires the hot keypair to own the
    // positions. See printr-tokenized-agent/SKILL.md §Funding sources.
  };

  const result = await runBuybackCycle(cfg);
  console.log(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
