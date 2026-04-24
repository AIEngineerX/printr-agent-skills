/**
 * dry-run-swap.ts
 *
 * Simulates a SOL → <mint> swap via the RPC's simulateTransaction method —
 * no SOL spent, no signature required. Use this to validate:
 *
 *   - Jupiter quotes route for the mint at your target cycle size.
 *   - The swap tx would land (simulation returns ok: true, no program error).
 *   - Compute-unit cost is within budget for your priority-fee configuration.
 *
 * What this does NOT do: verify Printr POB fee distribution. POB model-1
 * distributes fees asynchronously via Printr's SVM program, not via a
 * per-swap hook — there is no per-swap signal to detect. Use
 * `scripts/verify-printr-mechanism.ts` against Printr's API for that.
 *
 * Run:
 *   # Recommended — Helius is lenient on fee-payer existence during simulation:
 *   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \
 *     npx tsx scripts/dry-run-swap.ts
 *
 *   # Public RPC path — requires BUYER_PUBKEY to be a real funded mainnet pubkey
 *   # (public RPC rejects simulation for fee-payers that don't exist):
 *   BUYER_PUBKEY=<your-phantom-pubkey> \
 *     npx tsx scripts/dry-run-swap.ts
 *
 *   # With a specific amount:
 *   npx tsx scripts/dry-run-swap.ts 100000000      # 0.1 SOL
 *   npx tsx scripts/dry-run-swap.ts 1000000000     # 1 SOL
 *
 *   # Or against a different mint:
 *   npx tsx scripts/dry-run-swap.ts 100000000 <MINT>
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { quoteSwap, buildSwapTransaction, simulateSwap } from '../src/swap/index.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../src/payments/constants.js';

/** Known-graduated Token-2022 POB mint used as a smoke-test default so the
 *  script prints a meaningful simulation out of the box. Any Printr POB mint
 *  that routes on Jupiter works — pass your target mint as the second argv. */
const EXAMPLE_MINT = '2qEFJDknuak6xTCkDV7QgPyWRKvMhjvV1Spisgadbrrr';
const DEFAULT_AMOUNT_LAMPORTS = 100_000_000n; // 0.1 SOL — matches BUYBACK_THRESHOLD default
const SLIPPAGE_BPS = 100;

function parseArgs(): { amount: bigint; mint: string } {
  const amount = process.argv[2] ? BigInt(process.argv[2]) : DEFAULT_AMOUNT_LAMPORTS;
  if (amount <= 0n) {
    console.error('Amount must be > 0');
    process.exit(1);
  }
  return { amount, mint: process.argv[3] ?? EXAMPLE_MINT };
}

