import {
  PublicKey,
  type AccountInfo,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const MEMO_PROGRAM_ID   = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface MockRpcOptions {
  latestBlockhash?: { blockhash: string; lastValidBlockHeight: number };
  balances?: Map<string, number>;
  signatures?: Array<{ signature: string; blockTime: number }>;
  transactions?: Map<string, ParsedTransactionWithMeta | null>;
  accountInfos?: Map<string, AccountInfo<Buffer> | null>;
}

export function createMockConnection(opts: MockRpcOptions = {}) {
  // Only tracked for assertions that verify "no RPC was called" on short-circuit paths.
  const calls = { getSignaturesForAddress: [] as PublicKey[] };

  const conn = {
    async getLatestBlockhash(_commitment?: string) {
      return opts.latestBlockhash ?? {
        // 32-byte valid base58 (all-1s = null pubkey). Real base58 is required
        // because Transaction.serialize() decodes this string.
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 1_000_000,
      };
    },
    async getBalance(pubkey: PublicKey): Promise<number> {
      return opts.balances?.get(pubkey.toBase58()) ?? 0;
    },
    async getSignaturesForAddress(address: PublicKey, _opts?: { limit?: number }) {
      calls.getSignaturesForAddress.push(address);
      return (opts.signatures ?? []).map((s) => ({
        signature: s.signature,
        blockTime: s.blockTime,
        slot: 0,
        err: null,
        memo: null,
      }));
    },
    async getParsedTransactions(signatures: string[]) {
      return signatures.map((sig) => opts.transactions?.get(sig) ?? null);
    },
    async sendRawTransaction(_raw: Uint8Array) { return 'MockTxSignature'; },
    async confirmTransaction() { return { value: { err: null } }; },
    async getAccountInfo(pubkey: PublicKey) {
      return opts.accountInfos?.get(pubkey.toBase58()) ?? null;
    },
  };

  return { conn: conn as any, calls };
}

// ---- Realistic ParsedInstruction fixtures (shape matches getParsedTransactions) ----

export function fakeMemoIxParsed(memoString: string): ParsedInstruction {
  return {
    programId: new PublicKey(MEMO_PROGRAM_ID),
    program: 'spl-memo',
    parsed: memoString,
  } as unknown as ParsedInstruction;
}

export function fakeMemoIxRaw(memoString: string): PartiallyDecodedInstruction {
  return {
    programId: new PublicKey(MEMO_PROGRAM_ID),
    accounts: [],
    data: bs58.encode(Buffer.from(memoString, 'utf8')),
  } as unknown as PartiallyDecodedInstruction;
}

export function fakeSolTransferIx(
  from: string,
  to: string,
  lamports: bigint,
): ParsedInstruction {
  return {
    programId: new PublicKey(SYSTEM_PROGRAM_ID),
    program: 'system',
    parsed: {
      type: 'transfer',
      info: { source: from, destination: to, lamports: Number(lamports) },
    },
  } as unknown as ParsedInstruction;
}

export function fakeUsdcTransferCheckedIx(
  sourceAta: string,
  destAta: string,
  authority: string,
  amount: bigint,
  decimals = 6,
  mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
): ParsedInstruction {
  return {
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    program: 'spl-token',
    parsed: {
      type: 'transferChecked',
      info: {
        source: sourceAta,
        destination: destAta,
        mint,
        authority,
        tokenAmount: {
          amount: amount.toString(),
          decimals,
          uiAmount: Number(amount) / 10 ** decimals,
          uiAmountString: String(Number(amount) / 10 ** decimals),
        },
      },
    },
  } as unknown as ParsedInstruction;
}

export function fakeTx(
  blockTime: number,
  instructions: Array<ParsedInstruction | PartiallyDecodedInstruction>,
  err: unknown = null,
): ParsedTransactionWithMeta {
  return {
    slot: 0,
    blockTime,
    transaction: {
      signatures: [],
      message: { accountKeys: [], instructions, recentBlockhash: 'bh' },
    },
    meta: { err, fee: 5000, preBalances: [], postBalances: [], logMessages: [] },
  } as unknown as ParsedTransactionWithMeta;
}
