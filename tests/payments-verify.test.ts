/**
 * Payment verify suite — matchers + full verifyInvoiceOnChain flow with
 * pg-mem (real Postgres semantics) + mock Connection. USDC matcher path
 * was never tested before this suite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import {
  instructionIsMemo,
  instructionIsSolTransfer,
  instructionIsUsdcTransfer,
  verifyInvoiceOnChain,
  verifyInvoiceWithRetries,
  makeTreasuryUsdcAtaCache,
  USDC_MINT,
  WSOL_MINT,
} from '../src/payments/index.js';
import { createTestDb, type TestDb } from './fixtures/mock-db.js';
import {
  createMockConnection,
  fakeMemoIxParsed,
  fakeMemoIxRaw,
  fakeSolTransferIx,
  fakeUsdcTransferCheckedIx,
  fakeTx,
} from './fixtures/mock-rpc.js';

// ═════════════════════════════════════════════════════════════════════════
// instructionIsMemo — both parsed and raw forms
// ═════════════════════════════════════════════════════════════════════════

describe('instructionIsMemo', () => {
  it('matches parsed form with correct memo', () => {
    const ix = fakeMemoIxParsed('12345');
    expect(instructionIsMemo(ix, '12345')).toBe(true);
  });

  it('rejects parsed form with wrong memo', () => {
    const ix = fakeMemoIxParsed('12345');
    expect(instructionIsMemo(ix, '99999')).toBe(false);
    expect(instructionIsMemo(ix, '1234')).toBe(false);
    expect(instructionIsMemo(ix, '')).toBe(false);
  });

  it('matches raw base58 form with correct memo', () => {
    const ix = fakeMemoIxRaw('12345');
    expect(instructionIsMemo(ix, '12345')).toBe(true);
  });

  it('rejects raw base58 form with wrong memo', () => {
    const ix = fakeMemoIxRaw('12345');
    expect(instructionIsMemo(ix, '67890')).toBe(false);
  });

  it('rejects non-memo-program instructions', () => {
    const ix = fakeSolTransferIx('s', 'd', 1n);
    expect(instructionIsMemo(ix, '12345')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// instructionIsSolTransfer
// ═════════════════════════════════════════════════════════════════════════

describe('instructionIsSolTransfer', () => {
  const from = Keypair.generate().publicKey;
  const to = Keypair.generate().publicKey;

  it('matches correct from/to/amount', () => {
    const ix = fakeSolTransferIx(from.toBase58(), to.toBase58(), 1_000_000n);
    expect(instructionIsSolTransfer(ix, from, to, 1_000_000n)).toBe(true);
  });

  it('rejects wrong source', () => {
    const ix = fakeSolTransferIx(Keypair.generate().publicKey.toBase58(), to.toBase58(), 1_000_000n);
    expect(instructionIsSolTransfer(ix, from, to, 1_000_000n)).toBe(false);
  });

  it('rejects wrong destination', () => {
    const ix = fakeSolTransferIx(from.toBase58(), Keypair.generate().publicKey.toBase58(), 1_000_000n);
    expect(instructionIsSolTransfer(ix, from, to, 1_000_000n)).toBe(false);
  });

  it('rejects wrong amount (over)', () => {
    const ix = fakeSolTransferIx(from.toBase58(), to.toBase58(), 2_000_000n);
    expect(instructionIsSolTransfer(ix, from, to, 1_000_000n)).toBe(false);
  });

  it('rejects wrong amount (under)', () => {
    const ix = fakeSolTransferIx(from.toBase58(), to.toBase58(), 500_000n);
    expect(instructionIsSolTransfer(ix, from, to, 1_000_000n)).toBe(false);
  });

  it('rejects non-system-program instructions', () => {
    const ix = fakeMemoIxParsed('12345');
    expect(instructionIsSolTransfer(ix, from, to, 1_000_000n)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// instructionIsUsdcTransfer — this path was previously 100% untested
// ═════════════════════════════════════════════════════════════════════════

describe('instructionIsUsdcTransfer', () => {
  const user = Keypair.generate().publicKey;
  const treasuryAta = 'TreasuryUsdcAta111111111111111111111111111';
  const userAta = 'UserUsdcAta2222222222222222222222222222222';

  it('matches correct transferChecked', () => {
    const ix = fakeUsdcTransferCheckedIx(userAta, treasuryAta, user.toBase58(), 1_000_000n);
    expect(instructionIsUsdcTransfer(ix, user, treasuryAta, 1_000_000n)).toBe(true);
  });

  it('rejects wrong authority', () => {
    const otherUser = Keypair.generate().publicKey;
    const ix = fakeUsdcTransferCheckedIx(userAta, treasuryAta, otherUser.toBase58(), 1_000_000n);
    expect(instructionIsUsdcTransfer(ix, user, treasuryAta, 1_000_000n)).toBe(false);
  });

  it('rejects wrong destination ATA (funds to attacker-owned ATA)', () => {
    const attackerAta = 'AttackerAta333333333333333333333333333333333';
    const ix = fakeUsdcTransferCheckedIx(userAta, attackerAta, user.toBase58(), 1_000_000n);
    expect(instructionIsUsdcTransfer(ix, user, treasuryAta, 1_000_000n)).toBe(false);
  });

  it('rejects wrong amount', () => {
    const ix = fakeUsdcTransferCheckedIx(userAta, treasuryAta, user.toBase58(), 500_000n);
    expect(instructionIsUsdcTransfer(ix, user, treasuryAta, 1_000_000n)).toBe(false);
  });

  it('rejects wrong mint on transferChecked', () => {
    const otherMint = 'OtherMint4444444444444444444444444444444444';
    const ix = fakeUsdcTransferCheckedIx(userAta, treasuryAta, user.toBase58(), 1_000_000n, 6, otherMint);
    expect(instructionIsUsdcTransfer(ix, user, treasuryAta, 1_000_000n)).toBe(false);
  });

  it('rejects non-token-program instructions', () => {
    const ix = fakeSolTransferIx(userAta, treasuryAta, 1_000_000n);
    expect(instructionIsUsdcTransfer(ix, user, treasuryAta, 1_000_000n)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// makeTreasuryUsdcAtaCache
// ═════════════════════════════════════════════════════════════════════════

describe('makeTreasuryUsdcAtaCache', () => {
  it('computes the ATA once and caches the Promise', async () => {
    const treasury = Keypair.generate().publicKey;
    const get = makeTreasuryUsdcAtaCache(treasury);

    const a = await get();
    const b = await get();

    // Both calls return the same base58 string.
    expect(a).toBe(b);

    // And it matches getAssociatedTokenAddress's result.
    const direct = (await getAssociatedTokenAddress(new PublicKey(USDC_MINT), treasury)).toBase58();
    expect(a).toBe(direct);
  });

  it('issues one Promise across concurrent callers', async () => {
    const treasury = Keypair.generate().publicKey;
    const get = makeTreasuryUsdcAtaCache(treasury);

    // 10 concurrent callers.
    const results = await Promise.all(Array.from({ length: 10 }, () => get()));
    expect(new Set(results).size).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// verifyInvoiceOnChain — full flow through pg-mem
// ═════════════════════════════════════════════════════════════════════════

describe('verifyInvoiceOnChain — flow', () => {
  let db: TestDb;
  const payer = Keypair.generate();
  const treasury = Keypair.generate();

  beforeEach(() => {
    db = createTestDb();
  });

  async function insertInvoice(overrides: Partial<{
    memo: bigint;
    user_wallet: string;
    currency_mint: string;
    amount: bigint;
    start: number;
    end: number;
    status: string;
    tx_sig: string | null;
  }> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const row = {
      memo: 7777n,
      user_wallet: payer.publicKey.toBase58(),
      currency_mint: WSOL_MINT,
      amount: 1_000_000n,
      start: now - 60,
      end: now + 3600,
      status: 'pending',
      tx_sig: null,
      ...overrides,
    };
    await db.pool.query(
      `INSERT INTO payment_invoice (memo, session_id, user_wallet, currency_mint,
         amount_smallest_unit, start_time, end_time, status, tx_sig)
       VALUES ($1, 'test', $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.memo.toString(),
        row.user_wallet,
        row.currency_mint,
        row.amount.toString(),
        row.start,
        row.end,
        row.status,
        row.tx_sig,
      ],
    );
    return row;
  }

  it('returns not_found when invoice memo is not in DB', async () => {
    const { conn } = createMockConnection();
    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 999_999n },
    );
    expect(r).toEqual({ paid: false, reason: 'not_found' });
  });

  it('returns already_marked_paid when status is cancelled', async () => {
    await insertInvoice({ memo: 1111n, status: 'cancelled' });
    const { conn } = createMockConnection();
    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 1111n },
    );
    expect(r).toEqual({ paid: false, reason: 'already_marked_paid' });
  });

  it('returns cached paid=true when invoice already has tx_sig', async () => {
    await insertInvoice({
      memo: 2222n,
      status: 'paid',
      tx_sig: 'AlreadyConfirmedSig',
    });
    const { conn, calls } = createMockConnection();
    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 2222n },
    );
    expect(r).toMatchObject({ paid: true, tx_sig: 'AlreadyConfirmedSig' });
    // Idempotent — no RPC scan performed on the cached path.
    expect(calls.getSignaturesForAddress).toHaveLength(0);
  });

  it('returns expired when end_time + grace has passed', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertInvoice({ memo: 3333n, start: now - 7200, end: now - 1000 });
    const { conn, calls } = createMockConnection();
    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 3333n },
    );
    expect(r).toEqual({ paid: false, reason: 'expired' });
    // Short-circuits — no RPC scan when expired.
    expect(calls.getSignaturesForAddress).toHaveLength(0);
  });

  it('returns not_found when treasury has no recent signatures', async () => {
    await insertInvoice({ memo: 4444n });
    const { conn } = createMockConnection({ signatures: [] });
    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 4444n },
    );
    expect(r).toEqual({ paid: false, reason: 'not_found' });
  });

  it('happy path — SOL payment matches, returns paid:true with sig', async () => {
    const row = await insertInvoice({ memo: 5555n });
    const now = Math.floor(Date.now() / 1000);
    const sig = 'GoodSig12345';

    const matchingTx = fakeTx(now - 10, [
      fakeMemoIxParsed('5555'),
      fakeSolTransferIx(
        payer.publicKey.toBase58(),
        treasury.publicKey.toBase58(),
        row.amount,
      ),
    ]);

    const { conn } = createMockConnection({
      signatures: [{ signature: sig, blockTime: now - 10 }],
      transactions: new Map([[sig, matchingTx]]),
    });

    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 5555n },
    );
    expect(r).toMatchObject({ paid: true, tx_sig: sig });
  });

  it('rejects tx with wrong amount even if memo matches', async () => {
    const row = await insertInvoice({ memo: 6666n });
    const now = Math.floor(Date.now() / 1000);
    const sig = 'WrongAmountSig';

    const wrongAmountTx = fakeTx(now - 10, [
      fakeMemoIxParsed('6666'),
      fakeSolTransferIx(
        payer.publicKey.toBase58(),
        treasury.publicKey.toBase58(),
        row.amount / 2n, // HALF the expected amount
      ),
    ]);

    const { conn } = createMockConnection({
      signatures: [{ signature: sig, blockTime: now - 10 }],
      transactions: new Map([[sig, wrongAmountTx]]),
    });

    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 6666n },
    );
    expect(r).toEqual({ paid: false, reason: 'not_found' });
  });

  it('filters out failed txs (meta.err != null)', async () => {
    const row = await insertInvoice({ memo: 8888n });
    const now = Math.floor(Date.now() / 1000);
    const sig = 'FailedSig';

    const failedTx = fakeTx(
      now - 10,
      [
        fakeMemoIxParsed('8888'),
        fakeSolTransferIx(payer.publicKey.toBase58(), treasury.publicKey.toBase58(), row.amount),
      ],
      { InstructionError: [0, 'Custom'] },
    );

    const { conn } = createMockConnection({
      signatures: [{ signature: sig, blockTime: now - 10 }],
      transactions: new Map([[sig, failedTx]]),
    });

    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 8888n },
    );
    expect(r).toEqual({ paid: false, reason: 'not_found' });
  });

  it('USDC happy path — transferChecked to treasury ATA matches', async () => {
    const amount = 1_000_000n;
    await insertInvoice({
      memo: 1200n,
      currency_mint: USDC_MINT,
      amount,
    });
    const now = Math.floor(Date.now() / 1000);
    const sig = 'UsdcGoodSig';

    const treasuryUsdcAta = (
      await getAssociatedTokenAddress(new PublicKey(USDC_MINT), treasury.publicKey)
    ).toBase58();
    const userUsdcAta = (
      await getAssociatedTokenAddress(new PublicKey(USDC_MINT), payer.publicKey)
    ).toBase58();

    const matchingTx = fakeTx(now - 5, [
      fakeMemoIxParsed('1200'),
      fakeUsdcTransferCheckedIx(userUsdcAta, treasuryUsdcAta, payer.publicKey.toBase58(), amount),
    ]);

    const { conn } = createMockConnection({
      signatures: [{ signature: sig, blockTime: now - 5 }],
      transactions: new Map([[sig, matchingTx]]),
    });

    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 1200n },
    );
    expect(r).toMatchObject({ paid: true, tx_sig: sig });
  });

  it('USDC rejects transfer to wrong destination ATA (attacker-owned)', async () => {
    const amount = 1_000_000n;
    await insertInvoice({ memo: 1300n, currency_mint: USDC_MINT, amount });
    const now = Math.floor(Date.now() / 1000);
    const sig = 'UsdcBadDestSig';

    const attackerAta = Keypair.generate().publicKey.toBase58();
    const userUsdcAta = (
      await getAssociatedTokenAddress(new PublicKey(USDC_MINT), payer.publicKey)
    ).toBase58();

    const wrongDestTx = fakeTx(now - 5, [
      fakeMemoIxParsed('1300'),
      fakeUsdcTransferCheckedIx(userUsdcAta, attackerAta, payer.publicKey.toBase58(), amount),
    ]);

    const { conn } = createMockConnection({
      signatures: [{ signature: sig, blockTime: now - 5 }],
      transactions: new Map([[sig, wrongDestTx]]),
    });

    const r = await verifyInvoiceOnChain(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      { memo: 1300n },
    );
    expect(r).toEqual({ paid: false, reason: 'not_found' });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// verifyInvoiceWithRetries — DB UPDATE idempotency (real pg-mem SQL)
// ═════════════════════════════════════════════════════════════════════════

describe('verifyInvoiceWithRetries — DB idempotency', () => {
  let db: TestDb;
  const payer = Keypair.generate();
  const treasury = Keypair.generate();

  beforeEach(() => {
    db = createTestDb();
  });

  it('first caller flips status to paid, returns true', async () => {
    const amount = 1_000_000n;
    const now = Math.floor(Date.now() / 1000);
    await db.pool.query(
      `INSERT INTO payment_invoice (memo, session_id, user_wallet, currency_mint,
         amount_smallest_unit, start_time, end_time, status)
       VALUES ($1, 'test', $2, $3, $4, $5, $6, 'pending')`,
      [
        '7700',
        payer.publicKey.toBase58(),
        WSOL_MINT,
        amount.toString(),
        now - 60,
        now + 3600,
      ],
    );

    const sig = 'IdempotentSig';
    const matchingTx = fakeTx(now - 5, [
      fakeMemoIxParsed('7700'),
      fakeSolTransferIx(payer.publicKey.toBase58(), treasury.publicKey.toBase58(), amount),
    ]);

    const { conn } = createMockConnection({
      signatures: [{ signature: sig, blockTime: now - 5 }],
      transactions: new Map([[sig, matchingTx]]),
    });

    const ok = await verifyInvoiceWithRetries(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      7700n,
      3,
      10,
    );
    expect(ok).toBe(true);

    // Row is now paid with the tx_sig recorded.
    const { rows } = await db.pool.query(`SELECT status, tx_sig FROM payment_invoice WHERE memo=$1`, ['7700']);
    expect(rows[0].status).toBe('paid');
    expect(rows[0].tx_sig).toBe(sig);
  });

  it('second caller sees paid row, returns the cached verification (no double-credit)', async () => {
    // Pre-populate the DB as if a first verify already ran.
    const amount = 1_000_000n;
    const now = Math.floor(Date.now() / 1000);
    await db.pool.query(
      `INSERT INTO payment_invoice (memo, session_id, user_wallet, currency_mint,
         amount_smallest_unit, start_time, end_time, status, tx_sig, paid_at)
       VALUES ($1, 'test', $2, $3, $4, $5, $6, 'paid', 'FirstSig', now())`,
      [
        '7800',
        payer.publicKey.toBase58(),
        WSOL_MINT,
        amount.toString(),
        now - 60,
        now + 3600,
      ],
    );

    const { conn } = createMockConnection();

    // Second call should NOT re-flip — UPDATE ... WHERE status='pending' rowCount = 0.
    const ok = await verifyInvoiceWithRetries(
      { pool: db.pool, connection: conn, treasuryPubkey: treasury.publicKey },
      7800n,
      1,
      1,
    );
    // verifyInvoiceOnChain returns paid:true with the cached sig, but the
    // UPDATE rowCount=0 (nothing matched 'pending'), so verifyInvoiceWithRetries
    // returns false — correctly signaling "don't re-credit."
    expect(ok).toBe(false);
  });
});
