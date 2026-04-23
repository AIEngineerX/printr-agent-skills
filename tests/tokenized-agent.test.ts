import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  runBuybackCycle,
  findRecoveryCycle,
  startCycle,
  type CycleConfig,
} from '../src/tokenized-agent/index.js';
import { createTestDb, type TestDb } from './fixtures/mock-db.js';
import { createMockConnection } from './fixtures/mock-rpc.js';

const AGENT_MINT = new PublicKey(Keypair.generate().publicKey);

function makeConfig(pool: any, conn: any, overrides: Partial<CycleConfig> = {}): CycleConfig {
  return {
    pool,
    connection: conn,
    hotKeypair: Keypair.generate(),
    agentTokenMint: AGENT_MINT,
    thresholdLamports: 100_000_000n,
    maxPerCycleLamports: 1_000_000_000n,
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
    const { conn } = createMockConnection();
    const cfg = makeConfig(db.pool, conn);
    expect(await startCycle(cfg)).toEqual({
      action: 'noop',
      reason: 'below_threshold',
      hotBalance: 0n,
    });
  });

  it('returns noop when balance < threshold', async () => {
    const hot = Keypair.generate();
    const balances = new Map([[hot.publicKey.toBase58(), 50_000_000]]); // 0.05 SOL < 0.1 SOL threshold
    const { conn } = createMockConnection({ balances });
    const cfg = makeConfig(db.pool, conn, { hotKeypair: hot });
    const r = await startCycle(cfg);
    expect(r).toMatchObject({ action: 'noop', reason: 'below_threshold' });
    expect((r as any).hotBalance).toBe(50_000_000n);
  });

  it('returns noop when fee reserve eats the available balance', async () => {
    const hot = Keypair.generate();
    const balances = new Map([[hot.publicKey.toBase58(), 5_000_000]]); // 5M < FEE_RESERVE (10M)
    const { conn } = createMockConnection({ balances });
    const cfg = makeConfig(db.pool, conn, {
      hotKeypair: hot,
      thresholdLamports: 1n,
    });
    expect(await startCycle(cfg)).toMatchObject({ action: 'noop', reason: 'below_threshold' });
  });
});

describe('findRecoveryCycle', () => {
  it('returns null when the ATA does not exist', async () => {
    const { conn } = createMockConnection({ accountInfos: new Map() });
    const cfg = makeConfig(createTestDb().pool, conn);
    expect(await findRecoveryCycle(cfg)).toBe(null);
  });
});

describe('runBuybackCycle — failure-path propagation', () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it('catches preflight errors as { stage: preflight }', async () => {
    const { conn: baseConn } = createMockConnection();
    const conn = {
      ...baseConn,
      async getAccountInfo() {
        throw new Error('preflight RPC down');
      },
    };
    const r = await runBuybackCycle(makeConfig(db.pool, conn));
    expect(r.action).toBe('failed');
    if (r.action === 'failed') {
      expect(r.stage).toBe('preflight');
      expect(r.error).toMatch(/preflight RPC down/);
    }
  });

  it('catches swap-phase errors as { stage: swap }', async () => {
    const { conn: baseConn } = createMockConnection({ accountInfos: new Map() });
    const conn = {
      ...baseConn,
      async getBalance() {
        throw new Error('RPC timeout during swap phase');
      },
    };
    const r = await runBuybackCycle(makeConfig(db.pool, conn));
    expect(r.action).toBe('failed');
    if (r.action === 'failed') {
      expect(r.stage).toBe('swap');
      expect(r.error).toMatch(/RPC timeout/);
    }
  });

  it('returns noop when startCycle returns noop', async () => {
    const { conn } = createMockConnection({ accountInfos: new Map() });
    expect(await runBuybackCycle(makeConfig(db.pool, conn))).toEqual({
      action: 'noop',
      reason: 'below_threshold',
      hotBalance: 0n,
    });
  });
});
