// Typed-error contracts adopters rely on for error routing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  quoteSwap,
  executeServerSwap,
  simulateSwap,
  JupiterApiError,
  SwapBelowMinimumError,
  OnChainConfirmError,
} from '../src/swap/index.js';
import { PrintrApiError, listPositionsWithRewards } from '../src/staking/index.js';

function httpResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => fetchMock.mockReset());

describe('JupiterApiError', () => {
  it('is thrown with status + path + body when Jupiter returns non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse('{"error":"service unavailable"}', 503));
    try {
      await quoteSwap({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'MintXXX11111111111111111111111111111111111',
        amount: 1_000_000n,
        slippageBps: 100,
      });
      expect.fail('expected JupiterApiError');
    } catch (e) {
      expect(e).toBeInstanceOf(JupiterApiError);
      expect(e).toBeInstanceOf(Error);
      const err = e as JupiterApiError;
      expect(err.status).toBe(503);
      expect(err.path).toContain('/swap/v1/quote');
      expect(err.body).toContain('service unavailable');
      expect(err.name).toBe('JupiterApiError');
    }
  });
});

describe('PrintrApiError', () => {
  it('is thrown with status + path + body when Printr returns non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse({ error: 'rate limited' }, 429));
    try {
      await listPositionsWithRewards({ owner: Keypair.generate().publicKey });
      expect.fail('expected PrintrApiError');
    } catch (e) {
      expect(e).toBeInstanceOf(PrintrApiError);
      expect(e).toBeInstanceOf(Error);
      const err = e as PrintrApiError;
      expect(err.status).toBe(429);
      expect(err.path).toBe('/staking/list-positions-with-rewards');
      expect(err.body).toContain('rate limited');
      expect(err.name).toBe('PrintrApiError');
    }
  });

  it('body is truncated at 400 chars to avoid unbounded error messages', async () => {
    const huge = 'x'.repeat(2000);
    fetchMock.mockResolvedValueOnce(httpResponse(huge, 500));
    try {
      await listPositionsWithRewards({ owner: Keypair.generate().publicKey });
      expect.fail('expected PrintrApiError');
    } catch (e) {
      const err = e as PrintrApiError;
      // JSON.stringify of a 2000-char string is 2002 chars (with quotes); the
      // kit slices to 400.
      expect(err.body.length).toBe(400);
    }
  });
});

describe('OnChainConfirmError', () => {
  it('carries the operation name and the underlying chain error', async () => {
    const kp = Keypair.generate();
    const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
    const message = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    const conn = {
      async sendRawTransaction() {
        return 'SigForChainErrorTest';
      },
      async confirmTransaction() {
        return { value: { err: { InstructionError: [0, 'Custom'] } } };
      },
    };

    try {
      await executeServerSwap(conn as any, tx, 1_000_000, kp);
      expect.fail('expected OnChainConfirmError');
    } catch (e) {
      expect(e).toBeInstanceOf(OnChainConfirmError);
      expect(e).toBeInstanceOf(Error);
      const err = e as OnChainConfirmError;
      expect(err.operation).toBe('swap');
      expect(err.chainError).toEqual({ InstructionError: [0, 'Custom'] });
      expect(err.name).toBe('OnChainConfirmError');
    }
  });
});

describe('error-class hierarchy — adopters can branch on instanceof', () => {
  it('all error classes are subclasses of Error', () => {
    expect(new JupiterApiError('/x', 500, '').stack).toBeDefined();
    expect(new PrintrApiError('/x', 500, '').stack).toBeDefined();
    expect(new OnChainConfirmError('test', null).stack).toBeDefined();
    expect(new SwapBelowMinimumError(1n, 2n).stack).toBeDefined();
  });

  it('classes are not confusable with each other', () => {
    const jup = new JupiterApiError('/x', 500, '');
    const printr = new PrintrApiError('/x', 500, '');
    const chain = new OnChainConfirmError('swap', null);
    const slip = new SwapBelowMinimumError(1n, 2n);

    expect(jup).not.toBeInstanceOf(PrintrApiError);
    expect(printr).not.toBeInstanceOf(JupiterApiError);
    expect(chain).not.toBeInstanceOf(SwapBelowMinimumError);
    expect(slip).not.toBeInstanceOf(OnChainConfirmError);
  });
});
