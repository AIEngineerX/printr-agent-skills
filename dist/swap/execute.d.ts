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
export declare function verifySwapOutput(connection: Connection, outputMint: PublicKey, owner: PublicKey, minOutAmount: bigint, tokenProgramId?: PublicKey, preSwapBalance?: bigint): Promise<bigint>;
/** Result of a dry-run swap simulation. Runs the tx through the RPC without
 *  submitting — no SOL spent, no signature required. Useful to validate the
 *  route resolves, the tx would land, and the compute-unit cost is within
 *  budget before enabling a live buyback cron.
 *
 *  Note on mechanism: Printr POB model-1 fee distribution is **async LP-fee
 *  accrual + periodic distribution** by Printr's SVM program — not a
 *  per-swap hook visible in inner instructions. Do not use the swap
 *  simulation to try to detect fee-hook activity; it won't show anything
 *  distinguishable from a plain Meteora DAMM v2 swap. Verify POB liveness
 *  via `POST /v1/staking/list-positions-with-rewards` on Printr's API
 *  instead. See `scripts/verify-printr-mechanism.ts`. */
export interface SimulateSwapResult {
    ok: boolean;
    err: unknown;
    logs: readonly string[];
    computeUnitsConsumed: number | null;
    innerInstructions: SimulatedTransactionResponse['innerInstructions'];
    /** Count of Token Program transfer/transferChecked ixs across all inner
     *  instruction groups. Includes both classic SPL (`Tokenkeg...`) and
     *  Token-2022 (`TokenzQdB...`) programs — many Printr POB tokens are
     *  Token-2022. Useful for sanity-checking the swap routed at all; NOT a
     *  proxy for fee-hook detection (see note on `SimulateSwapResult`).
     *  Null when the RPC didn't return inner instructions in parsed form. */
    tokenTransferCount: number | null;
}
/** Run the swap tx through the RPC's simulateTransaction without submitting.
 *  No SOL spent, no signature required (`sigVerify: false`), fresh blockhash
 *  injected server-side (`replaceRecentBlockhash: true`). The returned shape
 *  mirrors `SimulatedTransactionResponse` with one added instrumentation
 *  field (`tokenTransferCount`). */
export declare function simulateSwap(connection: Connection, tx: VersionedTransaction): Promise<SimulateSwapResult>;
//# sourceMappingURL=execute.d.ts.map