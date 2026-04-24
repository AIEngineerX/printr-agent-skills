import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { type Currency } from './constants.js';
/** Inlined to avoid depending on @solana/spl-memo for a 10-line helper. */
export declare function createMemoInstruction(memo: string, signers?: PublicKey[]): TransactionInstruction;
export declare function generateInvoiceParams(opts: {
    currency: Currency;
    price_smallest_unit: bigint;
    durationSeconds?: number;
}): {
    memo: bigint;
    currency_mint: string;
    amount_smallest_unit: bigint;
    start_time: number;
    end_time: number;
};
export declare function buildPaymentTransaction(connection: Connection, params: {
    userWallet: string;
    treasuryReceiver: string;
    memo: bigint;
    currency_mint: string;
    amount_smallest_unit: bigint;
    priorityFeeMicroLamports?: number;
}): Promise<string>;
//# sourceMappingURL=invoice.d.ts.map