// Happy-path coverage for claimRewards + claimAllAboveThreshold + the
// pagination fix for owners with >100 positions. Mocks fetch (HTTP) and the
// Connection send/confirm path; everything else — CAIP-10, message
// compilation, tx signing with a real Keypair, filter logic — runs for real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  claimAllAboveThreshold,
  claimRewards,
  listPositionsWithRewards,
  solanaCaip10,
  type StakePositionWithRewards,
} from '../src/staking/index.js';

const OWNER = Keypair.generate();
const OWNER_PUBKEY = OWNER.publicKey.toBase58();
const POS_1 = 'pos1' + 'A'.repeat(40);
const POS_2 = 'pos2' + 'B'.repeat(40);
const POS_3 = 'pos3' + 'C'.repeat(40);
const TELECOIN_ID = '0xf1ebb9ced7f3859b8b94be7e4a630557383cb7cdc4525192929499e76313e137';
const PROGRAM = new PublicKey('T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint');

function httpResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fakePosition(overrides: {
  position: string;
  claimableQuoteLamports?: string;
  claimableTelecoinAtomic?: string;
  telecoinId?: string;
  creationTx?: string;
}): StakePositionWithRewards {
  return {
    info: {
      telecoin_id: overrides.telecoinId ?? TELECOIN_ID,
      owner: solanaCaip10(OWNER_PUBKEY),
      position: overrides.position,
      creation_tx: overrides.creationTx ?? `creationTx_${overrides.position.slice(0, 8)}`,
      lock_period: 'STAKING_LOCK_PERIOD_SEVEN_DAYS',
      staked: { asset: 'x', decimals: 6, atomic: '5000000000' },
      created_at: '2026-01-01T00:00:00Z',
      unlocks_at: '2026-01-08T00:00:00Z',
    },
    claimable_quote_rewards:
      overrides.claimableQuoteLamports !== undefined
        ? { asset: 'sol', decimals: 9, atomic: overrides.claimableQuoteLamports }
        : undefined,
    claimable_telecoin_rewards:
      overrides.claimableTelecoinAtomic !== undefined
        ? { asset: 'tele', decimals: 6, atomic: overrides.claimableTelecoinAtomic }
        : undefined,
  };
}

function fakeServerEncodedIx(payer: PublicKey) {
  // A real ComputeBudget.setComputeUnitLimit instruction encoded as Printr's
  // server-side claim tx would encode one — compact enough that the signing
  // flow actually exercises the base64 decode, Buffer construction, and
  // TransactionMessage.compileToV0Message paths.
  //
  //   discriminator 2 (SetComputeUnitLimit), u32 value 200_000
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(200_000, 1);
  return {
    program_id: 'ComputeBudget111111111111111111111111111111',
    accounts: [] as Array<{ pubkey: string; is_signer: boolean; is_writable: boolean }>,
    data: data.toString('base64'),
  };
}

function makeClaimTxConn(opts: { confirmErr?: unknown } = {}) {
  const sent: Uint8Array[] = [];
  let sigSeq = 0;
  const conn = {
    async getLatestBlockhash() {
      return {
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 1_000_000,
      };
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push(raw);
      // Distinct signatures per submission so multi-position claim tests
      // can assert which tx confirmed which position.
      const idx = sigSeq++;
      return `ClaimSigReal${idx}${'0'.repeat(58 - String(idx).length - 12)}`;
    },
    async confirmTransaction() {
      return { value: { err: opts.confirmErr ?? null } };
    },
    // claimRewards optionally fetches an Address Lookup Table when the
    // server response includes one. Tests don't return a lookup_table
    // by default, so this call should never fire on the happy path.
    async getAddressLookupTable() {
      return { value: null };
    },
  };
  return { conn: conn as any, sent };
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => fetchMock.mockReset());

