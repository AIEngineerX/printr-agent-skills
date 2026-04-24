/**
 * verify-graduation.ts
 *
 * Read-only pre-flight for a Printr POB tokenized-agent buyback loop.
 * Confirms: (1) the mint is graduated to Meteora DAMM v2, (2) the DAMM v2
 * pool has enough depth to absorb your target cycle size at your target
 * slippage.
 *
 * POB fee distribution is async — LP-fee accrual + periodic distribution
 * by Printr's SVM program, NOT a per-swap hook. It cannot be proven by
 * reading one swap. For that check, use `scripts/verify-printr-mechanism.ts`
 * against Printr's staking API.
 *
 * Run:
 *   npx tsx scripts/verify-graduation.ts <MINT>
 *
 *   # With no argv, a known-graduated Token-2022 POB mint is used as a
 *   # smoke-test example so the script prints meaningful output out of
 *   # the box. Replace <MINT> to probe any other Printr POB mint.
 *   npx tsx scripts/verify-graduation.ts
 */

import { getPoolState } from '../src/swap/quote.js';
import { WSOL_MINT } from '../src/payments/constants.js';

/** Known-graduated Token-2022 POB mint used as a smoke-test default so the
 *  script demonstrates a green path out of the box. Any graduated Printr
 *  POB mint works — pass your target mint as argv to override. */
const EXAMPLE_MINT = '2qEFJDknuak6xTCkDV7QgPyWRKvMhjvV1Spisgadbrrr';

const PROBE_SIZES_LAMPORTS: ReadonlyArray<{ label: string; amount: bigint }> = [
  { label: '0.01 SOL', amount: 10_000_000n },
  { label: '0.10 SOL', amount: 100_000_000n },
  { label: '0.50 SOL', amount: 500_000_000n },
  { label: '1.00 SOL', amount: 1_000_000_000n },
];

const TARGET_SLIPPAGE_BPS = 100; // 1%

function fmtPct(pctStr: string): string {
  return `${(Number(pctStr) * 100).toFixed(4)}%`;
}

function verdict(priceImpactPct: string): string {
  const bps = Number(priceImpactPct) * 10_000;
  if (bps <= TARGET_SLIPPAGE_BPS / 2) return 'OK — well under slippage cap';
  if (bps <= TARGET_SLIPPAGE_BPS) return 'OK — within slippage cap';
  if (bps <= TARGET_SLIPPAGE_BPS * 2) return 'TIGHT — would fail at 100 bps slippage';
  return 'BUST — far above slippage cap, cycle would revert';
}

async function main() {
  const mint = process.argv[2] ?? EXAMPLE_MINT;

  console.log('');
  console.log(`Verifying graduation + pool depth for mint ${mint}`);
  console.log('─'.repeat(72));

  // 1. Graduation check — use the smallest probe for label classification.
  const graduation = await getPoolState(WSOL_MINT, mint, PROBE_SIZES_LAMPORTS[0].amount);
  const label = graduation.quote.routePlan[0]?.swapInfo.label ?? '(missing)';
  console.log(`[1] Graduation check`);
  console.log(`    Jupiter route label : "${label}"`);
  console.log(`    Classified state    : ${graduation.state}`);

  if (graduation.state === 'graduated') {
    console.log(`    → Graduated to Meteora DAMM v2. Buyback cycle is eligible.`);
    console.log(`      (POB fee distribution is checked separately — see [3].)`);
  } else if (graduation.state === 'bonding-curve') {
    console.log(`    → Still on Meteora DBC (pre-graduation). Do not run the cron —`);
    console.log(`      the LP doesn't exist yet, so buybacks can't reduce circulating`);
    console.log(`      supply through a Jupiter route. Wait for graduation.`);
    process.exit(2);
  } else {
    console.log(`    → Unknown pool label. Printr/Meteora may have renamed labels.`);
    console.log(`      Update src/swap/quote.ts classifier before proceeding.`);
    process.exit(2);
  }

  // 2. Pool-depth probes at realistic cycle sizes.
  console.log('');
  console.log(`[2] Pool-depth probes (target slippage ${TARGET_SLIPPAGE_BPS} bps)`);
  console.log('');
  console.log(
    `    Size       Out amount           Price impact   Verdict at ${TARGET_SLIPPAGE_BPS} bps cap`,
  );
  console.log(`    ─────────  ───────────────────  ─────────────  ──────────────────────────────`);

  for (const probe of PROBE_SIZES_LAMPORTS) {
    try {
      const { quote } = await getPoolState(WSOL_MINT, mint, probe.amount);
      const outAmount = quote.outAmount;
      const impact = fmtPct(quote.priceImpactPct);
      const v = verdict(quote.priceImpactPct);
      console.log(`    ${probe.label.padEnd(10)} ${outAmount.padEnd(20)} ${impact.padEnd(14)} ${v}`);
    } catch (e) {
      console.log(
        `    ${probe.label.padEnd(10)} FAILED: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Don't hammer the public Jupiter endpoint.
    await new Promise((r) => setTimeout(r, 400));
  }

  // 3. POB fee-distribution liveness — separate concern, requires Printr API.
  console.log('');
  console.log(`[3] POB fee-distribution liveness`);
  console.log('');
  console.log(`    POB fees accrue to the DAMM v2 pool's LP state and are distributed`);
  console.log(`    asynchronously by Printr's program — no per-swap signal to check here.`);
  console.log(`    Verify liveness with:`);
  console.log(`      npx tsx scripts/verify-printr-mechanism.ts <TELECOIN_ID>`);

  console.log('');
  console.log('─'.repeat(72));
  console.log('Pre-flight summary:');
  console.log(`  graduation             : PASS (${label})`);
  console.log(`  pool-depth probes      : see table above`);
  console.log(`  POB fee distribution   : check separately via verify-printr-mechanism.ts`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
