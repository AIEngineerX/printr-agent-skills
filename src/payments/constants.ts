export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Token-2022 program — used by tokens with extensions (e.g. $INKED). Swap
 *  simulation must recognize both IDs to count transfers correctly. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type Currency = 'SOL' | 'USDC';

export const SUPPORTED_MINTS: Record<Currency, string> = {
  SOL: WSOL_MINT,
  USDC: USDC_MINT,
};

/** Wrong decimals = amounts mis-scaled by orders of magnitude. */
export const DECIMALS: Record<Currency, number> = {
  SOL: 9,
  USDC: 6,
};

export function mintToCurrency(mint: string): Currency | null {
  if (mint === WSOL_MINT) return 'SOL';
  if (mint === USDC_MINT) return 'USDC';
  return null;
}
