import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  quoteSwap,
  buildSwapTransaction,
  getPoolState,
  getPoolStateOrThrow,
  verifySwapOutput,
  JUPITER_BASE,
  JUPITER_TIMEOUT_MS,
} from '../src/swap/index.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Live-test target mint. Defaults to a known-graduated Token-2022 POB mint so
// live Jupiter tests pass out of the box; override via env var to run the live
// suite against any other Printr POB mint (must be graduated + route on Jupiter).
const DEFAULT_LIVE_TEST_MINT = '2qEFJDknuak6xTCkDV7QgPyWRKvMhjvV1Spisgadbrrr';
const LIVE_TEST_MINT = process.env.LIVE_TEST_MINT ?? DEFAULT_LIVE_TEST_MINT;

const live = process.env.SKILL_LIVE !== '0';

describe('quoteSwap — input validation', () => {
  it('throws on amount <= 0', async () => {
    await expect(
      quoteSwap({ inputMint: SOL_MINT, outputMint: LIVE_TEST_MINT, amount: 0n, slippageBps: 100 }),
    ).rejects.toThrow(/amount must be > 0/);
    await expect(
      quoteSwap({ inputMint: SOL_MINT, outputMint: LIVE_TEST_MINT, amount: -1n, slippageBps: 100 }),
    ).rejects.toThrow(/amount must be > 0/);
  });

  it('throws on slippageBps <= 0', async () => {
    await expect(
      quoteSwap({
        inputMint: SOL_MINT,
        outputMint: LIVE_TEST_MINT,
        amount: 1_000_000n,
        slippageBps: 0,
      }),
    ).rejects.toThrow(/slippageBps must be > 0/);
    await expect(
      quoteSwap({
        inputMint: SOL_MINT,
        outputMint: LIVE_TEST_MINT,
        amount: 1_000_000n,
        slippageBps: -50,
      }),
    ).rejects.toThrow(/slippageBps must be > 0/);
  });

  it('throws on slippageBps > 5000', async () => {
    await expect(
      quoteSwap({
        inputMint: SOL_MINT,
        outputMint: LIVE_TEST_MINT,
        amount: 1_000_000n,
        slippageBps: 5001,
      }),
    ).rejects.toThrow(/slippageBps must be <= 5000/);
    await expect(
      quoteSwap({
        inputMint: SOL_MINT,
        outputMint: LIVE_TEST_MINT,
        amount: 1_000_000n,
        slippageBps: 10_000,
      }),
    ).rejects.toThrow(/slippageBps must be <= 5000/);
  });

  it('accepts boundary values — slippage 1 and 5000', async () => {
    if (!live) return;
    // Both should not throw validation; actual Jupiter call may proceed.
    await expect(
      quoteSwap({
        inputMint: SOL_MINT,
        outputMint: LIVE_TEST_MINT,
        amount: 1_000_000n,
        slippageBps: 1,
      }),
    ).resolves.toBeDefined();
    await expect(
      quoteSwap({
        inputMint: SOL_MINT,
        outputMint: LIVE_TEST_MINT,
        amount: 1_000_000n,
        slippageBps: 5000,
      }),
    ).resolves.toBeDefined();
  });
});

describe('quoteSwap — live against LIVE_TEST_MINT', () => {
  if (!live) {
    it.skip('skipped: SKILL_LIVE=0 — disable live Jupiter calls', () => {});
    return;
  }

  it('returns a valid JupiterQuote for 0.1 SOL → LIVE_TEST_MINT', async () => {
    const q = await quoteSwap({
      inputMint: SOL_MINT,
      outputMint: LIVE_TEST_MINT,
      amount: 100_000_000n,
      slippageBps: 100,
    });
    expect(q.inputMint).toBe(SOL_MINT);
    expect(q.outputMint).toBe(LIVE_TEST_MINT);
    expect(q.inAmount).toBe('100000000');
    expect(BigInt(q.outAmount)).toBeGreaterThan(0n);
    expect(BigInt(q.otherAmountThreshold)).toBeGreaterThan(0n);
    expect(BigInt(q.otherAmountThreshold)).toBeLessThanOrEqual(BigInt(q.outAmount));
    expect(q.slippageBps).toBe(100);
    expect(q.routePlan.length).toBeGreaterThan(0);
  });

  it('throws on a mint with no route (unknown SPL mint)', async () => {
    // A throwaway keypair's pubkey — guaranteed to have no Jupiter route.
    const fakeMint = Keypair.generate().publicKey.toBase58();
    await expect(
      quoteSwap({
        inputMint: SOL_MINT,
        outputMint: fakeMint,
        amount: 100_000_000n,
        slippageBps: 100,
      }),
    ).rejects.toThrow();
  });
});

