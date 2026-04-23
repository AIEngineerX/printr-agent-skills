// Regression tests for the startCycle ordering fix.
//
// Before the fix: `startCycle` called `verifySwapOutput` BEFORE inserting the
// burn_event row. Any error inside verifySwapOutput — including transient RPC
// failures during the post-swap ATA read — skipped the INSERT and left tokens
// on-chain with no DB record. On the next cycle, findRecoveryCycle saw the
// ATA balance but no `status='swap_done'` row and threw "manual intervention
// required", stranding the agent permanently.
//
// After the fix: the INSERT happens immediately after swap confirmation. A
// transient RPC error leaves a recoverable `status='swap_done'` row; a real
// slippage bust (SwapBelowMinimumError) flips the row to `status='failed'`
// so recovery does not auto-burn a partial fill without operator review.

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { TokenAccountNotFoundError } from '@solana/spl-token';

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

import {
  quoteSwap,
  buildSwapTransaction,
  executeServerSwap,
  verifySwapOutput,
  SwapBelowMinimumError,
} from '../src/swap/index.js';
import { startCycle, findRecoveryCycle, type CycleConfig } from '../src/tokenized-agent/index.js';
import { createTestDb, type TestDb } from './fixtures/mock-db.js';
import { createMockConnection } from './fixtures/mock-rpc.js';

const AGENT_MINT = new PublicKey(Keypair.generate().publicKey);
const SWAP_SIG = '5x7aKnownSwapSignatureForTestsOnly00000000000000000000000000000';
const QUOTE_OUT = '750000000000'; // 750 agent tokens (raw)
const QUOTE_THRESHOLD = '742500000000'; // 742.5 — 1% slippage floor
const ACTUAL_OUT = 748_000_000_000n; // happy-path actual
const PARTIAL_FILL = 600_000_000_000n; // slippage-bust actual

function fakeQuote() {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    inAmount: '290000000',
    outputMint: AGENT_MINT.toBase58(),
    outAmount: QUOTE_OUT,
    otherAmountThreshold: QUOTE_THRESHOLD,
    slippageBps: 100,
    priceImpactPct: '0.1',
    routePlan: [
      {
        swapInfo: {
          ammKey: 'fakeAmm',
          label: 'Meteora DBC',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: AGENT_MINT.toBase58(),
        },
        percent: 100,
      },
    ],
  };
}

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

