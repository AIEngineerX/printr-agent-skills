// Performance pins for runBuybackCycle happy path. Fails CI on round-trip
// regressions. Swap primitives are mocked so the measurement is of the
// orchestrator's overhead + DB writes + local tx construction, independent
// of live Jupiter / RPC latency.

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';

vi.mock('../src/swap/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/swap/index.js')>('../src/swap/index.js');
  return {
    ...actual,
    quoteSwap: vi.fn(),
    buildSwapTransaction: vi.fn(),
    executeServerSwap: vi.fn(),
    verifySwapOutput: vi.fn(),
  };
});

vi.mock('../src/staking/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/staking/index.js')>('../src/staking/index.js');
  return {
    ...actual,
    claimAllAboveThreshold: vi.fn(),
  };
});

import {
  quoteSwap,
  buildSwapTransaction,
  executeServerSwap,
  verifySwapOutput,
} from '../src/swap/index.js';
import { claimAllAboveThreshold } from '../src/staking/index.js';
import { runBuybackCycle, type CycleConfig } from '../src/tokenized-agent/index.js';
import { createTestDb } from './fixtures/mock-db.js';

const SPL_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);

function fakeQuote(mint: PublicKey) {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    inAmount: '290000000',
    outputMint: mint.toBase58(),
    outAmount: '750000000000',
    otherAmountThreshold: '742500000000',
    slippageBps: 100,
    priceImpactPct: '0.1',
    routePlan: [
      {
        swapInfo: {
          ammKey: 'fakeAmm',
          label: 'Meteora DAMM v2',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: mint.toBase58(),
        },
        percent: 100,
      },
    ],
  };
}

interface RpcCallLog {
  getBalance: number;
  getAccountInfo: number;
  getLatestBlockhash: number;
  sendRawTransaction: number;
  confirmTransaction: number;
}

function instrumentedConn(hotPubkey: PublicKey) {
  const calls: RpcCallLog = {
    getBalance: 0,
    getAccountInfo: 0,
    getLatestBlockhash: 0,
    sendRawTransaction: 0,
    confirmTransaction: 0,
  };
  const conn = {
    async getBalance() {
      calls.getBalance++;
      return 300_000_000;
    },
    async getLatestBlockhash() {
      calls.getLatestBlockhash++;
      return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000_000 };
    },
    async getAccountInfo() {
      calls.getAccountInfo++;
      return null;
    },
    async sendRawTransaction() {
      calls.sendRawTransaction++;
      return 'PerfBurnSig0000000000000000000000000000000000000000000000000';
    },
    async confirmTransaction() {
      calls.confirmTransaction++;
      return { value: { err: null } };
    },
  };
  return { conn: conn as any, calls };
}

function baseCfg(overrides: Partial<CycleConfig>): CycleConfig {
  return {
    pool: {} as any,
    connection: {} as any,
    hotKeypair: Keypair.generate(),
    agentTokenMint: new PublicKey(Keypair.generate().publicKey),
    thresholdLamports: 100_000_000n,
    maxPerCycleLamports: 1_000_000_000n,
    slippageBps: 100,
    ...overrides,
  };
}

