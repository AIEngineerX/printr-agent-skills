// Minimal mock Connection. Only implements the methods our code actually
// calls. Each method is wired to a jest-like call log so tests can assert
// what the code under test asked for.

import type {
  AccountInfo,
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
  SignatureStatus,
  VersionedTransaction,
} from '@solana/web3.js';

export interface MockRpcOptions {
  latestBlockhash?: { blockhash: string; lastValidBlockHeight: number };
  balances?: Map<string, number>;
  signatures?: Array<{ signature: string; blockTime: number }>;
  transactions?: Map<string, ParsedTransactionWithMeta | null>;
  accountInfos?: Map<string, AccountInfo<Buffer> | null>;
  tokenAccounts?: Map<string, { amount: bigint; mint: PublicKey; owner: PublicKey }>;
  // Function hooks — tests can inject errors at specific points
  sendRawTransaction?: (raw: Uint8Array) => Promise<string>;
  confirmTransaction?: () => Promise<{ value: { err: unknown } }>;
}

export function createMockConnection(opts: MockRpcOptions = {}) {
  const calls = {
    getLatestBlockhash: [] as Array<string | undefined>,
    getBalance: [] as Array<PublicKey>,
    getSignaturesForAddress: [] as Array<{ address: PublicKey; limit?: number }>,
    getParsedTransactions: [] as Array<string[]>,
    sendRawTransaction: [] as Array<Uint8Array>,
    confirmTransaction: [] as Array<unknown>,
  };

  const conn = {
    async getLatestBlockhash(commitment?: string) {
      calls.getLatestBlockhash.push(commitment);
      return (
        opts.latestBlockhash ?? {
          // Valid 32-byte base58 string (all 1s = the null pubkey; base58 '1' = 0).
          // Use this instead of a mnemonic because base58 excludes l, 0, I, O
          // and invalid chars cause Transaction.serialize() to throw.
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1_000_000,
        }
      );
    },
    async getBalance(pubkey: PublicKey, _commitment?: string): Promise<number> {
      calls.getBalance.push(pubkey);
      return opts.balances?.get(pubkey.toBase58()) ?? 0;
    },
    async getSignaturesForAddress(
      address: PublicKey,
      options?: { limit?: number },
    ) {
      calls.getSignaturesForAddress.push({ address, limit: options?.limit });
      return (opts.signatures ?? []).map((s) => ({
        signature: s.signature,
        blockTime: s.blockTime,
        slot: 0,
        err: null,
        memo: null,
      }));
    },
    async getParsedTransactions(
      signatures: string[],
      _opts?: unknown,
    ): Promise<Array<ParsedTransactionWithMeta | null>> {
      calls.getParsedTransactions.push(signatures);
      return signatures.map((sig) => opts.transactions?.get(sig) ?? null);
    },
    async sendRawTransaction(raw: Uint8Array, _opts?: unknown): Promise<string> {
      calls.sendRawTransaction.push(raw);
      if (opts.sendRawTransaction) return opts.sendRawTransaction(raw);
      return 'MockTxSignature' + calls.sendRawTransaction.length;
    },
    async confirmTransaction(_sig: unknown, _commitment?: string) {
      calls.confirmTransaction.push(_sig);
      if (opts.confirmTransaction) return opts.confirmTransaction();
      return { value: { err: null } };
    },
    async getAccountInfo(pubkey: PublicKey) {
      return opts.accountInfos?.get(pubkey.toBase58()) ?? null;
    },
  };

  return { conn: conn as any, calls };
}

// ---- Realistic ParsedInstruction fixtures ----
// These match the JSON shape getParsedTransactions actually returns on
// mainnet, as documented in solana-web3.js types + observed live.

const MEMO_PROGRAM_ID   = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// PublicKey wrapper — tests pass base58 strings, helper makes real PKs.
import { PublicKey as PK } from '@solana/web3.js';

export function fakeMemoIxParsed(memoString: string): ParsedInstruction {
  return {
    programId: new PK(MEMO_PROGRAM_ID),
    program: 'spl-memo',
    parsed: memoString,
  } as unknown as ParsedInstruction;
}

export function fakeMemoIxRaw(memoString: string): PartiallyDecodedInstruction {
  // Raw form: data is base58-encoded UTF-8 bytes.
  // We need to base58-encode the raw UTF-8 bytes of the memo string.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs58 = require('bs58').default ?? require('bs58');
  const data = bs58.encode(Buffer.from(memoString, 'utf8'));
  return {
    programId: new PK(MEMO_PROGRAM_ID),
    accounts: [],
    data,
  } as unknown as PartiallyDecodedInstruction;
}

export function fakeSolTransferIx(
  from: string,
  to: string,
  lamports: bigint,
): ParsedInstruction {
  return {
    programId: new PK(SYSTEM_PROGRAM_ID),
    program: 'system',
    parsed: {
      type: 'transfer',
      info: {
        source: from,
        destination: to,
        lamports: Number(lamports),
      },
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
    programId: new PK(TOKEN_PROGRAM_ID),
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
      message: {
        accountKeys: [],
        instructions,
        recentBlockhash: 'bh',
      },
    },
    meta: {
      err,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      logMessages: [],
    },
  } as unknown as ParsedTransactionWithMeta;
}
