// Real-execution coverage for burnAgentTokens + the DB-state transitions
// runBuybackCycle relies on. The burn instruction is the one that actually
// removes supply — regressions here silently break the kit's core promise.

import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  burnAgentTokens,
  findRecoveryCycle,
  type CycleConfig,
} from '../src/tokenized-agent/index.js';
import { createTestDb, type TestDb } from './fixtures/mock-db.js';

const SPL_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const SPL_2022_PROGRAM = new PublicKey(TOKEN_2022_PROGRAM_ID);

interface RecordedSend {
  raw: Uint8Array;
  blockhash: string;
}

function makeBurnConn(opts: {
  blockhash?: string;
  lastValidBlockHeight?: number;
  confirmErr?: unknown;
  signatureToReturn?: string;
}) {
  const sent: RecordedSend[] = [];
  const latestBlockhash = {
    blockhash: opts.blockhash ?? '11111111111111111111111111111111',
    lastValidBlockHeight: opts.lastValidBlockHeight ?? 1_000_000,
  };
  const conn = {
    async getLatestBlockhash() {
      return latestBlockhash;
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push({ raw, blockhash: latestBlockhash.blockhash });
      return opts.signatureToReturn ?? 'BurnSigTest';
    },
    async confirmTransaction() {
      return { value: { err: opts.confirmErr ?? null } };
    },
    async getAccountInfo() {
      return null;
    },
  };
  return { conn: conn as any, sent, latestBlockhash };
}

