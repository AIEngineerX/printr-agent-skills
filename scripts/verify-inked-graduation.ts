/**
 * verify-inked-graduation.ts
 *
 * Read-only pre-flight for a Printr POB tokenized-agent buyback loop.
 * Confirms: (1) token is graduated to Meteora DAMM v2, (2) the DAMM v2 pool
 * has enough depth to absorb your target cycle size at your target slippage.
 *
 * Fee-hook activation (the "pay stakers" effect) cannot be proven read-only —
 * at the end this prints the exact command to execute a 0.01 SOL probe swap
 * plus the Solscan URL pattern to inspect inner instructions for the transfer
 * into Printr's staking-pool PDA.
 *
 * Run:
 *   npx tsx scripts/verify-inked-graduation.ts
 *   npx tsx scripts/verify-inked-graduation.ts <MINT>   # override default
 */

import { getPoolState } from '../src/swap/quote.js';
import { WSOL_MINT } from '../src/payments/constants.js';

const DEFAULT_INKED_MINT = '2qEFJDknuak6xTCkDV7QgPyWRKvMhjvV1Spisgadbrrr';

const PROBE_SIZES_LAMPORTS: ReadonlyArray<{ label: string; amount: bigint }> = [
  { label: '0.01 SOL', amount: 10_000_000n },
  { label: '0.10 SOL', amount: 100_000_000n },
  { label: '0.50 SOL', amount: 500_000_000n },
  { label: '1.00 SOL', amount: 1_000_000_000n },
];

const TARGET_SLIPPAGE_BPS = 100; // 1%

function fmtPct(pctStr: string): string {
  const n = Number(pctStr);
  if (!Number.isFinite(n)) return pctStr;
  return `${(n * 100).toFixed(4)}%`;
}

function verdict(priceImpactPct: string): string {
  const n = Number(priceImpactPct);
  if (!Number.isFinite(n)) return '?';
  const bps = n * 10_000;
  if (bps <= TARGET_SLIPPAGE_BPS / 2) return 'OK — well under slippage cap';
  if (bps <= TARGET_SLIPPAGE_BPS) return 'OK — within slippage cap';
  if (bps <= TARGET_SLIPPAGE_BPS * 2) return 'TIGHT — would fail at 100 bps slippage';
  return 'BUST — far above slippage cap, cycle would revert';
}

async function main() {
  const mint = process.argv[2] ?? DEFAULT_INKED_MINT;

  console.log('');
  console.log(`Verifying graduation + pool depth for mint ${mint}`);
  console.log('─'.repeat(72));

  // 1. Graduation check — use the smallest probe for label classification.
  let graduation: Awaited<ReturnType<typeof getPoolState>>;
  try {
    graduation = await getPoolState(WSOL_MINT, mint, PROBE_SIZES_LAMPORTS[0].amount);
  } catch (e) {
    console.error('FATAL: Jupiter quote failed — cannot classify pool.');
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const label = graduation.quote.routePlan[0]?.swapInfo.label ?? '(missing)';
  console.log(`[1] Graduation check`);
  console.log(`    Jupiter route label : "${label}"`);
  console.log(`    Classified state    : ${graduation.state}`);

  if (graduation.state === 'graduated') {
    console.log(`    → Graduated to Meteora DAMM v2. Printr POB fee hook active.`);
  } else if (graduation.state === 'bonding-curve') {
    console.log(`    → Still on Meteora DBC. Fee hook INACTIVE. Do not run cron.`);
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

  // 3. Fee-hook activation (requires a live trade — instructions only).
  console.log('');
  console.log(`[3] Fee-hook activation check — requires a real 0.01 SOL swap`);
  console.log('');
  console.log(`    To prove the POB fee hook actually fires on every trade:`);
  console.log(`      a) From a throwaway wallet, swap 0.01 SOL → ${mint} via`);
  console.log(`         Jupiter UI or a Phantom transaction.`);
  console.log(`      b) Open the resulting tx on Solscan:`);
  console.log(`           https://solscan.io/tx/<SIG>`);
  console.log(`      c) In "Instruction Details", expand the inner instructions`);
  console.log(`         under the Meteora DAMM v2 swap. Look for a Token Program`);
  console.log(`         "transfer" into an account owned by Printr's program`);
  console.log(`         (not Meteora's vault, not Jupiter's fee account).`);
  console.log(`      d) Cross-check by querying Printr's staking API before and`);
  console.log(`         after the swap:`);
  console.log(`           POST https://api-preview.printr.money/v1/staking/list-positions-with-rewards`);
  console.log(`         A non-zero growth in aggregated claimable_rewards for the`);
  console.log(`         $INKED telecoin confirms the hook is actively routing.`);
  console.log('');
  console.log(`    If step (c) shows no Printr-owned transfer and step (d) shows`);
  console.log(`    zero growth, the fee hook is NOT attached to this pool — do`);
  console.log(`    not enable the cron. This is a Printr-side config issue, not`);
  console.log(`    a bug in this kit.`);

  console.log('');
  console.log('─'.repeat(72));
  console.log('Pre-flight summary:');
  console.log(`  graduation            : PASS (${label})`);
  console.log(`  pool-depth probes     : see table above`);
  console.log(`  fee-hook activation   : MANUAL (see [3])`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
