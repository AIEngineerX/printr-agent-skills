// End-to-end orchestrator coverage for runBuybackCycle. Mocks only the
// swap / claim / verify primitives (which have their own unit tests + live
// tests). Everything else runs against a real pg-mem schema and realistic
// ATA account buffers encoded with @solana/spl-token's AccountLayout.

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

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
import { createTestDb, type TestDb } from './fixtures/mock-db.js';

const SPL_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const TELECOIN_ID = '0xf1ebb9ced7f3859b8b94be7e4a630557383cb7cdc4525192929499e76313e137';

const SWAP_SIG = '5x7aSwapSigForOrchestratorTests000000000000000000000000000000';
const BURN_SIG = '5x7aBurnSigForOrchestratorTests000000000000000000000000000000';
const CLAIM_SIG = 'ClaimSigForOrchestratorTests0000000000000000000000000000000000';
const QUOTE_OUT = '750000000000';
const QUOTE_THRESHOLD = '742500000000';
const BOUGHT = 748_000_000_000n;

function fakeQuote(mint: PublicKey) {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    inAmount: '290000000',
    outputMint: mint.toBase58(),
    outAmount: QUOTE_OUT,
    otherAmountThreshold: QUOTE_THRESHOLD,
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

function encodeAtaBuffer(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const buf = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
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
  return buf;
}

function makeCycleConn(opts: {
  hotBalanceLamports: bigint;
  ataAmount: bigint | null; // null = ATA does not exist yet
  owner: PublicKey;
  mint: PublicKey;
  confirmErr?: unknown;
}) {
  const sent: Uint8Array[] = [];
  const latestBlockhash = {
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 1_000_000,
  };
  let ataBuffer: Buffer | null = null;
  if (opts.ataAmount !== null) {
    ataBuffer = encodeAtaBuffer(opts.mint, opts.owner, opts.ataAmount);
  }
  const ataPromise = getAssociatedTokenAddress(opts.mint, opts.owner, false, SPL_PROGRAM);

  const conn = {
    async getBalance() {
      return Number(opts.hotBalanceLamports);
    },
    async getLatestBlockhash() {
      return latestBlockhash;
    },
    async getAccountInfo(pubkey: PublicKey) {
      const ata = await ataPromise;
      if (pubkey.toBase58() === ata.toBase58() && ataBuffer) {
        return {
          executable: false,
          lamports: 2_039_280,
          owner: SPL_PROGRAM,
          rentEpoch: 0,
          data: ataBuffer,
        };
      }
      return null;
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push(raw);
      return BURN_SIG;
    },
    async confirmTransaction() {
      return { value: { err: opts.confirmErr ?? null } };
    },
  };
  return { conn: conn as any, sent };
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

describe('runBuybackCycle — completed happy path', () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
    vi.mocked(quoteSwap).mockReset();
    vi.mocked(buildSwapTransaction).mockReset();
    vi.mocked(executeServerSwap).mockReset();
    vi.mocked(verifySwapOutput).mockReset();
    vi.mocked(claimAllAboveThreshold).mockReset();
  });

  it('returns completed with the full swap → burn chain reflected in DB', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);

    // Before swap: ATA does not exist. After verifySwapOutput resolves: the
    // swap returned BOUGHT tokens. For the subsequent burnAgentTokens call
    // the connection's sendRawTransaction simply records + returns a sig.
    const { conn } = makeCycleConn({
      hotBalanceLamports: 300_000_000n,
      ataAmount: null,
      owner: hot.publicKey,
      mint,
    });

    vi.mocked(quoteSwap).mockResolvedValue(fakeQuote(mint) as any);
    vi.mocked(buildSwapTransaction).mockResolvedValue({
      tx: {} as VersionedTransaction,
      lastValidBlockHeight: 1_000_000,
    });
    vi.mocked(executeServerSwap).mockResolvedValue(SWAP_SIG);
    vi.mocked(verifySwapOutput).mockResolvedValue(BOUGHT);

    const result = await runBuybackCycle(
      baseCfg({ pool: db.pool, connection: conn, hotKeypair: hot, agentTokenMint: mint }),
    );

    expect(result.action).toBe('completed');
    if (result.action !== 'completed') throw new Error('unreachable');
    expect(result.swapSig).toBe(SWAP_SIG);
    expect(result.burnSig).toBe(BURN_SIG);
    expect(result.solIn).toBe(290_000_000n);
    expect(result.amountBurned).toBe(BOUGHT);
    expect(result.claim).toBeUndefined();

    const { rows } = await db.pool.query(
      `SELECT status, agent_token_bought::text AS bought, agent_token_burned::text AS burned,
              swap_sig, burn_sig
         FROM burn_event WHERE id = $1`,
      [result.cycleId],
    );
    expect(rows[0].status).toBe('complete');
    expect(rows[0].bought).toBe(BOUGHT.toString());
    expect(rows[0].burned).toBe(BOUGHT.toString());
    expect(rows[0].swap_sig).toBe(SWAP_SIG);
    expect(rows[0].burn_sig).toBe(BURN_SIG);
  });
});

