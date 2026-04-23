// Program + mint constants shared across the payments module.

export const MEMO_PROGRAM_ID   = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Currencies we accept payments in. Keep this list honest — every entry
// here must have a tested code path in invoice.ts and verify.ts.
export const SUPPORTED_CURRENCIES = ['SOL', 'USDC'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

// Mints we accept. Must correspond 1:1 with SUPPORTED_CURRENCIES.
export const SUPPORTED_MINTS = {
  SOL: WSOL_MINT,
  USDC: USDC_MINT,
} as const;

// Decimals per currency. Wrong decimals = amounts mis-scaled by orders
// of magnitude, which is catastrophic on the SPL path.
export const DECIMALS: Record<Currency, number> = {
  SOL: 9,
  USDC: 6,
};

export function mintToCurrency(mint: string): Currency | null {
  if (mint === WSOL_MINT) return 'SOL';
  if (mint === USDC_MINT) return 'USDC';
  return null;
}
