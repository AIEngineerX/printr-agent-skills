// Printr staking API client — handles the owner-signed claim flow.
//
// Auth defaults to the public JWT embedded in @printr/sdk (Apache-2.0,
// shared rate-limit pool). Adopters with a partner key can override via
// options.apiKey.
//
// API surface used:
//   POST /v1/staking/list-positions-with-rewards  — read claimable rewards
//   POST /v1/staking/claim-rewards                — get unsigned claim tx

import type { AddressLookupTableAccount, Connection, Keypair } from '@solana/web3.js';
import { VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { OnChainConfirmError } from '../swap/index.js';

/** Thrown when Printr's HTTP API returns a non-2xx response. Adopters can
 *  catch this specifically to retry, back off, or route to a status-page
 *  alert rather than treating every failure as a bug. */
export class PrintrApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  constructor(path: string, status: number, body: string) {
    super(`Printr ${path} failed: ${status} ${body}`);
    this.name = 'PrintrApiError';
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

const PUBLIC_PRINTR_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhaS1pbnRlZ3JhdGlvbiJ9.PZsqfleSmSiAra8jiN3JZvDSonoawQLnvYRyPHDbtRg';

const DEFAULT_BASE = 'https://api-preview.printr.money';
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export interface PrintrClientOptions {
  apiBase?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface AssetAmount {
  asset: string;
  decimals: number;
  atomic: string;
  display?: string;
}

export interface StakePositionInfo {
  telecoin_id: string;
  owner: string;
  position: string;
  /**
   * The signature of the transaction that opened this position. Required
   * by Printr's `/staking/claim-rewards` endpoint as a stable handle for
   * the position — without it the request fails with "creation_tx is required".
   */
  creation_tx: string;
  lock_period:
    | 'STAKING_LOCK_PERIOD_SEVEN_DAYS'
    | 'STAKING_LOCK_PERIOD_FOURTEEN_DAYS'
    | 'STAKING_LOCK_PERIOD_THIRTY_DAYS'
    | 'STAKING_LOCK_PERIOD_SIXTY_DAYS'
    | 'STAKING_LOCK_PERIOD_NINETY_DAYS'
    | 'STAKING_LOCK_PERIOD_ONE_HUNDRED_EIGHTY_DAYS';
  staked: AssetAmount;
  created_at: string;
  unlocks_at: string;
  was_closed?: boolean;
}

export interface StakePositionWithRewards {
  info: StakePositionInfo;
  claimable_quote_rewards?: AssetAmount;
  claimable_telecoin_rewards?: AssetAmount;
  claimed_quote_rewards?: AssetAmount;
  claimed_telecoin_rewards?: AssetAmount;
}

export interface ListPositionsResponse {
  positions: StakePositionWithRewards[];
  next_cursor?: string;
}

/** Format a Solana pubkey (base58) as a CAIP-10 mainnet-beta account. */
export function solanaCaip10(pubkey: string | PublicKey): string {
  const base58 = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
  return `${SOLANA_CAIP2}:${base58}`;
}

async function printrPost<T>(
  path: string,
  body: unknown,
  options: PrintrClientOptions = {},
): Promise<T> {
  const base = options.apiBase ?? DEFAULT_BASE;
  const auth = options.apiKey ?? PUBLIC_PRINTR_JWT;
  const res = await fetch(`${base}/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new PrintrApiError(path, res.status, text.slice(0, 400));
  }
  return JSON.parse(text) as T;
}

/**
 * List stake positions with claimable rewards for a given owner, optionally
 * filtered to specific telecoin(s). Results are paginated — caller must
 * handle `next_cursor` if the operator has >100 positions.
 */
export async function listPositionsWithRewards(
  args: {
    owner: string | PublicKey;
    telecoinIds?: string[];
    cursor?: string;
    limit?: number;
  },
  options?: PrintrClientOptions,
): Promise<ListPositionsResponse> {
  const ownerCaip = solanaCaip10(args.owner);
  const body: Record<string, unknown> = {
    owners: [ownerCaip],
    limit: args.limit ?? 100,
  };
  if (args.telecoinIds && args.telecoinIds.length > 0) body.telecoin_ids = args.telecoinIds;
  if (args.cursor) body.cursor = args.cursor;
  return printrPost<ListPositionsResponse>('/staking/list-positions-with-rewards', body, options);
}

// ─── Claim flow ──────────────────────────────────────────────────────

interface ClaimInstructionAccount {
  pubkey: string;
  is_signer: boolean;
  is_writable: boolean;
}
interface ClaimInstruction {
  program_id: string;
  accounts: ClaimInstructionAccount[];
  data: string; // base64
}
interface ClaimTxPayload {
  ixs: ClaimInstruction[];
  lookup_table?: string;
  mint_address?: string;
}
interface ClaimResponse {
  tx_payload: ClaimTxPayload;
}

/** Amounts reported by a successful claim, per position + aggregated. */
export interface ClaimResult {
  /**
   * Comma-joined claim signatures, in submission order. Printr's
   * `/staking/claim-rewards` accepts only one position per call, so an
   * N-position claim produces N signatures rather than one combined tx.
   * Each signature is a separate on-chain claim transaction.
   */
  signature: string;
  /** Per-position claimed amounts. Order matches the input `positionIds`. */
  perPosition: Array<{
    position: string;
    signature: string;
    claimedQuoteLamports: bigint;
    claimedTelecoinAtomic: bigint;
  }>;
  /** Sum of claimed quote (SOL, lamports) across all positions. */
  totalClaimedLamports: bigint;
  /** Sum of claimed telecoin atomic across all positions. */
  totalClaimedTelecoinAtomic: bigint;
}

/**
 * Claim rewards from stake positions. Owner must have signing authority on
 * each position (Printr's program checks this on-chain). Returns the tx
 * signature plus the pre-claim claimable amounts — "what the claim was
 * built for", should match on-chain delivery modulo fees / rounding.
 *
 * Printr's `/staking/claim-rewards` endpoint accepts one position per
 * call (with its `creation_tx` as a required handle). N positions ⇒ N
 * sequential claim transactions; failure of any aborts the loop, so any
 * already-submitted claims stay on-chain and reward state diverges from
 * what the caller requested. Verified against api-preview 2026-04-25.
 */
export async function claimRewards(
  args: {
    owner: Keypair;
    positionIds: string[];
    connection: Connection;
  },
  options?: PrintrClientOptions,
): Promise<ClaimResult> {
  if (args.positionIds.length === 0) {
    throw new Error('claimRewards: positionIds must be non-empty');
  }

  // Snapshot rewards-pre-claim so we can report what the claim delivered,
  // and grab each position's `creation_tx` (required by claim-rewards).
  // The list endpoint filters by telecoin_ids, not position_ids — pull by
  // owner and filter client-side. Paginate until every requested positionId
  // is found; otherwise report the gap instead of silently undercounting.
  //
  // MAX_CLAIM_PAGES caps the loop — 20 * 100-position pages = 2000 positions,
  // which is more than any real owner should have. Protects against a
  // compromised / broken upstream that returns next_cursor forever (each
  // request is 15s-timeout-bounded; without the cap this would compound
  // into minutes of blocking).
  const MAX_CLAIM_PAGES = 20;
  const payerCaip = solanaCaip10(args.owner.publicKey);
  const wanted = new Set(args.positionIds);
  const matchedById = new Map<string, StakePositionWithRewards>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  do {
    const page = await listPositionsWithRewards(
      { owner: args.owner.publicKey, cursor, limit: 100 },
      options,
    );
    pagesFetched++;
    for (const p of page.positions) {
      if (wanted.has(p.info.position)) {
        matchedById.set(p.info.position, p);
        wanted.delete(p.info.position);
      }
    }
    if (wanted.size === 0) break;
    cursor = page.next_cursor;
    if (pagesFetched >= MAX_CLAIM_PAGES && cursor) {
      throw new Error(
        `claimRewards: pagination exceeded MAX_CLAIM_PAGES=${MAX_CLAIM_PAGES} without finding all positions. ` +
          `${wanted.size} unresolved. Either the owner has more than ${MAX_CLAIM_PAGES * 100} positions ` +
          `(unusual — check positionIds), or the Printr API is returning next_cursor unexpectedly.`,
      );
    }
  } while (cursor);

  if (wanted.size > 0) {
    throw new Error(
      `claimRewards: ${wanted.size} positionId(s) not found in owner's list-positions-with-rewards: ${Array.from(wanted).join(', ')}`,
    );
  }

  // One claim-rewards call per position, sequenced. Each returns its own
  // unsigned tx with optional address-lookup-table — without applying the
  // LUT the assembled VersionedTransaction exceeds the 1232-byte cap
  // (verified empirically: ~1676 bytes raw without LUT for a single $INKED
  // POB position). compileToV0Message(lookupTables) compresses to fit.
  const perPosition: ClaimResult['perPosition'] = [];
  const signatures: string[] = [];
  for (const positionId of args.positionIds) {
    const pos = matchedById.get(positionId)!;
    const claimResp = await printrPost<ClaimResponse>(
      '/staking/claim-rewards',
      {
        payer: payerCaip,
        position: positionId,
        creation_tx: pos.info.creation_tx,
      },
      options,
    );

    const instructions = claimResp.tx_payload.ixs.map((ix) => ({
      programId: new PublicKey(ix.program_id),
      keys: ix.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.is_signer,
        isWritable: a.is_writable,
      })),
      data: Buffer.from(ix.data, 'base64'),
    }));

    let lookupTables: AddressLookupTableAccount[] = [];
    if (claimResp.tx_payload.lookup_table) {
      const lutAcct = await args.connection.getAddressLookupTable(
        new PublicKey(claimResp.tx_payload.lookup_table),
      );
      if (lutAcct.value) lookupTables = [lutAcct.value];
    }

    const { blockhash, lastValidBlockHeight } =
      await args.connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: args.owner.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTables);

    const tx = new VersionedTransaction(messageV0);
    tx.sign([args.owner]);

    const signature = await args.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
      preflightCommitment: 'confirmed',
    });
    const conf = await args.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (conf.value.err) {
      throw new OnChainConfirmError('claim', conf.value.err);
    }

    perPosition.push({
      position: positionId,
      signature,
      claimedQuoteLamports: BigInt(pos.claimable_quote_rewards?.atomic ?? '0'),
      claimedTelecoinAtomic: BigInt(pos.claimable_telecoin_rewards?.atomic ?? '0'),
    });
    signatures.push(signature);
  }

  const totalClaimedLamports = perPosition.reduce((acc, p) => acc + p.claimedQuoteLamports, 0n);
  const totalClaimedTelecoinAtomic = perPosition.reduce(
    (acc, p) => acc + p.claimedTelecoinAtomic,
    0n,
  );

  return {
    signature: signatures.join(','),
    perPosition,
    totalClaimedLamports,
    totalClaimedTelecoinAtomic,
  };
}

/**
 * List-then-claim helper: finds all positions for a given owner (optionally
 * filtered to a telecoin) that have non-zero claimable_quote_rewards above
 * a threshold, and claims them in one tx. Returns null if nothing is above
 * the threshold.
 */
export async function claimAllAboveThreshold(
  args: {
    owner: Keypair;
    telecoinIds?: string[];
    minClaimableLamports: bigint;
    connection: Connection;
  },
  options?: PrintrClientOptions,
): Promise<ClaimResult | null> {
  const list = await listPositionsWithRewards(
    {
      owner: args.owner.publicKey,
      telecoinIds: args.telecoinIds,
      limit: 100,
    },
    options,
  );

  const claimable = list.positions.filter(
    (p) => BigInt(p.claimable_quote_rewards?.atomic ?? '0') > 0n,
  );

  const totalLamports = claimable.reduce(
    (acc, p) => acc + BigInt(p.claimable_quote_rewards?.atomic ?? '0'),
    0n,
  );

  if (totalLamports < args.minClaimableLamports) return null;

  const positionIds = claimable.map((p) => p.info.position);
  return claimRewards(
    {
      owner: args.owner,
      positionIds,
      connection: args.connection,
    },
    options,
  );
}
