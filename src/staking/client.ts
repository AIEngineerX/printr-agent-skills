// Printr staking API client — handles the owner-signed claim flow.
//
// Auth uses the public JWT embedded in @printr/sdk (verified 2026-04-17
// in docs/references/printr-api/FINDINGS.md of the reference
// implementation repo). Adopters with a partner key can pass it via
// options.apiKey.
//
// API surface used:
//   POST /v1/staking/list-positions-with-rewards  — read claimable rewards
//   POST /v1/staking/claim-rewards                — get unsigned claim tx

import type { Connection, Keypair } from '@solana/web3.js';
import { VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';

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
    throw new Error(`Printr ${path} failed: ${res.status} ${text.slice(0, 400)}`);
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
  signature: string;
  /** Per-position claimed amounts. Order matches the input `positionIds`. */
  perPosition: Array<{
    position: string;
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
 * signature plus the amounts that were claimable immediately before the
 * claim (read from Printr's API before submission — these are "what the
 * claim was built for", not necessarily what lands, but the two should
 * match modulo fee / rounding).
 *
 * The Solana instruction bytes are server-encoded by Printr (their SVM
 * IDL is not public) — this wrapper takes those bytes, builds a
 * VersionedTransaction, signs with the owner keypair, submits, confirms.
 *
 * @param args.owner       keypair whose pubkey owns the positions
 * @param args.positionIds array of position addresses (from StakePositionInfo.position)
 * @param args.connection  Solana RPC
 * @param options          optional Printr API overrides (base URL, partner key)
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

  // Snapshot rewards-pre-claim so we can report what the claim delivered.
  // Filter server-side to only these position IDs would be nicer, but the
  // list endpoint filters by telecoin_ids not position_ids, so we pull by
  // owner and filter client-side.
  const ownerCaip = solanaCaip10(args.owner.publicKey);
  const listResp = await listPositionsWithRewards(
    { owner: args.owner.publicKey, limit: 100 },
    options,
  );
  const matchedPositions = listResp.positions.filter((p) =>
    args.positionIds.includes(p.info.position),
  );

  // Ask Printr for the unsigned claim tx.
  const claimResp = await printrPost<ClaimResponse>(
    '/staking/claim-rewards',
    {
      owner: ownerCaip,
      position_ids: args.positionIds,
    },
    options,
  );

  // Assemble the Solana transaction from Printr's server-encoded ixs.
  // Each ix has program_id (base58), accounts (pubkey + signer/writable
  // flags), and data (base64). VersionedTransaction accepts this shape
  // via TransactionMessage.compileToV0Message.
  const instructions = claimResp.tx_payload.ixs.map((ix) => ({
    programId: new PublicKey(ix.program_id),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.is_signer,
      isWritable: a.is_writable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  }));

  const { blockhash, lastValidBlockHeight } =
    await args.connection.getLatestBlockhash('confirmed');

  const messageV0 = new TransactionMessage({
    payerKey: args.owner.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

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
    throw new Error(`claim failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }

  const perPosition = matchedPositions.map((p) => ({
    position: p.info.position,
    claimedQuoteLamports: BigInt(p.claimable_quote_rewards?.atomic ?? '0'),
    claimedTelecoinAtomic: BigInt(p.claimable_telecoin_rewards?.atomic ?? '0'),
  }));

  const totalClaimedLamports = perPosition.reduce(
    (acc, p) => acc + p.claimedQuoteLamports,
    0n,
  );
  const totalClaimedTelecoinAtomic = perPosition.reduce(
    (acc, p) => acc + p.claimedTelecoinAtomic,
    0n,
  );

  return {
    signature,
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

  const claimable = list.positions.filter((p) => {
    const atomic = p.claimable_quote_rewards?.atomic;
    if (!atomic) return false;
    return BigInt(atomic) > 0n;
  });

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