async function main() {
  const { amount, mint } = parseArgs();

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log('');
  console.log('Dry-run: SOL → agent-token swap simulation');
  console.log('─'.repeat(72));
  console.log(`  RPC         : ${rpcUrl}`);
  console.log(`  Output mint : ${mint}`);
  console.log(`  Amount      : ${amount} lamports (${Number(amount) / 1e9} SOL)`);
  console.log(`  Slippage    : ${SLIPPAGE_BPS} bps`);
  console.log('');

  // Public RPC requires the fee-payer to exist on-chain; Helius-class RPCs
  // tolerate ephemeral pubkeys. Set BUYER_PUBKEY to your funded mainnet
  // pubkey when using the public RPC.
  const buyerEnv = process.env.BUYER_PUBKEY;
  const buyerPubkey = buyerEnv ? new PublicKey(buyerEnv) : Keypair.generate().publicKey;
  const buyerSource = buyerEnv ? 'BUYER_PUBKEY env' : 'ephemeral';
  console.log(`  Simulated buyer : ${buyerPubkey.toBase58()} (${buyerSource})`);
  console.log('');

  // 1. Quote.
  console.log('[1] Quoting via Jupiter...');
  const quote = await quoteSwap({
    inputMint: WSOL_MINT,
    outputMint: mint,
    amount,
    slippageBps: SLIPPAGE_BPS,
  });
  const routeLabel = quote.routePlan[0].swapInfo.label;
  console.log(`      route label      : "${routeLabel}"`);
  console.log(`      outAmount        : ${quote.outAmount}`);
  console.log(`      minimum          : ${quote.otherAmountThreshold}`);
  console.log(`      price impact     : ${(Number(quote.priceImpactPct) * 100).toFixed(4)}%`);
  console.log('');

  // 2. Build swap tx.
  console.log('[2] Building swap transaction...');
  const { tx } = await buildSwapTransaction({
    quote,
    userPublicKey: buyerPubkey,
  });
  console.log(`      tx size (bytes) : ${tx.serialize().length}`);
  console.log('');

  // 3. Simulate.
  console.log('[3] Simulating transaction (no submission, no SOL spent)...');
  const result = await simulateSwap(connection, tx);

  console.log(`      ok                : ${result.ok}`);
  console.log(`      err               : ${result.err ? JSON.stringify(result.err) : 'null'}`);
  console.log(`      compute units     : ${result.computeUnitsConsumed ?? 'unknown'}`);
  console.log(`      inner ix groups   : ${result.innerInstructions?.length ?? 0}`);
  console.log(`      token transfers   : ${result.tokenTransferCount ?? 'unknown'}`);
  console.log('');

  // Early exit on AccountNotFound — the public RPC is strict about fee-payers.
  if (!result.ok && JSON.stringify(result.err) === '"AccountNotFound"') {
    console.log('─'.repeat(72));
    console.log('AccountNotFound from the RPC — the fee-payer pubkey does not exist');
    console.log('on mainnet. Two fixes:');
    console.log('  1. Set BUYER_PUBKEY to a real funded mainnet wallet (e.g. your Phantom');
    console.log('     pubkey — public info, no secret key needed).');
    console.log('  2. OR set SOLANA_RPC_URL to a Helius / paid RPC that tolerates missing');
    console.log('     fee-payers during simulation.');
    console.log('');
    process.exit(2);
  }

  // 4. Inner-instruction breakdown.
  if (result.innerInstructions && result.innerInstructions.length > 0) {
    console.log('[4] Token Program transfers in inner instructions:');
    let transferNum = 0;
    for (const group of result.innerInstructions) {
      for (const ix of group.instructions) {
        const programId = 'programId' in ix ? ix.programId.toBase58() : null;
        if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) continue;
        if (!('parsed' in ix) || typeof ix.parsed !== 'object' || ix.parsed === null) continue;
        const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> };
        if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue;
        transferNum++;
        const info = parsed.info ?? {};
        const programTag = programId === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'SPL-Token';
        console.log(`      #${transferNum}  ${programTag} ${parsed.type}`);
        if (typeof info.source === 'string') console.log(`          source      : ${info.source}`);
        if (typeof info.destination === 'string')
          console.log(`          destination : ${info.destination}`);
        if (typeof info.authority === 'string')
          console.log(`          authority   : ${info.authority}`);
        if (typeof info.mint === 'string') console.log(`          mint        : ${info.mint}`);
        const amountShown =
          typeof info.amount === 'string'
            ? info.amount
            : info.tokenAmount && typeof info.tokenAmount === 'object'
              ? ((info.tokenAmount as { amount?: string }).amount ?? '?')
              : '?';
        console.log(`          amount      : ${amountShown}`);
      }
    }
    console.log('');
  }

  // 5. Verdict.
  console.log('─'.repeat(72));
  console.log('Verdict:');
  if (result.ok) {
    console.log('  SIMULATION PASSED — the swap tx would land at the current pool state.');
    console.log('  Route resolved, compute cost accounted, no program error. Safe to');
    console.log('  enable a live cycle at this configuration (subject to the usual');
    console.log('  network-congestion + blockhash-expiry risks of any real tx).');
  } else {
    console.log('  SIMULATION FAILED — program error during simulation. Inspect logs');
    console.log('  below. Do NOT enable live cycles until the root cause is understood.');
  }
  console.log('');
  console.log('  For POB fee-distribution verification, see');
  console.log('  `scripts/verify-printr-mechanism.ts` — swap simulation cannot prove it.');
  console.log('');

  // 6. Logs.
  if (result.logs.length > 0) {
    console.log('Full program logs (for program-ID inspection):');
    for (const line of result.logs) console.log(`  ${line}`);
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
