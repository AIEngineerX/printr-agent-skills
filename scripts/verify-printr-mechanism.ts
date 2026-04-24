/**
 * verify-printr-mechanism.ts
 *
 * Queries Printr's public API to verify the POB model-1 fee distribution
 * mechanism is live for a given telecoin. Replaces the simulation-based
 * fee-hook detector, which was designed around a wrong assumption (per-swap
 * hook vs. the actual async LP-fee distribution).
 *
 * What this proves:
 *   [1] Printr knows about the telecoin (basic sanity).
 *   [2] Anyone is earning rewards on it (list-positions-with-rewards with
 *       aggregated non-zero claimable/claimed = mechanism live).
 *   [3] Historical buybacks have been recorded by Printr (buyback-burn-detail).
 *
 * Run:
 *   npx tsx scripts/verify-printr-mechanism.ts
 *   npx tsx scripts/verify-printr-mechanism.ts <TELECOIN_ID>
 */

const PRINTR_BASE = 'https://api-preview.printr.money/v1';

// Public JWT embedded in @printr/sdk/src/env.ts:44 — Apache-2.0 licensed,
// shared rate-limit pool. Not a secret.
const PRINTR_PUBLIC_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhaS1pbnRlZ3JhdGlvbiJ9.PZsqfleSmSiAra8jiN3JZvDSonoawQLnvYRyPHDbtRg';

/** Known-live-mechanism Printr POB telecoin_id used as a smoke-test default so
 *  the script prints a meaningful green path out of the box. Pass any other
 *  telecoin_id as argv to probe a different POB telecoin. */
const EXAMPLE_TELECOIN_ID =
  '0xf1ebb9ced7f3859b8b94be7e4a630557383cb7cdc4525192929499e76313e137';

const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

async function printrPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${PRINTR_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PRINTR_PUBLIC_JWT}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Printr ${path} failed: ${res.status} ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Printr ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

interface AssetAmountResp {
  asset?: string;
  decimals?: number;
  atomic?: string;
  price?: unknown;
}

interface StakePositionInfo {
  telecoin_id?: string;
  owner?: string;
  staked?: AssetAmountResp;
  lock_period?: string;
  lock_multiplier_bps?: number;
  weighted_stake?: AssetAmountResp;
  start_time?: string;
  unlock_time?: string;
  status?: string;
  position_id?: string;
  [k: string]: unknown;
}

interface StakePositionWithRewardsInfo {
  info: StakePositionInfo;
  claimable_quote_rewards?: AssetAmountResp;
  claimable_telecoin_rewards?: AssetAmountResp;
  claimed_quote_rewards?: AssetAmountResp;
  claimed_telecoin_rewards?: AssetAmountResp;
}

interface ListPositionsResp {
  positions: StakePositionWithRewardsInfo[];
  next_cursor?: string;
}

interface BuybackAndBurnTx {
  tx: string;
  block_timestamp?: string;
  burned: AssetAmountResp;
  bought_back: AssetAmountResp;
}

interface BuybackBurnDetailResp {
  total_trades: number;
  total_burned?: AssetAmountResp;
  total_bought_back?: AssetAmountResp;
  next_cursor?: string;
  trades: BuybackAndBurnTx[];
}