describe('claimRewards — happy path against mocked Printr + real tx assembly', () => {
  it('matches pre-claim amounts, builds + signs one v0 tx PER position, returns aggregated totals', async () => {
    // First fetch: listPositionsWithRewards (snapshot).
    fetchMock.mockResolvedValueOnce(
      httpResponse({
        positions: [
          fakePosition({
            position: POS_1,
            claimableQuoteLamports: '142116750',
            claimableTelecoinAtomic: '5000000',
            creationTx: 'creationTxForPos1',
          }),
          fakePosition({
            position: POS_2,
            claimableQuoteLamports: '87000000',
            claimableTelecoinAtomic: '2000000',
            creationTx: 'creationTxForPos2',
          }),
        ],
      }),
    );
    // Two claim-rewards fetches — one per position.
    fetchMock.mockResolvedValueOnce(
      httpResponse({ tx_payload: { ixs: [fakeServerEncodedIx(OWNER.publicKey)] } }),
    );
    fetchMock.mockResolvedValueOnce(
      httpResponse({ tx_payload: { ixs: [fakeServerEncodedIx(OWNER.publicKey)] } }),
    );

    const { conn, sent } = makeClaimTxConn();

    const result = await claimRewards({
      owner: OWNER,
      positionIds: [POS_1, POS_2],
      connection: conn,
    });

    // Two signatures, comma-joined.
    expect(result.signature.split(',')).toHaveLength(2);
    expect(result.totalClaimedLamports).toBe(229_116_750n);
    expect(result.totalClaimedTelecoinAtomic).toBe(7_000_000n);
    expect(result.perPosition.map((p) => p.position)).toEqual([POS_1, POS_2]);
    expect(result.perPosition[0].claimedQuoteLamports).toBe(142_116_750n);
    expect(result.perPosition[1].claimedQuoteLamports).toBe(87_000_000n);
    // Each entry has its own per-position signature.
    expect(result.perPosition[0].signature).not.toBe(result.perPosition[1].signature);

    // Two raw txs were submitted, both deserialize as signed v0 txs.
    expect(sent).toHaveLength(2);
    for (const raw of sent) {
      const tx = VersionedTransaction.deserialize(raw);
      expect(tx.version).toBe(0);
      expect(tx.signatures[0].some((byte) => byte !== 0)).toBe(true);
    }

    // Verify each claim HTTP request sent the right per-position shape.
    const call1Body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(call1Body).toEqual({
      payer: solanaCaip10(OWNER_PUBKEY),
      position: POS_1,
      creation_tx: 'creationTxForPos1',
    });
    const call2Body = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(call2Body).toEqual({
      payer: solanaCaip10(OWNER_PUBKEY),
      position: POS_2,
      creation_tx: 'creationTxForPos2',
    });
  });

  it('throws on on-chain confirm error without silently swallowing', async () => {
    fetchMock.mockResolvedValueOnce(
      httpResponse({
        positions: [fakePosition({ position: POS_1, claimableQuoteLamports: '1000' })],
      }),
    );
    fetchMock.mockResolvedValueOnce(
      httpResponse({ tx_payload: { ixs: [fakeServerEncodedIx(OWNER.publicKey)] } }),
    );

    const { conn } = makeClaimTxConn({ confirmErr: { InstructionError: [0, 'Custom'] } });
    await expect(
      claimRewards({ owner: OWNER, positionIds: [POS_1], connection: conn }),
    ).rejects.toThrow(/claim failed on-chain/);
  });

  it('paginates the list call until every requested positionId is matched', async () => {
    // Owner has 101 positions total. POS_3 is on page 2. Before the fix,
    // matchedPositions silently dropped POS_3 and undercounted the report.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      fakePosition({
        position: 'pos-filler-' + i.toString().padStart(40, '0'),
        claimableQuoteLamports: '1',
      }),
    );
    page1[0] = fakePosition({ position: POS_1, claimableQuoteLamports: '100' });
    fetchMock.mockResolvedValueOnce(httpResponse({ positions: page1, next_cursor: 'PAGE_2' }));
    fetchMock.mockResolvedValueOnce(
      httpResponse({
        positions: [fakePosition({ position: POS_3, claimableQuoteLamports: '9999' })],
      }),
    );
    // Two claim-rewards calls (one per position).
    fetchMock.mockResolvedValueOnce(
      httpResponse({ tx_payload: { ixs: [fakeServerEncodedIx(OWNER.publicKey)] } }),
    );
    fetchMock.mockResolvedValueOnce(
      httpResponse({ tx_payload: { ixs: [fakeServerEncodedIx(OWNER.publicKey)] } }),
    );

    const { conn } = makeClaimTxConn();
    const result = await claimRewards({
      owner: OWNER,
      positionIds: [POS_1, POS_3],
      connection: conn,
    });

    expect(result.perPosition.map((p) => p.position)).toEqual([POS_1, POS_3]);
    expect(result.perPosition[0].claimedQuoteLamports).toBe(100n);
    expect(result.perPosition[1].claimedQuoteLamports).toBe(9_999n);
    expect(result.totalClaimedLamports).toBe(10_099n);

    // Second list call sent the cursor from page 1.
    const call2Body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(call2Body.cursor).toBe('PAGE_2');
  });

  it('throws after MAX_CLAIM_PAGES if Printr returns next_cursor forever (upstream loop guard)', async () => {
    // Simulate a broken / hostile upstream that returns 100 positions + a
    // fresh next_cursor on every request, indefinitely. Without the cap
    // this would compound 15s-per-request timeouts into minutes of hang.
    // Wanted position is never in any page so the cap kicks in.
    for (let i = 0; i < 25; i++) {
      const page = Array.from({ length: 100 }, (_, j) =>
        fakePosition({
          position: `pos-page-${i}-${j}`,
          claimableQuoteLamports: '1',
        }),
      );
      fetchMock.mockResolvedValueOnce(
        httpResponse({ positions: page, next_cursor: `PAGE_${i + 1}` }),
      );
    }

    const { conn } = makeClaimTxConn();
    await expect(
      claimRewards({ owner: OWNER, positionIds: [POS_1], connection: conn }),
    ).rejects.toThrow(/pagination exceeded MAX_CLAIM_PAGES=20/);
    // Confirms exactly 20 pages were attempted before giving up — not more.
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('throws with the missing position IDs when a requested position cannot be found', async () => {
    // Pagination exhausted without finding POS_3 — no silent undercount.
    fetchMock.mockResolvedValueOnce(
      httpResponse({
        positions: [fakePosition({ position: POS_1, claimableQuoteLamports: '1' })],
        // No next_cursor → pagination ends.
      }),
    );
    const { conn } = makeClaimTxConn();
    await expect(
      claimRewards({ owner: OWNER, positionIds: [POS_1, POS_3], connection: conn }),
    ).rejects.toThrow(/positionId\(s\) not found.*pos3/);
  });
});

