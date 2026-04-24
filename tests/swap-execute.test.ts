// Coverage for the swap primitives that were previously proven only by the
// live SKILL_LIVE suite: simulateSwap, executeServerSwap, loadHotKeypair, and
// the bonding-curve branch of getPoolState's classifier.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  executeServerSwap,
  simulateSwap,
  loadHotKeypair,
  getPoolState,
  getPoolStateOrThrow,
} from '../src/swap/index.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/payments/constants.js';

beforeEach(() => fetchMock.mockReset());
afterEach(() => fetchMock.mockReset());

// ──────────────────────────────────────────────────────────────────────────
// loadHotKeypair
// ──────────────────────────────────────────────────────────────────────────

describe('loadHotKeypair', () => {
  const originalEnv = process.env.TREASURY_HOT_PRIVATE_KEY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.TREASURY_HOT_PRIVATE_KEY;
    else process.env.TREASURY_HOT_PRIVATE_KEY = originalEnv;
  });

  it('returns a Keypair matching the env-var secret', () => {
    const kp = Keypair.generate();
    process.env.TREASURY_HOT_PRIVATE_KEY = bs58.encode(kp.secretKey);
    const loaded = loadHotKeypair();
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('throws when env is not set', () => {
    delete process.env.TREASURY_HOT_PRIVATE_KEY;
    expect(() => loadHotKeypair()).toThrow(/TREASURY_HOT_PRIVATE_KEY not set/);
  });

  it('throws when the secret has the wrong byte length', () => {
    process.env.TREASURY_HOT_PRIVATE_KEY = bs58.encode(Buffer.alloc(32)); // 32 bytes, not 64
    expect(() => loadHotKeypair()).toThrow(/expected 64-byte secret/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// getPoolState — DBC branch
// ──────────────────────────────────────────────────────────────────────────

describe('getPoolState — bonding-curve classifier branch', () => {
  function jupiterQuoteWithLabel(label: string): unknown {
    return {
      inputMint: 'So11111111111111111111111111111111111111112',
      inAmount: '10000000',
      outputMint: 'MintXXX11111111111111111111111111111111111',
      outAmount: '500000000000',
      otherAmountThreshold: '495000000000',
      slippageBps: 100,
      priceImpactPct: '0.05',
      routePlan: [
        {
          swapInfo: {
            ammKey: 'AmmXXX',
            label,
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'MintXXX11111111111111111111111111111111111',
          },
          percent: 100,
        },
      ],
    };
  }

  function httpResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }

  it('classifies "Meteora DBC" label as bonding-curve', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(jupiterQuoteWithLabel('Meteora DBC')));
    const r = await getPoolState(
      'So11111111111111111111111111111111111111112',
      'MintXXX11111111111111111111111111111111111',
      10_000_000n,
    );
    expect(r.state).toBe('bonding-curve');
  });

  it('classifies "Dynamic Bonding Curve" label as bonding-curve', async () => {
    fetchMock.mockResolvedValueOnce(
      httpResponse(jupiterQuoteWithLabel('Meteora Dynamic Bonding Curve')),
    );
    const r = await getPoolState(
      'So11111111111111111111111111111111111111112',
      'MintXXX11111111111111111111111111111111111',
      10_000_000n,
    );
    expect(r.state).toBe('bonding-curve');
  });

  it('classifies an unrecognized label as unknown, and getPoolStateOrThrow raises', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(jupiterQuoteWithLabel('SomeNewAMM')));
    const r = await getPoolState(
      'So11111111111111111111111111111111111111112',
      'MintXXX11111111111111111111111111111111111',
      10_000_000n,
    );
    expect(r.state).toBe('unknown');

    fetchMock.mockResolvedValueOnce(httpResponse(jupiterQuoteWithLabel('SomeNewAMM')));
    await expect(
      getPoolStateOrThrow(
        'So11111111111111111111111111111111111111112',
        'MintXXX11111111111111111111111111111111111',
        10_000_000n,
      ),
    ).rejects.toThrow(/unclassified AMM label "SomeNewAMM"/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// executeServerSwap — signs, sends, confirms; surfaces on-chain errors
// ──────────────────────────────────────────────────────────────────────────

function buildEmptyV0Tx(payer: PublicKey): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

describe('executeServerSwap', () => {
  it('signs, sends, confirms, returns the signature', async () => {
    const kp = Keypair.generate();
    const tx = buildEmptyV0Tx(kp.publicKey);

    let confirmedWith: { signature: string; blockhash: string; lastValidBlockHeight: number } | null =
      null;
    let sentRaw: Uint8Array | null = null;
    const conn = {
      async sendRawTransaction(raw: Uint8Array) {
        sentRaw = raw;
        return 'ExecutedSig0000000000000000000000000000000000000000000000000000';
      },
      async confirmTransaction(strategy: any) {
        confirmedWith = strategy;
        return { value: { err: null } };
      },
    };
    const sig = await executeServerSwap(conn as any, tx, 1_234_567, kp);
    expect(sig).toBe('ExecutedSig0000000000000000000000000000000000000000000000000000');
    expect(sentRaw).not.toBeNull();

    // Tx got signed with the provided keypair in-place (tx.signatures[0] is
    // now non-zero).
    expect(tx.signatures[0].some((b) => b !== 0)).toBe(true);

    // confirmTransaction received the tx's blockhash + our lastValidBlockHeight.
    expect(confirmedWith).not.toBeNull();
    expect(confirmedWith!.signature).toBe(sig);
    expect(confirmedWith!.blockhash).toBe(tx.message.recentBlockhash);
    expect(confirmedWith!.lastValidBlockHeight).toBe(1_234_567);
  });

  it('throws a descriptive error on on-chain confirm failure', async () => {
    const kp = Keypair.generate();
    const tx = buildEmptyV0Tx(kp.publicKey);
    const conn = {
      async sendRawTransaction() {
        return 'ExecErrSig000000000000000000000000000000000000000000000000000';
      },
      async confirmTransaction() {
        return { value: { err: { InstructionError: [0, 'Custom'] } } };
      },
    };
    await expect(executeServerSwap(conn as any, tx, 1_000_000, kp)).rejects.toThrow(
      /swap failed on-chain/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// simulateSwap
// ──────────────────────────────────────────────────────────────────────────

describe('simulateSwap', () => {
  it('returns ok=true + computeUnitsConsumed + innerInstructions from a mock RPC', async () => {
    const kp = Keypair.generate();
    const tx = buildEmptyV0Tx(kp.publicKey);

    const conn = {
      async simulateTransaction() {
        return {
          value: {
            err: null,
            logs: ['Program ComputeBudget1... invoke [1]', 'Program ComputeBudget1... success'],
            unitsConsumed: 95_123,
            innerInstructions: [
              {
                index: 0,
                instructions: [
                  {
                    programId: new PublicKey(TOKEN_PROGRAM_ID),
                    parsed: { type: 'transfer', info: { amount: '10000' } },
                  },
                  {
                    programId: new PublicKey(TOKEN_2022_PROGRAM_ID),
                    parsed: { type: 'transferChecked', info: { amount: '20000' } },
                  },
                  // A non-token-program ix — must not be counted.
                  {
                    programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
                    parsed: { type: 'setComputeUnitLimit', info: {} },
                  },
                  // A parsed-less ix — must not crash, must not count.
                  {
                    programId: new PublicKey(TOKEN_PROGRAM_ID),
                    accounts: [],
                    data: 'rawbase58',
                  },
                ],
              },
            ],
          },
        };
      },
    };

    const result = await simulateSwap(conn as any, tx);
    expect(result.ok).toBe(true);
    expect(result.err).toBeNull();
    expect(result.computeUnitsConsumed).toBe(95_123);
    expect(result.tokenTransferCount).toBe(2);
    expect(result.innerInstructions).not.toBeNull();
  });

  it('returns ok=false when the RPC reports an error + null computeUnits / null transfer count when inner ixs absent', async () => {
    const kp = Keypair.generate();
    const tx = buildEmptyV0Tx(kp.publicKey);
    const conn = {
      async simulateTransaction() {
        return {
          value: {
            err: 'AccountNotFound',
            logs: [],
            unitsConsumed: undefined,
            innerInstructions: null,
          },
        };
      },
    };
    const result = await simulateSwap(conn as any, tx);
    expect(result.ok).toBe(false);
    expect(result.err).toBe('AccountNotFound');
    expect(result.computeUnitsConsumed).toBeNull();
    expect(result.tokenTransferCount).toBeNull();
    expect(result.innerInstructions).toBeNull();
  });

  it('passes the expected simulateTransaction options through to the RPC', async () => {
    const kp = Keypair.generate();
    const tx = buildEmptyV0Tx(kp.publicKey);
    let receivedOpts: any = null;
    const conn = {
      async simulateTransaction(_tx: any, opts: any) {
        receivedOpts = opts;
        return { value: { err: null, logs: [], unitsConsumed: 0, innerInstructions: [] } };
      },
    };
    await simulateSwap(conn as any, tx);
    expect(receivedOpts).toEqual({
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      innerInstructions: true,
    });
  });
});