describe('startCycle — burn_event row is durable across verifySwapOutput failures', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
    vi.mocked(quoteSwap).mockReset();
    vi.mocked(buildSwapTransaction).mockReset();
    vi.mocked(executeServerSwap).mockReset();
    vi.mocked(verifySwapOutput).mockReset();

    vi.mocked(quoteSwap).mockResolvedValue(fakeQuote() as any);
    vi.mocked(buildSwapTransaction).mockResolvedValue({
      tx: {} as VersionedTransaction,
      lastValidBlockHeight: 1_000_000,
    });
    vi.mocked(executeServerSwap).mockResolvedValue(SWAP_SIG);
  });

  it('transient RPC error during verifySwapOutput leaves a swap_done row recoverable next cycle', async () => {
    // Hot balance above threshold so startCycle commits to a swap.
    const hot = Keypair.generate();
    const { conn } = createMockConnection({
      balances: new Map([[hot.publicKey.toBase58(), 300_000_000]]),
    });

    // After the swap lands on-chain, the ATA read fails for transport reasons
    // — NOT a SwapBelowMinimumError. This is the exact class of failure that
    // previously stranded the cycle.
    vi.mocked(verifySwapOutput).mockRejectedValue(new Error('RPC timeout: getAccount'));

    await expect(startCycle(makeConfig(db.pool, conn, { hotKeypair: hot }))).rejects.toThrow(
      'RPC timeout: getAccount',
    );

    // The row MUST exist with status='swap_done' so findRecoveryCycle can
    // pick it up. Before the fix, zero rows existed here.
    const { rows } = await db.pool.query(`SELECT id, status, swap_sig FROM burn_event`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('swap_done');
    expect(rows[0].swap_sig).toBe(SWAP_SIG);

    // Simulate the next-cycle recovery: hot now holds the bought tokens.
    // findRecoveryCycle should read the ATA balance and return a recovery
    // plan pointing at the existing row.
    const { getAssociatedTokenAddress, AccountLayout, ACCOUNT_SIZE } =
      await import('@solana/spl-token');
    const ata = await getAssociatedTokenAddress(AGENT_MINT, hot.publicKey);
    const accountBuffer = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: AGENT_MINT,
        owner: hot.publicKey,
        amount: ACTUAL_OUT,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      accountBuffer,
    );

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const { conn: recoveryConn } = createMockConnection({
      balances: new Map([[hot.publicKey.toBase58(), 10_000_000]]),
      accountInfos: new Map([
        [
          ata.toBase58(),
          {
            executable: false,
            lamports: 2_039_280,
            owner: TOKEN_PROGRAM_ID,
            rentEpoch: 0,
            data: accountBuffer,
          },
        ],
      ]),
    });

    const recovery = await findRecoveryCycle(
      makeConfig(db.pool, recoveryConn, { hotKeypair: hot }),
    );
    expect(recovery).not.toBeNull();
    expect(recovery!.id).toBe(Number(rows[0].id));
    expect(recovery!.amountToBurn).toBe(ACTUAL_OUT);
  });

  it('SwapBelowMinimumError flips the row to status=failed with the error message recorded', async () => {
    const hot = Keypair.generate();
    const { conn } = createMockConnection({
      balances: new Map([[hot.publicKey.toBase58(), 300_000_000]]),
    });

    vi.mocked(verifySwapOutput).mockRejectedValue(
      new SwapBelowMinimumError(PARTIAL_FILL, BigInt(QUOTE_THRESHOLD)),
    );

    await expect(startCycle(makeConfig(db.pool, conn, { hotKeypair: hot }))).rejects.toBeInstanceOf(
      SwapBelowMinimumError,
    );

    const { rows } = await db.pool.query(`SELECT status, error, swap_sig FROM burn_event`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toMatch(
      /swap output below minimum: got 600000000000, expected >= 742500000000/,
    );
    expect(rows[0].swap_sig).toBe(SWAP_SIG);
  });

  it('happy path inserts with quote placeholder then updates agent_token_bought to the verified amount', async () => {
    const hot = Keypair.generate();
    const { conn } = createMockConnection({
      balances: new Map([[hot.publicKey.toBase58(), 300_000_000]]),
    });

    vi.mocked(verifySwapOutput).mockResolvedValue(ACTUAL_OUT);

    const result = await startCycle(makeConfig(db.pool, conn, { hotKeypair: hot }));
    expect(result.action).toBe('swapped');
    if (result.action !== 'swapped') throw new Error('unreachable');
    expect(result.bought).toBe(ACTUAL_OUT);
    expect(result.swapSig).toBe(SWAP_SIG);

    const { rows } = await db.pool.query(
      `SELECT status, agent_token_bought::text AS amt FROM burn_event WHERE id = $1`,
      [result.cycleId],
    );
    expect(rows[0].status).toBe('swap_done');
    // UPDATE must have rewritten the seeded threshold with the verified amount.
    expect(rows[0].amt).toBe(ACTUAL_OUT.toString());
  });

  it('findRecoveryCycle ignores rows flipped to failed (slippage bust does not auto-burn)', async () => {
    // Arrange: simulate a slippage-bust cycle that already marked the row
    // 'failed'. Then a later cron tick runs findRecoveryCycle — even if the
    // ATA still holds the partial fill, there should be no recovery plan
    // because no row has status='swap_done'.
    const hot = Keypair.generate();
    await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status, error)
       VALUES ($1, $2, 0, $3, 'failed', $4)`,
      [
        '290000000',
        PARTIAL_FILL.toString(),
        SWAP_SIG,
        'swap output below minimum: got 600000000000, expected >= 742500000000',
      ],
    );

    // ATA holds the partial fill.
    const { getAssociatedTokenAddress, AccountLayout, ACCOUNT_SIZE } =
      await import('@solana/spl-token');
    const ata = await getAssociatedTokenAddress(AGENT_MINT, hot.publicKey);
    const accountBuffer = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: AGENT_MINT,
        owner: hot.publicKey,
        amount: PARTIAL_FILL,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      accountBuffer,
    );

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const { conn } = createMockConnection({
      accountInfos: new Map([
        [
          ata.toBase58(),
          {
            executable: false,
            lamports: 2_039_280,
            owner: TOKEN_PROGRAM_ID,
            rentEpoch: 0,
            data: accountBuffer,
          },
        ],
      ]),
    });

    // No row with status='swap_done' exists, so findRecoveryCycle has nothing
    // to recover and throws the "manual intervention required" signal — which
    // now correctly points at a partial-fill situation the operator must
    // triage (see SCENARIOS.md Scenario 5 reconciliation path), instead of
    // silently auto-burning an off-tolerance fill.
    await expect(findRecoveryCycle(makeConfig(db.pool, conn, { hotKeypair: hot }))).rejects.toThrow(
      /manual intervention required/,
    );
  });
});

describe('verifySwapOutput — error type matrix', () => {
  it('TokenAccountNotFoundError is NOT a SwapBelowMinimumError', () => {
    const rpcErr = new TokenAccountNotFoundError();
    expect(rpcErr instanceof SwapBelowMinimumError).toBe(false);
  });

  it('SwapBelowMinimumError carries actual and minimum as bigint', () => {
    const err = new SwapBelowMinimumError(100n, 200n);
    expect(err.actual).toBe(100n);
    expect(err.minimum).toBe(200n);
    expect(err.name).toBe('SwapBelowMinimumError');
    expect(err.message).toBe('swap output below minimum: got 100, expected >= 200');
    expect(err).toBeInstanceOf(Error);
  });
});
