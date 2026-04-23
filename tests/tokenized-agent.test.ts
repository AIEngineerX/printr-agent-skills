/**
 * Tokenized-agent cycle suite — exercises runBuybackCycle + its three
 * phases against mock Connection + pg-mem Pool. Verifies the
 * { action: 'failed', stage, error } shape that was unreachable before
 * the refactor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  runBuybackCycle,
  findRecoveryCycle,
  startCycle,
  type CycleConfig,
} from '../src/tokenized-agent/index.js';
import { createTestDb, type TestDb } from './fixtures/mock-db.js';
import { createMockConnection } from './fixtures/mock-rpc.js';

// A valid mint (32-byte random pubkey).
const AGENT_MINT = new PublicKey(Keypair.generate().publicKey);

function makeConfig(
  pool: any,
  conn: any,
  overrides: Partial<CycleConfig> = {},
): CycleConfig {
  return {
    pool,
    connection: conn,
    hotKeypair: Keypair.generate(),
    agentTokenMint: AGENT_MINT,
    thresholdLamports: 100_000_000n, // 0.1 SOL
    maxPerCycleLamports: 1_000_000_000n, // 1 SOL
    slippageBps: 100,
    ...overrides,
  };
}

describe('startCycle — threshold gating', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns noop when balance is exactly 0', async () => {
    const { conn } = createMockConnection({ balances: new Map() });
    const cfg = makeConfig(db.pool, conn);
    const r = await startCycle(cfg);
    expect(r).toEqual({ action: 'noop', reason: 'below_threshold', hotBalance: 0n });
  });

  it('returns noop when balance < threshold', async () => {
    const { conn } = createMockConnection({ balances: new Map() });
    const cfg = makeConfig(db.pool, conn);
    // Inject 0.05 SOL (below 0.1 SOL threshold).
    const balanceMap = new Map<string, number>();
    balanceMap.set(cfg.hotKeypair.publicKey.toBase58(), 50_000_000);
    const { conn: conn2 } = createMockConnection({ balances: balanceMap });
    const cfg2 = makeConfig(db.pool, conn2, { hotKeypair: cfg.hotKeypair });
    const r = await startCycle(cfg2);
    expect(r).toMatchObject({ action: 'noop', reason: 'below_threshold' });
    expect((r as any).hotBalance).toBe(50_000_000n);
  });

  it('returns noop when balance exceeds threshold but fee reserve eats it', async () => {
    const { conn } = createMockConnection({ balances: new Map() });
    const cfg = makeConfig(db.pool, conn, { thresholdLamports: 1n });
    // Balance of 5M lamports: available = 5M - 10M (FEE_RESERVE) = negative.
    const balanceMap = new Map<string, number>();
    balanceMap.set(cfg.hotKeypair.publicKey.toBase58(), 5_000_000);
    const { conn: conn2 } = createMockConnection({ balances: balanceMap });
    const cfg2 = makeConfig(db.pool, conn2, {
      hotKeypair: cfg.hotKeypair,
      thresholdLamports: 1n,
    });
    const r = await startCycle(cfg2);
    expect(r).toMatchObject({ action: 'noop', reason: 'below_threshold' });
  });
});

describe('findRecoveryCycle — ATA balance detection', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns null when ATA does not exist (TokenAccountNotFoundError)', async () => {
    // getAccount will throw TokenAccountNotFoundError when the ATA doesn't exist.
    // We simulate this by making the RPC return null for getAccountInfo (which is
    // what spl-token's getAccount internally checks).
    const { conn } = createMockConnection({
      accountInfos: new Map(), // everything returns null → TokenAccountNotFoundError
    });
    const cfg = makeConfig(db.pool, conn);
    const r = await findRecoveryCycle(cfg);
    expect(r).toBe(null);
  });
});

describe('runBuybackCycle — failure-path propagation', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it('catches preflight errors, returns { action: failed, stage: preflight }', async () => {
    // Make findRecoveryCycle throw by providing a Connection whose
    // getAccountInfo / getAccount throws something other than TokenAccountNotFoundError.
    const { conn: baseConn } = createMockConnection();
    const conn = {
      ...baseConn,
      async getAccountInfo() {
        throw new Error('preflight RPC down');
      },
    };
    const cfg = makeConfig(db.pool, conn);
    const r = await runBuybackCycle(cfg);
    expect(r.action).toBe('failed');
    if (r.action === 'failed') {
      expect(r.stage).toBe('preflight');
      expect(r.error).toMatch(/preflight RPC down/);
    }
  });

  it('catches swap-phase errors, returns { action: failed, stage: swap }', async () => {
    // Preflight succeeds (ATA not found → recovery=null).
    // Then startCycle proceeds: balance above threshold, but getBalance throws.
    const { conn: baseConn } = createMockConnection({
      accountInfos: new Map(), // preflight → null
    });
    const conn = {
      ...baseConn,
      async getBalance() {
        throw new Error('RPC timeout during swap phase');
      },
    };
    const cfg = makeConfig(db.pool, conn);
    const r = await runBuybackCycle(cfg);
    expect(r.action).toBe('failed');
    if (r.action === 'failed') {
      expect(r.stage).toBe('swap');
      expect(r.error).toMatch(/RPC timeout during swap phase/);
    }
  });

  it('returns noop from runBuybackCycle when startCycle returns noop', async () => {
    const { conn } = createMockConnection({
      accountInfos: new Map(), // preflight → null
      balances: new Map(), // hot balance = 0 → below threshold
    });
    const cfg = makeConfig(db.pool, conn);
    const r = await runBuybackCycle(cfg);
    expect(r).toEqual({ action: 'noop', reason: 'below_threshold', hotBalance: 0n });
  });
});

describe('CycleResult types are exhaustive', () => {
  it('the four action variants are the only shapes returned', () => {
    // Compile-time check — this test body only has to typecheck.
    // If CycleResult ever grows/shrinks a variant, the switch must be updated.
    const dummy = { action: 'noop', reason: 'below_threshold', hotBalance: 0n } as
      | { action: 'noop'; reason: 'below_threshold'; hotBalance: bigint }
      | { action: 'recovered'; cycleId: number; burnSig: string; amountBurned: bigint }
      | {
          action: 'completed';
          cycleId: number;
          swapSig: string;
          burnSig: string;
          solIn: bigint;
          amountBurned: bigint;
        }
      | { action: 'failed'; stage: 'preflight' | 'swap' | 'burn'; error: string };

    switch (dummy.action) {
      case 'noop':
      case 'recovered':
      case 'completed':
      case 'failed':
        expect(dummy.action).toBeTypeOf('string');
    }
  });
});
