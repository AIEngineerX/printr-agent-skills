
import { describe, it, expect } from 'vitest';
import { Keypair, Transaction, PublicKey } from '@solana/web3.js';
import {
  generateInvoiceParams,
  buildPaymentTransaction,
  createMemoInstruction,
  SUPPORTED_MINTS,
  MEMO_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
  mintToCurrency,
} from '../src/payments/index.js';
import { createMockConnection } from './fixtures/mock-rpc.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

// ═════════════════════════════════════════════════════════════════════════
// generateInvoiceParams
// ═════════════════════════════════════════════════════════════════════════

describe('generateInvoiceParams — validation', () => {
  it('rejects unknown currency', () => {
    expect(() =>
      generateInvoiceParams({
        // @ts-expect-error — invalid type on purpose
        currency: 'BTC',
        price_smallest_unit: 1_000_000n,
      }),
    ).toThrow(/unknown currency/);
  });

  it('rejects price_smallest_unit <= 0', () => {
    expect(() =>
      generateInvoiceParams({ currency: 'SOL', price_smallest_unit: 0n }),
    ).toThrow(/price_smallest_unit must be > 0/);
    expect(() =>
      generateInvoiceParams({ currency: 'SOL', price_smallest_unit: -1n }),
    ).toThrow(/price_smallest_unit must be > 0/);
  });

  it('rejects durationSeconds <= 0', () => {
    expect(() =>
      generateInvoiceParams({
        currency: 'SOL',
        price_smallest_unit: 1_000_000n,
        durationSeconds: 0,
      }),
    ).toThrow(/durationSeconds must be > 0/);
    expect(() =>
      generateInvoiceParams({
        currency: 'SOL',
        price_smallest_unit: 1_000_000n,
        durationSeconds: -1,
      }),
    ).toThrow(/durationSeconds must be > 0/);
  });
});

describe('generateInvoiceParams — SOL happy path', () => {
  it('returns well-formed invoice params', () => {
    const p = generateInvoiceParams({
      currency: 'SOL',
      price_smallest_unit: 1_000_000n,
    });
    expect(p.currency_mint).toBe(WSOL_MINT);
    expect(p.currency_mint).toBe(SUPPORTED_MINTS.SOL);
    expect(p.amount_smallest_unit).toBe(1_000_000n);
    expect(p.end_time).toBe(p.start_time + 86_400);
    expect(p.memo).toBeGreaterThan(0n);
    expect(p.memo).toBeLessThan(1n << 63n);
  });
});

describe('generateInvoiceParams — USDC happy path', () => {
  it('routes to USDC mint', () => {
    const p = generateInvoiceParams({
      currency: 'USDC',
      price_smallest_unit: 50_000n, // 0.05 USDC
    });
    expect(p.currency_mint).toBe(USDC_MINT);
    expect(p.amount_smallest_unit).toBe(50_000n);
  });
});

describe('generateInvoiceParams — memo uint63 bounds', () => {
  it('masks the sign bit so memo never exceeds int64 max', () => {
    // Generate 200 memos and assert all fit.
    for (let i = 0; i < 200; i++) {
      const p = generateInvoiceParams({
        currency: 'SOL',
        price_smallest_unit: 1n,
        durationSeconds: 1,
      });
      expect(p.memo).toBeGreaterThanOrEqual(0n);
      expect(p.memo).toBeLessThan(1n << 63n);
    }
  });

  it('produces unique memos across 200 calls (astronomical collision chance)', () => {
    const memos = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateInvoiceParams({
        currency: 'SOL',
        price_smallest_unit: 1n,
        durationSeconds: 1,
      });
      memos.add(p.memo.toString());
    }
    expect(memos.size).toBe(200);
  });
});

describe('generateInvoiceParams — custom duration', () => {
  it('respects durationSeconds', () => {
    const p = generateInvoiceParams({
      currency: 'SOL',
      price_smallest_unit: 1n,
      durationSeconds: 300,
    });
    expect(p.end_time - p.start_time).toBe(300);
  });
});

describe('mintToCurrency', () => {
  it('maps wSOL and USDC correctly', () => {
    expect(mintToCurrency(WSOL_MINT)).toBe('SOL');
    expect(mintToCurrency(USDC_MINT)).toBe('USDC');
    expect(mintToCurrency('bogus')).toBe(null);
    expect(mintToCurrency('')).toBe(null);
  });
});