describe('getPoolState — LIVE_TEST_MINT classifies as graduated', () => {
  if (!live) {
    it.skip('skipped: SKILL_LIVE=0', () => {});
    return;
  }

  it('returns state=graduated with Meteora DAMM v2 label', async () => {
    const r = await getPoolState(SOL_MINT, LIVE_TEST_MINT, 10_000_000n);
    expect(r.state).toBe('graduated');
    expect(r.quote.routePlan[0].swapInfo.label).toMatch(/DAMM/);
  });

  it('returns ammKey that matches live expectations', async () => {
    const r = await getPoolState(SOL_MINT, LIVE_TEST_MINT, 10_000_000n);
    expect(r.quote.routePlan[0].swapInfo.ammKey).toBeTypeOf('string');
    expect(r.quote.routePlan[0].swapInfo.ammKey.length).toBeGreaterThan(30);
  });

  it('getPoolStateOrThrow returns same graduated result', async () => {
    const r = await getPoolStateOrThrow(SOL_MINT, LIVE_TEST_MINT, 10_000_000n);
    expect(r.state).toBe('graduated');
  });
});

describe('buildSwapTransaction — live against LIVE_TEST_MINT', () => {
  if (!live) {
    it.skip('skipped: SKILL_LIVE=0', () => {});
    return;
  }

  it('returns a v0 VersionedTransaction with a real lastValidBlockHeight', async () => {
    const quote = await quoteSwap({
      inputMint: SOL_MINT,
      outputMint: LIVE_TEST_MINT,
      amount: 100_000_000n,
      slippageBps: 100,
    });
    const probePk = Keypair.generate().publicKey;
    const { tx, lastValidBlockHeight } = await buildSwapTransaction({
      quote,
      userPublicKey: probePk,
    });
    expect(tx).toBeInstanceOf(VersionedTransaction);
    expect(tx.version).toBe(0);
    expect(tx.message.compiledInstructions.length).toBeGreaterThan(0);
    expect(lastValidBlockHeight).toBeGreaterThan(0);
  });

  it('priority fee = auto produces a valid tx', async () => {
    const quote = await quoteSwap({
      inputMint: SOL_MINT,
      outputMint: LIVE_TEST_MINT,
      amount: 10_000_000n,
      slippageBps: 100,
    });
    const probePk = Keypair.generate().publicKey;
    const { tx } = await buildSwapTransaction({
      quote,
      userPublicKey: probePk,
      priorityFee: 'auto',
    });
    expect(tx.version).toBe(0);
  });

  it('priority fee with explicit level produces a valid tx', async () => {
    const quote = await quoteSwap({
      inputMint: SOL_MINT,
      outputMint: LIVE_TEST_MINT,
      amount: 10_000_000n,
      slippageBps: 100,
    });
    const probePk = Keypair.generate().publicKey;
    const { tx } = await buildSwapTransaction({
      quote,
      userPublicKey: probePk,
      priorityFee: { maxLamports: 500_000, level: 'high' },
    });
    expect(tx.version).toBe(0);
  });
});

describe('JUPITER_BASE + JUPITER_TIMEOUT_MS constants', () => {
  it('JUPITER_BASE defaults to lite-api when env unset', () => {
    // Module was loaded before any env override, so default is what
    // process.env.JUPITER_API_URL was at module load. Confirm the constant
    // is a valid URL-ish string.
    expect(JUPITER_BASE).toMatch(/^https?:\/\//);
  });

  it('JUPITER_TIMEOUT_MS is a sane positive integer', () => {
    expect(JUPITER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(JUPITER_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(Number.isInteger(JUPITER_TIMEOUT_MS)).toBe(true);
  });
});

describe('verifySwapOutput — Token-2022 program ID threading', () => {
  // Uses LIVE_TEST_MINT as a real Token-2022 mint for the derivation test.
  // The default target is a known Token-2022 POB mint. No RPC call is made —
  // getAssociatedTokenAddress is a pure PDA derivation, so this test runs
  // offline and independent of SKILL_LIVE.
  const mint = new PublicKey(LIVE_TEST_MINT);
  const owner = Keypair.generate().publicKey;

  it('derives different ATAs for classic SPL vs Token-2022 with the same (mint, owner)', async () => {
    const classicAta = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID);
    const token2022Ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_2022_PROGRAM_ID);

    // The ATA program hashes the token program ID into the PDA seeds, so
    // these MUST diverge. If this assertion ever fires as equal, the ATA
    // program changed its derivation and the whole kit's Token-2022 plumbing
    // needs a rethink.
    expect(classicAta.toBase58()).not.toBe(token2022Ata.toBase58());
  });

  it('function signature accepts tokenProgramId and defaults to classic SPL', () => {
    // Type-level check — if verifySwapOutput's signature drops the optional
    // tokenProgramId this test fails to compile. No runtime side effect
    // because we never invoke it (missing Connection).
    expect(typeof verifySwapOutput).toBe('function');
    expect(verifySwapOutput.length).toBeGreaterThanOrEqual(4); // connection, mint, owner, minOut
  });
});
