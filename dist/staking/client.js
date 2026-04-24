// Printr staking API client — handles the owner-signed claim flow.
//
// Auth defaults to the public JWT embedded in @printr/sdk (Apache-2.0,
// shared rate-limit pool). Adopters with a partner key can override via
// options.apiKey.
//
// API surface used:
//   POST /v1/staking/list-positions-with-rewards  — read claimable rewards
//   POST /v1/staking/claim-rewards                — get unsigned claim tx
import { VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { OnChainConfirmError } from '../swap/index.js';
/** Thrown when Printr's HTTP API returns a non-2xx response. Adopters can
 *  catch this specifically to retry, back off, or route to a status-page
 *  alert rather than treating every failure as a bug. */
export class PrintrApiError extends Error {
    status;
    path;
    body;
    constructor(path, status, body) {
        super(`Printr ${path} failed: ${status} ${body}`);
        this.name = 'PrintrApiError';
        this.path = path;
        this.status = status;
        this.body = body;
    }
}
const PUBLIC_PRINTR_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhaS1pbnRlZ3JhdGlvbiJ9.PZsqfleSmSiAra8jiN3JZvDSonoawQLnvYRyPHDbtRg';
const DEFAULT_BASE = 'https://api-preview.printr.money';
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
/** Format a Solana pubkey (base58) as a CAIP-10 mainnet-beta account. */
export function solanaCaip10(pubkey) {
    const base58 = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
    return `${SOLANA_CAIP2}:${base58}`;
}
async function printrPost(path, body, options = {}) {
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
    return JSON.parse(text);
}
/**
 * List stake positions with claimable rewards for a given owner, optionally
 * filtered to specific telecoin(s). Results are paginated — caller must
 * handle `next_cursor` if the operator has >100 positions.
 */
export async function listPositionsWithRewards(args, options) {
    const ownerCaip = solanaCaip10(args.owner);
    const body = {
        owners: [ownerCaip],
        limit: args.limit ?? 100,
    };
    if (args.telecoinIds && args.telecoinIds.length > 0)
        body.telecoin_ids = args.telecoinIds;
    if (args.cursor)
        body.cursor = args.cursor;
    return printrPost('/staking/list-positions-with-rewards', body, options);
}
/**
 * Claim rewards from stake positions. Owner must have signing authority on
 * each position (Printr's program checks this on-chain). Returns the tx
 * signature plus the pre-claim claimable amounts — "what the claim was
 * built for", should match on-chain delivery modulo fees / rounding.
 *
 * Printr server-encodes the Solana instruction bytes (SVM IDL not public);
 * this wrapper assembles them into a VersionedTransaction, signs, submits,
 * confirms.
 */
export async function claimRewards(args, options) {
    if (args.positionIds.length === 0) {
        throw new Error('claimRewards: positionIds must be non-empty');
    }
    // Snapshot rewards-pre-claim so we can report what the claim delivered.
    // The list endpoint filters by telecoin_ids, not position_ids — pull by
    // owner and filter client-side. Paginate until every requested positionId
    // is found; otherwise report the gap instead of silently undercounting.
    const ownerCaip = solanaCaip10(args.owner.publicKey);
    const wanted = new Set(args.positionIds);
    const matchedPositions = [];
    let cursor;
    do {
        const page = await listPositionsWithRewards({ owner: args.owner.publicKey, cursor, limit: 100 }, options);
        for (const p of page.positions) {
            if (wanted.has(p.info.position)) {
                matchedPositions.push(p);
                wanted.delete(p.info.position);
            }
        }
        if (wanted.size === 0)
            break;
        cursor = page.next_cursor;
    } while (cursor);
    if (wanted.size > 0) {
        throw new Error(`claimRewards: ${wanted.size} positionId(s) not found in owner's list-positions-with-rewards: ${Array.from(wanted).join(', ')}`);
    }
    // Ask Printr for the unsigned claim tx.
    const claimResp = await printrPost('/staking/claim-rewards', {
        owner: ownerCaip,
        position_ids: args.positionIds,
    }, options);
    const instructions = claimResp.tx_payload.ixs.map((ix) => ({
        programId: new PublicKey(ix.program_id),
        keys: ix.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: a.is_signer,
            isWritable: a.is_writable,
        })),
        data: Buffer.from(ix.data, 'base64'),
    }));
    const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash('confirmed');
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
    const conf = await args.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) {
        throw new OnChainConfirmError('claim', conf.value.err);
    }
    const perPosition = matchedPositions.map((p) => ({
        position: p.info.position,
        claimedQuoteLamports: BigInt(p.claimable_quote_rewards?.atomic ?? '0'),
        claimedTelecoinAtomic: BigInt(p.claimable_telecoin_rewards?.atomic ?? '0'),
    }));
    const totalClaimedLamports = perPosition.reduce((acc, p) => acc + p.claimedQuoteLamports, 0n);
    const totalClaimedTelecoinAtomic = perPosition.reduce((acc, p) => acc + p.claimedTelecoinAtomic, 0n);
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
export async function claimAllAboveThreshold(args, options) {
    const list = await listPositionsWithRewards({
        owner: args.owner.publicKey,
        telecoinIds: args.telecoinIds,
        limit: 100,
    }, options);
    const claimable = list.positions.filter((p) => BigInt(p.claimable_quote_rewards?.atomic ?? '0') > 0n);
    const totalLamports = claimable.reduce((acc, p) => acc + BigInt(p.claimable_quote_rewards?.atomic ?? '0'), 0n);
    if (totalLamports < args.minClaimableLamports)
        return null;
    const positionIds = claimable.map((p) => p.info.position);
    return claimRewards({
        owner: args.owner,
        positionIds,
        connection: args.connection,
    }, options);
}
//# sourceMappingURL=client.js.map