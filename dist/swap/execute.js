import { Keypair, VersionedTransaction, } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID, } from '@solana/spl-token';
import bs58 from 'bs58';
import { TOKEN_2022_PROGRAM_ID as TOKEN_2022_PROGRAM_ID_STR, TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID_STR, } from '../payments/constants.js';
export function loadHotKeypair() {
    const secret = process.env.TREASURY_HOT_PRIVATE_KEY;
    if (!secret)
        throw new Error('TREASURY_HOT_PRIVATE_KEY not set');
    const bytes = bs58.decode(secret);
    if (bytes.length !== 64) {
        throw new Error(`expected 64-byte secret, got ${bytes.length}`);
    }
    return Keypair.fromSecretKey(bytes);
}
export async function executeUserSwap(txBase64, lastValidBlockHeight, signTransaction, connection) {
    if (!signTransaction)
        throw new Error('Wallet does not support signing');
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
        preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
}
export async function executeServerSwap(connection, tx, lastValidBlockHeight, keypair) {
    tx.sign([keypair]);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
        preflightCommitment: 'confirmed',
    });
    const conf = await connection.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) {
        throw new Error(`swap failed on-chain: ${JSON.stringify(conf.value.err)}`);
    }
    return sig;
}
/** Thrown by verifySwapOutput when the swap confirmed but delivered less than
 *  the quote's minimum output. Distinct class lets callers distinguish a real
 *  slippage bust (no retry, operator decides) from a transient RPC failure
 *  during the post-swap ATA read (safe to recover next cycle). */
export class SwapBelowMinimumError extends Error {
    actual;
    minimum;
    constructor(actual, minimum) {
        super(`swap output below minimum: got ${actual}, expected >= ${minimum}`);
        this.name = 'SwapBelowMinimumError';
        this.actual = actual;
        this.minimum = minimum;
    }
}
/** Throws SwapBelowMinimumError if the ATA didn't receive at least minOutAmount
 *  — the tx can confirm without delivering expected output if a route partially
 *  fills. Any other thrown error (RPC timeout, ATA not found, etc.) indicates
 *  the read itself failed, not that the swap was slippage-busted.
 *
 *  `tokenProgramId` defaults to classic SPL Token. Pass
 *  `TOKEN_2022_PROGRAM_ID` from `@solana/spl-token` for Token-2022 mints —
 *  the ATA derivation and `getAccount` decoding both use the program ID as
 *  a seed / parsing discriminator, so classic-SPL defaults against a
 *  Token-2022 mint return the wrong ATA address and would falsely throw
 *  `TokenAccountNotFoundError` every cycle. **[Printr]** — many Printr POB
 *  tokens graduated post-mid-2025 are Token-2022.
 *
 *  `preSwapBalance` is the ATA's balance snapshotted BEFORE the swap
 *  submission. When provided, the slippage check compares the delta
 *  (`account.amount - preSwapBalance`) against minOutAmount rather than
 *  the absolute amount. Required if the ATA may have been pre-funded
 *  (e.g. by an earlier `/staking/claim-rewards` call that delivered
 *  telecoin rewards into the same ATA); without it, the check would pass
 *  trivially because the pre-existing balance already exceeds minOut,
 *  hiding a zero-fill swap. Omit on a cold ATA and the legacy absolute
 *  check runs. */
export async function verifySwapOutput(connection, outputMint, owner, minOutAmount, tokenProgramId = SPL_TOKEN_PROGRAM_ID, preSwapBalance) {
    const ata = await getAssociatedTokenAddress(outputMint, owner, false, tokenProgramId);
    const account = await getAccount(connection, ata, 'confirmed', tokenProgramId);
    if (preSwapBalance !== undefined) {
        const delta = account.amount - preSwapBalance;
        if (delta < minOutAmount) {
            throw new SwapBelowMinimumError(delta, minOutAmount);
        }
    }
    else if (account.amount < minOutAmount) {
        throw new SwapBelowMinimumError(account.amount, minOutAmount);
    }
    return account.amount;
}
/** Run the swap tx through the RPC's simulateTransaction without submitting.
 *  No SOL spent, no signature required (`sigVerify: false`), fresh blockhash
 *  injected server-side (`replaceRecentBlockhash: true`). The returned shape
 *  mirrors `SimulatedTransactionResponse` with one added instrumentation
 *  field (`tokenTransferCount`). */
export async function simulateSwap(connection, tx) {
    const result = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        innerInstructions: true,
    });
    const value = result.value;
    const inners = value.innerInstructions ?? null;
    let tokenTransferCount = null;
    if (inners) {
        tokenTransferCount = 0;
        for (const group of inners) {
            for (const ix of group.instructions) {
                const programId = 'programId' in ix ? ix.programId.toBase58() : null;
                if (programId !== TOKEN_PROGRAM_ID_STR && programId !== TOKEN_2022_PROGRAM_ID_STR)
                    continue;
                if ('parsed' in ix &&
                    typeof ix.parsed === 'object' &&
                    ix.parsed !== null &&
                    'type' in ix.parsed) {
                    const t = ix.parsed.type;
                    if (t === 'transfer' || t === 'transferChecked')
                        tokenTransferCount++;
                }
            }
        }
    }
    return {
        ok: value.err == null,
        err: value.err,
        logs: value.logs ?? [],
        computeUnitsConsumed: value.unitsConsumed ?? null,
        innerInstructions: inners,
        tokenTransferCount,
    };
}
//# sourceMappingURL=execute.js.map