describe('createMemoInstruction', () => {
  it('produces the correct program ID and data', () => {
    const signer = Keypair.generate().publicKey;
    const ix = createMemoInstruction('12345', [signer]);
    expect(ix.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(Buffer.from(ix.data).toString('utf8')).toBe('12345');
    expect(ix.keys).toHaveLength(1);
    expect(ix.keys[0].pubkey.toBase58()).toBe(signer.toBase58());
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
  });

  it('accepts zero signers (memo as a tag)', () => {
    const ix = createMemoInstruction('tag-only');
    expect(ix.keys).toHaveLength(0);
    expect(Buffer.from(ix.data).toString('utf8')).toBe('tag-only');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// buildPaymentTransaction — SOL path
// ═════════════════════════════════════════════════════════════════════════

describe('buildPaymentTransaction — SOL path', () => {
  it('builds a 4-instruction tx with memo + SystemProgram.transfer', async () => {
    const { conn } = createMockConnection();
    const payer = Keypair.generate();
    const treasury = Keypair.generate();
    const base64 = await buildPaymentTransaction(conn, {
      userWallet: payer.publicKey.toBase58(),
      treasuryReceiver: treasury.publicKey.toBase58(),
      memo: 12345n,
      currency_mint: WSOL_MINT,
      amount_smallest_unit: 1_000_000n, // 0.001 SOL
    });
    expect(base64).toBeTypeOf('string');
    expect(base64.length).toBeGreaterThan(0);

    const tx = Transaction.from(Buffer.from(base64, 'base64'));
    expect(tx.instructions).toHaveLength(4);
    const [cuPrice, cuLimit, memo, transfer] = tx.instructions;
    expect(cuPrice.programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
    expect(cuLimit.programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
    expect(memo.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(Buffer.from(memo.data).toString('utf8')).toBe('12345');
    expect(transfer.programId.toBase58()).toBe(SYSTEM_PROGRAM_ID);
    expect(tx.feePayer!.toBase58()).toBe(payer.publicKey.toBase58());
  });

  it('uses the provided priorityFee micro-lamports', async () => {
    const { conn } = createMockConnection();
    const payer = Keypair.generate();
    const treasury = Keypair.generate();
    // Just verify it doesn't throw — the price-ix data is harder to
    // decode without pulling ComputeBudgetProgram's layout.
    await expect(
      buildPaymentTransaction(conn, {
        userWallet: payer.publicKey.toBase58(),
        treasuryReceiver: treasury.publicKey.toBase58(),
        memo: 42n,
        currency_mint: WSOL_MINT,
        amount_smallest_unit: 100_000n,
        priorityFeeMicroLamports: 50_000,
      }),
    ).resolves.toBeTypeOf('string');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// buildPaymentTransaction — USDC path (never tested before!)
// ═════════════════════════════════════════════════════════════════════════

describe('buildPaymentTransaction — USDC path', () => {
  it('builds a 4-instruction tx with memo + transferChecked to treasury ATA', async () => {
    const { conn } = createMockConnection();
    const payer = Keypair.generate();
    const treasury = Keypair.generate();
    const base64 = await buildPaymentTransaction(conn, {
      userWallet: payer.publicKey.toBase58(),
      treasuryReceiver: treasury.publicKey.toBase58(),
      memo: 98765n,
      currency_mint: USDC_MINT,
      amount_smallest_unit: 1_000_000n, // 1 USDC
    });

    const tx = Transaction.from(Buffer.from(base64, 'base64'));
    expect(tx.instructions).toHaveLength(4);
    const [, , memo, transferChecked] = tx.instructions;
    expect(memo.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(Buffer.from(memo.data).toString('utf8')).toBe('98765');
    expect(transferChecked.programId.toBase58()).toBe(TOKEN_PROGRAM_ID);

    // Verify the destination account is the treasury's USDC ATA.
    const expectedDestAta = await getAssociatedTokenAddress(
      new PublicKey(USDC_MINT),
      treasury.publicKey,
    );
    // transferChecked instruction accounts:
    //   [source, mint, destination, authority, ...multisigners]
    expect(transferChecked.keys[2].pubkey.toBase58()).toBe(expectedDestAta.toBase58());
  });

  it('rejects non-USDC SPL mints (prevents decimals mis-scaling)', async () => {
    const { conn } = createMockConnection();
    const payer = Keypair.generate();
    const treasury = Keypair.generate();
    const unknownMint = Keypair.generate().publicKey.toBase58();

    await expect(
      buildPaymentTransaction(conn, {
        userWallet: payer.publicKey.toBase58(),
        treasuryReceiver: treasury.publicKey.toBase58(),
        memo: 1n,
        currency_mint: unknownMint,
        amount_smallest_unit: 1_000_000n,
      }),
    ).rejects.toThrow(/unsupported currency_mint/);
  });

  it('rejects amount_smallest_unit <= 0', async () => {
    const { conn } = createMockConnection();
    const payer = Keypair.generate();
    const treasury = Keypair.generate();
    await expect(
      buildPaymentTransaction(conn, {
        userWallet: payer.publicKey.toBase58(),
        treasuryReceiver: treasury.publicKey.toBase58(),
        memo: 1n,
        currency_mint: WSOL_MINT,
        amount_smallest_unit: 0n,
      }),
    ).rejects.toThrow(/amount_smallest_unit must be > 0/);
  });
});