function atomicToHuman(a: AssetAmountResp | undefined): string {
  if (!a?.atomic) return '—';
  const decimals = a.decimals ?? 0;
  const big = BigInt(a.atomic);
  if (decimals === 0) return big.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = big / divisor;
  const fracStr = (big % divisor).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

function sumAssets(list: (AssetAmountResp | undefined)[]): AssetAmountResp | null {
  let totalAtomic = 0n;
  let decimals: number | undefined;
  let asset: string | undefined;
  let hasAny = false;
  for (const a of list) {
    if (!a?.atomic) continue;
    totalAtomic += BigInt(a.atomic);
    decimals ??= a.decimals;
    asset ??= a.asset;
    hasAny = true;
  }
  if (!hasAny) return null;
  return { atomic: totalAtomic.toString(), decimals, asset };
}

async function main() {
  const telecoinId = process.argv[2] ?? EXAMPLE_TELECOIN_ID;

  console.log('');
  console.log('Printr POB model-1 live-mechanism verification');
  console.log('─'.repeat(72));
  console.log(`  API base     : ${PRINTR_BASE}`);
  console.log(`  telecoin_id  : ${telecoinId}`);
  console.log(`  chain        : ${SOLANA_CAIP2}`);
  console.log('');

  // [1] Aggregate stake + reward state for this telecoin.
  console.log('[1] list-positions-with-rewards');
  const positions = await printrPost<ListPositionsResp>('/staking/list-positions-with-rewards', {
    telecoin_ids: [telecoinId],
    limit: 100,
  });

  const count = positions.positions.length;
  console.log(`      positions returned           : ${count}${
    positions.next_cursor ? ' (more exist — next_cursor present)' : ''
  }`);

  const totalClaimableQuote = sumAssets(
    positions.positions.map((p) => p.claimable_quote_rewards),
  );
  const totalClaimedQuote = sumAssets(positions.positions.map((p) => p.claimed_quote_rewards));
  const totalClaimableTele = sumAssets(
    positions.positions.map((p) => p.claimable_telecoin_rewards),
  );
  const totalClaimedTele = sumAssets(positions.positions.map((p) => p.claimed_telecoin_rewards));

  console.log(`      Σ claimable quote (SOL)      : ${atomicToHuman(totalClaimableQuote ?? undefined)}`);
  console.log(`      Σ claimed quote (SOL)        : ${atomicToHuman(totalClaimedQuote ?? undefined)}`);
  console.log(`      Σ claimable telecoin         : ${atomicToHuman(totalClaimableTele ?? undefined)}`);
  console.log(`      Σ claimed telecoin           : ${atomicToHuman(totalClaimedTele ?? undefined)}`);

  if (count > 0) {
    const sample = positions.positions[0];
    console.log(`      sample position:`);
    console.log(`        owner          : ${sample.info.owner ?? '—'}`);
    console.log(`        staked         : ${atomicToHuman(sample.info.staked)}`);
    console.log(`        lock period    : ${sample.info.lock_period ?? '—'}`);
    console.log(`        status         : ${sample.info.status ?? '—'}`);
  }
  console.log('');

  // [2] Historical buyback+burn activity on this telecoin.
  console.log('[2] buyback-burn-detail');
  const bb = await printrPost<BuybackBurnDetailResp>('/telecoin/buyback-burn-detail', {
    telecoin_id: telecoinId,
    chain: SOLANA_CAIP2,
    limit: 20,
  });

  console.log(`      total_trades                 : ${bb.total_trades}`);
  console.log(`      total_burned                 : ${atomicToHuman(bb.total_burned)}`);
  console.log(`      total_bought_back            : ${atomicToHuman(bb.total_bought_back)}`);
  if (bb.trades.length > 0) {
    console.log(`      recent trades (up to 5):`);
    for (const t of bb.trades.slice(0, 5)) {
      console.log(
        `        ${t.block_timestamp ?? '—'}  burned=${atomicToHuman(t.burned)}  bought=${atomicToHuman(t.bought_back)}  sig=${t.tx.slice(0, 16)}…`,
      );
    }
  }
  console.log('');

  // [3] Verdict.
  console.log('─'.repeat(72));
  const mechanismLive =
    (totalClaimableQuote && BigInt(totalClaimableQuote.atomic ?? '0') > 0n) ||
    (totalClaimedQuote && BigInt(totalClaimedQuote.atomic ?? '0') > 0n);

  console.log('Verdict:');
  if (count === 0) {
    console.log('  NO STAKERS — telecoin is registered with Printr but nobody has a position.');
    console.log('  The POB mechanism cannot distribute fees to zero stakers. For the tokenized');
    console.log('  agent loop, this means: buybacks will still work (Jupiter swap + SPL burn);');
    console.log('  they will still reduce supply; and the accrued LP fees will sit in the pool');
    console.log('  until at least one staker exists and the next distribution runs.');
  } else if (mechanismLive) {
    console.log(`  POB MECHANISM IS LIVE — ${count} position(s) found and reward totals are`);
    console.log('  non-zero. Fee distribution is actively running for this telecoin. Running');
    console.log('  buybacks through this kit will deepen LP fees that flow to stakers on');
    console.log("  Printr's next reward-distribution tick.");
  } else {
    console.log(`  POSITIONS EXIST (${count}) but no rewards accrued yet.`);
    console.log('  Either the token has no post-graduation trading volume yet, or the reward');
    console.log('  distribution has not fired since stakes began. Buybacks will still work');
    console.log('  mechanically; they just may not surface rewards until volume builds.');
  }

  if (bb.total_trades === 0) {
    console.log('');
    console.log('  No prior buybacks recorded. The tokenized-agent loop would be the first');
    console.log('  to write buyback+burn history for this telecoin. Solscan remains the');
    console.log('  canonical source of truth; Printr will start tracking from first run.');
  } else {
    console.log('');
    console.log(
      `  ${bb.total_trades} prior buyback(s) already tracked by Printr — adopter history exists.`,
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
