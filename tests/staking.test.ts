import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

// Mock fetch at the module level so listPositionsWithRewards + claim-rewards
// HTTP calls stay offline. Individual tests override the response per-case.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  claimAllAboveThreshold,
  claimRewards,
  listPositionsWithRewards,
  solanaCaip10,
} from '../src/staking/index.js';

function mkFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const OWNER_PUBKEY = 'FxXdFN89bdq6cBjEosuz5LnQvwW1VQiGULfX2CqKdUX3';
const POS_1 = 'pos1eydjZyw3WjXoQMXhkKHi3uwXAKuGSUibCpDMm';
const POS_2 = 'pos2eydjZyw3WjXoQMXhkKHi3uwXAKuGSUibCpDMm';
const TELECOIN_ID = '0xf1ebb9ced7f3859b8b94be7e4a630557383cb7cdc4525192929499e76313e137';

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  fetchMock.mockReset();
});

describe('solanaCaip10', () => {
  it('formats a string pubkey as mainnet CAIP-10', () => {
    expect(solanaCaip10(OWNER_PUBKEY)).toBe(
      `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${OWNER_PUBKEY}`,
    );
  });
  it('accepts a PublicKey instance', () => {
    const pk = new PublicKey(OWNER_PUBKEY);
    expect(solanaCaip10(pk)).toContain(OWNER_PUBKEY);
  });
});

describe('listPositionsWithRewards', () => {
  it('POSTs to the list endpoint with CAIP-10 owner + telecoin filter', async () => {
    fetchMock.mockResolvedValueOnce(
      mkFetchResponse({
        positions: [
          {
            info: {
              telecoin_id: TELECOIN_ID,
              owner: solanaCaip10(OWNER_PUBKEY),
              position: POS_1,
              lock_period: 'STAKING_LOCK_PERIOD_ONE_HUNDRED_EIGHTY_DAYS',
              staked: { asset: 'x', decimals: 6, atomic: '5000000000' },
              created_at: '2026-01-01T00:00:00Z',
              unlocks_at: '2026-06-30T00:00:00Z',
            },
            claimable_quote_rewards: { asset: 'sol', decimals: 9, atomic: '142116750' },
          },
        ],
      }),
    );
    const resp = await listPositionsWithRewards({
      owner: OWNER_PUBKEY,
      telecoinIds: [TELECOIN_ID],
    });
    expect(resp.positions).toHaveLength(1);
    expect(resp.positions[0].info.position).toBe(POS_1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/staking/list-positions-with-rewards');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.owners).toEqual([solanaCaip10(OWNER_PUBKEY)]);
    expect(sent.telecoin_ids).toEqual([TELECOIN_ID]);
    // Bearer header includes the public JWT by default.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer ey/);
  });

  it('uses partner API key when supplied via options', async () => {
    fetchMock.mockResolvedValueOnce(mkFetchResponse({ positions: [] }));
    await listPositionsWithRewards({ owner: OWNER_PUBKEY }, { apiKey: 'partner-key-123' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer partner-key-123');
  });

  it('throws on non-2xx with response body in the message', async () => {
    fetchMock.mockResolvedValueOnce(mkFetchResponse({ error: 'bad request' }, 400));
    await expect(listPositionsWithRewards({ owner: OWNER_PUBKEY })).rejects.toThrow(
      /list-positions-with-rewards failed: 400/,
    );
  });
});

describe('claimRewards — input validation', () => {
  it('throws on empty positionIds', async () => {
    const kp = Keypair.generate();
    const connection = {} as never;
    await expect(claimRewards({ owner: kp, positionIds: [], connection })).rejects.toThrow(
      /positionIds must be non-empty/,
    );
  });
});

describe('claimAllAboveThreshold', () => {
  it('returns null when no position meets the threshold', async () => {
    fetchMock.mockResolvedValueOnce(
      mkFetchResponse({
        positions: [
          {
            info: {
              telecoin_id: TELECOIN_ID,
              owner: solanaCaip10(OWNER_PUBKEY),
              position: POS_1,
              lock_period: 'STAKING_LOCK_PERIOD_SEVEN_DAYS',
              staked: { asset: 'x', decimals: 6, atomic: '5000000000' },
              created_at: '2026-01-01T00:00:00Z',
              unlocks_at: '2026-01-08T00:00:00Z',
            },
            claimable_quote_rewards: { asset: 'sol', decimals: 9, atomic: '50000' }, // 50k lamports, below threshold
          },
        ],
      }),
    );
    const kp = Keypair.generate();
    const result = await claimAllAboveThreshold({
      owner: kp,
      minClaimableLamports: 10_000_000n, // 0.01 SOL threshold
      connection: {} as never,
    });
    expect(result).toBeNull();
    // Only the list call fired; no claim tx attempted.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('skips positions with zero claimable (edge case — position present but no rewards yet)', async () => {
    fetchMock.mockResolvedValueOnce(
      mkFetchResponse({
        positions: [
          {
            info: {
              telecoin_id: TELECOIN_ID,
              owner: solanaCaip10(OWNER_PUBKEY),
              position: POS_1,
              lock_period: 'STAKING_LOCK_PERIOD_SEVEN_DAYS',
              staked: { asset: 'x', decimals: 6, atomic: '5000000000' },
              created_at: '2026-01-01T00:00:00Z',
              unlocks_at: '2026-01-08T00:00:00Z',
            },
            claimable_quote_rewards: { asset: 'sol', decimals: 9, atomic: '0' },
          },
        ],
      }),
    );
    const result = await claimAllAboveThreshold({
      owner: Keypair.generate(),
      minClaimableLamports: 1n,
      connection: {} as never,
    });
    expect(result).toBeNull();
  });
});
