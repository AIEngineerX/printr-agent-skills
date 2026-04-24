export declare const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export declare const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export declare const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022 program — used by tokens with extensions (e.g. $INKED). Swap
 *  simulation must recognize both IDs to count transfers correctly. */
export declare const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export declare const WSOL_MINT = "So11111111111111111111111111111111111111112";
export declare const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export type Currency = 'SOL' | 'USDC';
export declare const SUPPORTED_MINTS: Record<Currency, string>;
/** Wrong decimals = amounts mis-scaled by orders of magnitude. */
export declare const DECIMALS: Record<Currency, number>;
export declare function mintToCurrency(mint: string): Currency | null;
//# sourceMappingURL=constants.d.ts.map