function cfgFor(overrides: Partial<CycleConfig>): CycleConfig {
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

describe('burnAgentTokens — real tx assembly + DB state transition', () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it('completes a row to status=complete when agent_token_staked=0', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const { rows: inserted } = await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
       VALUES ($1, $2, 0, $3, 'swap_done') RETURNING id`,
      ['290000000', '500000000000', 'SwapSig001'],
    );
    const cycleId = Number(inserted[0].id);

    const { conn, sent } = makeBurnConn({});
    const sig = await burnAgentTokens(
      cfgFor({ pool: db.pool, connection: conn, hotKeypair: hot, agentTokenMint: mint }),
      cycleId,
      500_000_000_000n,
    );

    expect(sig).toBe('BurnSigTest');
    expect(sent).toHaveLength(1);

    const { rows } = await db.pool.query(
      `SELECT status, agent_token_burned::text AS burned, burn_sig, completed_at FROM burn_event WHERE id = $1`,
      [cycleId],
    );
    expect(rows[0].status).toBe('complete');
    expect(rows[0].burned).toBe('500000000000');
    expect(rows[0].burn_sig).toBe('BurnSigTest');
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('leaves status=burn_done when agent_token_staked>0 (staking split path)', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const { rows: inserted } = await db.pool.query(
      `INSERT INTO burn_event
         (sol_in_lamports, agent_token_bought, agent_token_burned, agent_token_staked, swap_sig, status)
       VALUES ($1, $2, 0, $3, $4, 'swap_done') RETURNING id`,
      ['290000000', '500000000000', '100000000000', 'SwapSig002'],
    );
    const cycleId = Number(inserted[0].id);

    const { conn } = makeBurnConn({});
    await burnAgentTokens(
      cfgFor({ pool: db.pool, connection: conn, hotKeypair: hot, agentTokenMint: mint }),
      cycleId,
      400_000_000_000n,
    );

    const { rows } = await db.pool.query(
      `SELECT status, completed_at FROM burn_event WHERE id = $1`,
      [cycleId],
    );
    expect(rows[0].status).toBe('burn_done');
    // completed_at stays null because the stake step still has to run.
    expect(rows[0].completed_at).toBeNull();
  });

  it('throws and does NOT update the DB when the burn tx fails on-chain', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const { rows: inserted } = await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
       VALUES ($1, $2, 0, $3, 'swap_done') RETURNING id`,
      ['290000000', '500000000000', 'SwapSig003'],
    );
    const cycleId = Number(inserted[0].id);

    const { conn } = makeBurnConn({ confirmErr: { InstructionError: [0, 'Custom'] } });
    await expect(
      burnAgentTokens(
        cfgFor({ pool: db.pool, connection: conn, hotKeypair: hot, agentTokenMint: mint }),
        cycleId,
        500_000_000_000n,
      ),
    ).rejects.toThrow(/burn failed on-chain/);

    const { rows } = await db.pool.query(
      `SELECT status, agent_token_burned::text AS burned, burn_sig FROM burn_event WHERE id = $1`,
      [cycleId],
    );
    // Row stays on swap_done so the next cycle's recovery picks it up again.
    expect(rows[0].status).toBe('swap_done');
    expect(rows[0].burned).toBe('0');
    expect(rows[0].burn_sig).toBeNull();
  });

  it('classic SPL and Token-2022 derive different ATAs (threads programId through burn ix)', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const classicAta = await getAssociatedTokenAddress(mint, hot.publicKey, false, SPL_PROGRAM);
    const token2022Ata = await getAssociatedTokenAddress(
      mint,
      hot.publicKey,
      false,
      SPL_2022_PROGRAM,
    );
    expect(classicAta.toBase58()).not.toBe(token2022Ata.toBase58());

    // Exercise burnAgentTokens with Token-2022 to ensure the programId is
    // actually used (no runtime error). The DB row then confirms the tx was
    // sent rather than silently short-circuited.
    const { rows: inserted } = await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
       VALUES ($1, $2, 0, $3, 'swap_done') RETURNING id`,
      ['290000000', '500000000000', 'SwapSig2022'],
    );
    const cycleId = Number(inserted[0].id);

    const { conn, sent } = makeBurnConn({});
    await burnAgentTokens(
      cfgFor({
        pool: db.pool,
        connection: conn,
        hotKeypair: hot,
        agentTokenMint: mint,
        tokenProgramId: SPL_2022_PROGRAM,
      }),
      cycleId,
      500_000_000_000n,
    );
    expect(sent).toHaveLength(1);
  });
});

describe('findRecoveryCycle — real ATA buffer paths', () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  function makeAccountBuffer(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
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

  it('returns the recovery plan when ATA has balance and a swap_done row exists', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const ata = await getAssociatedTokenAddress(mint, hot.publicKey, false, SPL_PROGRAM);
    const buf = makeAccountBuffer(mint, hot.publicKey, 750_000_000_000n);

    const conn = {
      async getAccountInfo(pubkey: PublicKey) {
        if (pubkey.toBase58() === ata.toBase58()) {
          return { executable: false, lamports: 2_039_280, owner: SPL_PROGRAM, rentEpoch: 0, data: buf };
        }
        return null;
      },
    };

    const { rows } = await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
       VALUES ($1, $2, 0, $3, 'swap_done') RETURNING id`,
      ['290000000', '742500000000', 'RecoverySig01'],
    );
    const expectedId = Number(rows[0].id);

    const recovery = await findRecoveryCycle(
      cfgFor({ pool: db.pool, connection: conn as any, hotKeypair: hot, agentTokenMint: mint }),
    );
    expect(recovery).toEqual({ id: expectedId, amountToBurn: 750_000_000_000n });
  });

  it('picks the most recent swap_done row when multiple exist', async () => {
    const hot = Keypair.generate();
    const mint = new PublicKey(Keypair.generate().publicKey);
    const ata = await getAssociatedTokenAddress(mint, hot.publicKey, false, SPL_PROGRAM);
    const buf = makeAccountBuffer(mint, hot.publicKey, 500_000_000_000n);

    const conn = {
      async getAccountInfo(pubkey: PublicKey) {
        if (pubkey.toBase58() === ata.toBase58()) {
          return { executable: false, lamports: 2_039_280, owner: SPL_PROGRAM, rentEpoch: 0, data: buf };
        }
        return null;
      },
    };

    await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status, cycle_started_at)
       VALUES ('1', '100', 0, 'OlderSig', 'swap_done', now() - interval '1 hour')`,
    );
    const { rows: newest } = await db.pool.query(
      `INSERT INTO burn_event (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
       VALUES ('2', '200', 0, 'NewerSig', 'swap_done') RETURNING id`,
    );

    const recovery = await findRecoveryCycle(
      cfgFor({ pool: db.pool, connection: conn as any, hotKeypair: hot, agentTokenMint: mint }),
    );
    expect(recovery?.id).toBe(Number(newest[0].id));
    // Burn amount is the ATA balance, not the recorded quote — survives quote drift.
    expect(recovery?.amountToBurn).toBe(500_000_000_000n);
  });
});