describe('runBuybackCycle — recovered path', () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
    vi.mocked(quoteSwap).mockReset();
    vi.mocked(buildSwapTransaction).mockReset();
    vi.mocked(executeServerSwap).mockReset();
    vi.mocked(verifySwapOutput).mockReset();
    vi.mocked(claimAllAboveThreshold).mockReset();
  });

  it('burns the stranded balance and flips the row to complete — no swap runs', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const { conn, sent } = makeCycleConn({
      hotBalanceLamports: 0n,
      ataAmount: 742_500_000_000n,
      owner: hot.publicKey,
      mint,
    });

    const { rows: inserted } = await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
       VALUES ('290000000', '742500000000', 0, $1, 'swap_done') RETURNING id`,
      [SWAP_SIG],
    );
    const strandedCycleId = Number(inserted[0].id);

    const result = await runBuybackCycle(
      baseCfg({ pool: db.pool, connection: conn, hotKeypair: hot, agentTokenMint: mint }),
    );

    expect(result.action).toBe('recovered');
    if (result.action !== 'recovered') throw new Error('unreachable');
    expect(result.cycleId).toBe(strandedCycleId);
    expect(result.burnSig).toBe(BURN_SIG);
    expect(result.amountBurned).toBe(742_500_000_000n);

    // Exactly one tx was sent (the burn). No swap-phase send happened.
    expect(sent).toHaveLength(1);
    expect(vi.mocked(quoteSwap)).not.toHaveBeenCalled();
    expect(vi.mocked(executeServerSwap)).not.toHaveBeenCalled();

    const { rows } = await db.pool.query(
      `SELECT status, burn_sig, agent_token_burned::text AS burned FROM burn_event WHERE id = $1`,
      [strandedCycleId],
    );
    expect(rows[0].status).toBe('complete');
    expect(rows[0].burn_sig).toBe(BURN_SIG);
    expect(rows[0].burned).toBe('742500000000');
  });
});

describe('runBuybackCycle — autoClaim threading', () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
    vi.mocked(quoteSwap).mockReset();
    vi.mocked(buildSwapTransaction).mockReset();
    vi.mocked(executeServerSwap).mockReset();
    vi.mocked(verifySwapOutput).mockReset();
    vi.mocked(claimAllAboveThreshold).mockReset();
  });

  it('runs Phase 0.5 claim before swap and reports the claim summary on completed', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);

    const { conn } = makeCycleConn({
      hotBalanceLamports: 300_000_000n,
      ataAmount: null,
      owner: hot.publicKey,
      mint,
    });

    vi.mocked(claimAllAboveThreshold).mockResolvedValue({
      signature: CLAIM_SIG,
      perPosition: [
        {
          position: 'pos1',
          signature: CLAIM_SIG,
          claimedQuoteLamports: 142_116_750n,
          claimedTelecoinAtomic: 5_000_000n,
        },
      ],
      totalClaimedLamports: 142_116_750n,
      totalClaimedTelecoinAtomic: 5_000_000n,
    });
    vi.mocked(quoteSwap).mockResolvedValue(fakeQuote(mint) as any);
    vi.mocked(buildSwapTransaction).mockResolvedValue({
      tx: {} as VersionedTransaction,
      lastValidBlockHeight: 1_000_000,
    });
    vi.mocked(executeServerSwap).mockResolvedValue(SWAP_SIG);
    vi.mocked(verifySwapOutput).mockResolvedValue(BOUGHT);

    const result = await runBuybackCycle(
      baseCfg({
        pool: db.pool,
        connection: conn,
        hotKeypair: hot,
        agentTokenMint: mint,
        autoClaim: {
          telecoinIds: [TELECOIN_ID],
          minClaimableLamports: 10_000_000n,
        },
      }),
    );

    expect(result.action).toBe('completed');
    if (result.action !== 'completed') throw new Error('unreachable');
    expect(result.claim).toEqual({
      signature: CLAIM_SIG,
      claimedLamports: 142_116_750n,
      claimedTelecoinAtomic: 5_000_000n,
      positionsClaimed: 1,
    });

    // Claim ran before swap.
    const claimOrder = vi.mocked(claimAllAboveThreshold).mock.invocationCallOrder[0];
    const quoteOrder = vi.mocked(quoteSwap).mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(quoteOrder);

    // claim call received the configured filters.
    const claimArgs = vi.mocked(claimAllAboveThreshold).mock.calls[0][0];
    expect(claimArgs.telecoinIds).toEqual([TELECOIN_ID]);
    expect(claimArgs.minClaimableLamports).toBe(10_000_000n);
  });

  it('proceeds to swap even when nothing is above threshold (claim returned null)', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const { conn } = makeCycleConn({
      hotBalanceLamports: 300_000_000n,
      ataAmount: null,
      owner: hot.publicKey,
      mint,
    });

    vi.mocked(claimAllAboveThreshold).mockResolvedValue(null);
    vi.mocked(quoteSwap).mockResolvedValue(fakeQuote(mint) as any);
    vi.mocked(buildSwapTransaction).mockResolvedValue({
      tx: {} as VersionedTransaction,
      lastValidBlockHeight: 1_000_000,
    });
    vi.mocked(executeServerSwap).mockResolvedValue(SWAP_SIG);
    vi.mocked(verifySwapOutput).mockResolvedValue(BOUGHT);

    const result = await runBuybackCycle(
      baseCfg({
        pool: db.pool,
        connection: conn,
        hotKeypair: hot,
        agentTokenMint: mint,
        autoClaim: { minClaimableLamports: 1_000_000n },
      }),
    );

    expect(result.action).toBe('completed');
    if (result.action !== 'completed') throw new Error('unreachable');
    expect(result.claim).toBeUndefined(); // no claim ran
  });

  it('reports stage=claim when claim phase throws', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const { conn } = makeCycleConn({
      hotBalanceLamports: 300_000_000n,
      ataAmount: null,
      owner: hot.publicKey,
      mint,
    });

    vi.mocked(claimAllAboveThreshold).mockRejectedValue(new Error('Printr claim-rewards 503'));

    const result = await runBuybackCycle(
      baseCfg({
        pool: db.pool,
        connection: conn,
        hotKeypair: hot,
        agentTokenMint: mint,
        autoClaim: { minClaimableLamports: 1_000_000n },
      }),
    );
    expect(result.action).toBe('failed');
    if (result.action !== 'failed') throw new Error('unreachable');
    expect(result.stage).toBe('claim');
    expect(result.error).toMatch(/Printr claim-rewards 503/);
    // Swap should NOT have run.
    expect(vi.mocked(quoteSwap)).not.toHaveBeenCalled();
  });
});