describe('runBuybackCycle — round-trip budget + latency pin', () => {
  beforeEach(() => {
    vi.mocked(quoteSwap).mockReset();
    vi.mocked(buildSwapTransaction).mockReset();
    vi.mocked(executeServerSwap).mockReset();
    vi.mocked(verifySwapOutput).mockReset();
    vi.mocked(claimAllAboveThreshold).mockReset();
  });

  it('completed cycle without autoClaim stays within round-trip + latency budget', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const db = createTestDb();

    vi.mocked(quoteSwap).mockResolvedValue(fakeQuote(mint) as any);
    vi.mocked(buildSwapTransaction).mockResolvedValue({
      tx: {} as VersionedTransaction,
      lastValidBlockHeight: 1_000_000,
    });
    vi.mocked(executeServerSwap).mockResolvedValue(
      'PerfSwapSig0000000000000000000000000000000000000000000000000000',
    );
    vi.mocked(verifySwapOutput).mockResolvedValue(748_000_000_000n);

    const { conn, calls } = instrumentedConn(hot.publicKey);

    const t0 = performance.now();
    const result = await runBuybackCycle(
      baseCfg({ pool: db.pool, connection: conn, hotKeypair: hot, agentTokenMint: mint }),
    );
    const elapsed = performance.now() - t0;

    expect(result.action).toBe('completed');

    // Round-trip budget — if any of these regress, the orchestrator is
    // doing extra network work it didn't used to.
    //
    // Expected (as of v0.2.0):
    //   getAccountInfo:       1 (findRecoveryCycle's ATA read; returns null → no recovery)
    //                       + 1 (startCycle's pre-swap ATA snapshot; returns null → 0n)
    //                       + ? (verifySwapOutput is mocked so this path is skipped)
    //   getBalance:           1 (startCycle reads hot balance)
    //   getLatestBlockhash:   1 (burnAgentTokens)
    //   sendRawTransaction:   1 (burnAgentTokens — swap's send is mocked)
    //   confirmTransaction:   1 (burnAgentTokens)
    expect(calls.getAccountInfo).toBe(2);
    expect(calls.getBalance).toBe(1);
    expect(calls.getLatestBlockhash).toBe(1);
    expect(calls.sendRawTransaction).toBe(1);
    expect(calls.confirmTransaction).toBe(1);

    // Latency budget — the orchestrator itself (not counting external I/O)
    // should complete in <500ms on any machine running vitest. This catches
    // accidental N² loops or Keypair.generate() / crypto churn inside the
    // hot path. Kept loose to avoid flakiness on slow CI runners.
    expect(elapsed).toBeLessThan(500);
  });

  it('recovered cycle has no swap round-trips and stays inside a tighter budget', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const db = createTestDb();

    // ATA pre-funded with the stranded amount.
    const buf = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint,
        owner: hot.publicKey,
        amount: 500_000_000_000n,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      buf,
    );

    const calls = {
      getBalance: 0,
      getAccountInfo: 0,
      getLatestBlockhash: 0,
      sendRawTransaction: 0,
      confirmTransaction: 0,
    };
    const conn = {
      async getBalance() {
        calls.getBalance++;
        return 300_000_000;
      },
      async getLatestBlockhash() {
        calls.getLatestBlockhash++;
        return {
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1_000_000,
        };
      },
      async getAccountInfo() {
        calls.getAccountInfo++;
        return {
          executable: false,
          lamports: 2_039_280,
          owner: SPL_PROGRAM,
          rentEpoch: 0,
          data: buf,
        };
      },
      async sendRawTransaction() {
        calls.sendRawTransaction++;
        return 'RecoveryBurnSig0000000000000000000000000000000000000000000000';
      },
      async confirmTransaction() {
        calls.confirmTransaction++;
        return { value: { err: null } };
      },
    };

    await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
       VALUES ('290000000', '500000000000', 0, 'OldSwapSig', 'swap_done')`,
    );

    const t0 = performance.now();
    const result = await runBuybackCycle(
      baseCfg({ pool: db.pool, connection: conn as any, hotKeypair: hot, agentTokenMint: mint }),
    );
    const elapsed = performance.now() - t0;

    expect(result.action).toBe('recovered');

    // Recovery skips swap entirely.
    //   getAccountInfo:     1  (findRecoveryCycle's ATA read — sees balance)
    //   getBalance:         0  (startCycle not reached)
    //   getLatestBlockhash: 1  (burnAgentTokens)
    //   sendRawTransaction: 1  (burn only)
    //   confirmTransaction: 1
    expect(calls.getAccountInfo).toBe(1);
    expect(calls.getBalance).toBe(0);
    expect(calls.sendRawTransaction).toBe(1);

    expect(elapsed).toBeLessThan(500);
  });

  it('noop path short-circuits before any on-chain send', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const db = createTestDb();

    const calls = { getBalance: 0, sendRawTransaction: 0 };
    const conn = {
      async getBalance() {
        calls.getBalance++;
        return 50_000_000; // below the 100M threshold
      },
      async getAccountInfo() {
        return null;
      },
      async getLatestBlockhash() {
        return {
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1_000_000,
        };
      },
      async sendRawTransaction() {
        calls.sendRawTransaction++;
        return 'ShouldNotBeSent';
      },
      async confirmTransaction() {
        return { value: { err: null } };
      },
    };

    const result = await runBuybackCycle(
      baseCfg({ pool: db.pool, connection: conn as any, hotKeypair: hot, agentTokenMint: mint }),
    );
    expect(result.action).toBe('noop');
    expect(calls.sendRawTransaction).toBe(0);
  });
});
