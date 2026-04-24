import { Connection, Keypair, PublicKey, VersionedTransaction, type SimulatedTransactionResponse } from '@solana/web3.js';
export declare function loadHotKeypair(): Keypair;
export declare function executeUserSwap(txBase64: string, lastValidBlockHeight: number, signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>, connection: Connection): Promise<string>;
export declare function executeServerSwap(connection: Connection, tx: VersionedTransaction, lastValidBlockHeight: number, keypair: Keypair): Promise<string>;
/** Thrown by verifySwapOutput when the swap confirmed but delivered less than
 *  the quote's minimum output. Distinct class lets callers distinguish a real
 *  slippage bust (no retry, operator decides) from a transient RPC failure
 *  during the post-swap ATA read (safe to recover next cycle). */
export declare class SwapBelowMinimumError extends Error {
    readonly actual: bigint;
    readonly minimum: bigint;
    constructor(actual: bigint, minimum: bigint);
}
/** Thrown when a tx landed but the RPC reports a non-null `meta.err`. The
 *  `operation` field identifies which primitive failed ('swap' / 'burn' /
 *  'claim') so adopters can route by call-site. */
export declare class OnChainConfirmError extends Error {
    readonly operation: string;
    readonly chainError: unknown;
    constructor(operation: string, chainError: unknown);
}
/** Throws SwapBelowMinimumError if the ATA didn't receive at least
 *  minOutAmount — a tx can confirm without delivering expected output on a
 *  partial-fill route. Any other thrown error (RPC timeout, ATA not found)
 *  indicates the read itself failed, not a slippage bust.
 *
 *  `tokenProgramId` defaults to classic SPL. Pass `TOKEN_2022_PROGRAM_ID`
 *  for Token-2022 mints — the program ID is a seed in ATA derivation and a
 *  parsing key in `getAccount`. A mismatch derives the wrong ATA and throws
 *  TokenAccountNotFoundError every cycle. **[Printr]**
 *
 *  `preSwapBalance` switches the slippage check from absolute to delta
 *  (`account.amount - preSwapBalance`). Required when the ATA may have been
 *  pre-funded (e.g. by an earlier claim-rewards call) — without it the
 *  absolute check passes trivially and hides a zero-fill swap. */
export declare function verifySwapOutput(connection: Connection, outputMint: PublicKey, owner: PublicKey, minOutAmount: bigint, tokenProgramId?: PublicKey, preSwapBalance?: bigint): Promise<bigint>;
/** Dry-run swap result. Validates route resolution, tx landability, and
 *  compute cost — not POB fee liveness (that's async, not per-swap; use
 *  `scripts/verify-printr-mechanism.ts`). */
export interface SimulateSwapResult {
    ok: boolean;
    err: unknown;
    logs: readonly string[];
    computeUnitsConsumed: number | null;
    innerInstructions: SimulatedTransactionResponse['innerInstructions'];
    /** Count of Token-program transfer / transferChecked ixs across inner
     *  instruction groups (covers both classic SPL and Token-2022). Route-sanity
     *  check; null when the RPC didn't return inner ixs in parsed form. */
    tokenTransferCount: number | null;
}
/** Run the swap tx through `simulateTransaction` — no submission, no
 *  signature required (`sigVerify: false`), fresh blockhash injected
 *  (`replaceRecentBlockhash: true`). */
export declare function simulateSwap(connection: Connection, tx: VersionedTransaction): Promise<SimulateSwapResult>;
//# sourceMappingURL=execute.d.ts.map