describe('claimAllAboveThreshold — happy path', () => {
  it('claims when aggregate claimable crosses threshold and returns the claim result', async () => {
    // listPositionsWithRewards (from claimAllAboveThreshold)
    fetchMock.mockResolvedValueOnce(
      httpResponse({
        positions: [
          fakePosition({ position: POS_1, claimableQuoteLamports: '50000000' }), // 0.05 SOL
          fakePosition({ position: POS_2, claimableQuoteLamports: '80000000' }), // 0.08 SOL
          fakePosition({ position: POS_3, claimableQuoteLamports: '0' }), // dust filtered
        ],
      }),
    );
    // Then claimRewards is called internally — it paginates its OWN list
    // call first (to build the perPosition report), then issues one
    // claim-rewards call per position.
    fetchMock.mockResolvedValueOnce(
      httpResponse({
        positions: [
          fakePosition({ position: POS_1, claimableQuoteLamports: '50000000' }),
          fakePosition({ position: POS_2, claimableQuoteLamports: '80000000' }),
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(
      httpResponse({ tx_payload: { ixs: [fakeServerEncodedIx(OWNER.publicKey)] } }),
    );
    fetchMock.mockResolvedValueOnce(
      httpResponse({ tx_payload: { ixs: [fakeServerEncodedIx(OWNER.publicKey)] } }),
    );

    const { conn, sent } = makeClaimTxConn();
    const result = await claimAllAboveThreshold({
      owner: OWNER,
      telecoinIds: [TELECOIN_ID],
      minClaimableLamports: 100_000_000n, // 0.1 SOL threshold — 0.05 + 0.08 = 0.13 crosses it
      connection: conn,
    });

    expect(result).not.toBeNull();
    expect(result!.totalClaimedLamports).toBe(130_000_000n);
    expect(result!.perPosition.map((p) => p.position)).toEqual([POS_1, POS_2]);
    expect(sent).toHaveLength(2);

    // First list call included the telecoin filter.
    const firstListBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstListBody.telecoin_ids).toEqual([TELECOIN_ID]);
  });
});

describe('listPositionsWithRewards — cursor pagination branch', () => {
  it('sends cursor in request body when supplied', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse({ positions: [] }));
    await listPositionsWithRewards({ owner: OWNER_PUBKEY, cursor: 'TOKEN_ABC' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.cursor).toBe('TOKEN_ABC');
  });

  it('omits cursor when not supplied', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse({ positions: [] }));
    await listPositionsWithRewards({ owner: OWNER_PUBKEY });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('cursor');
  });
});
