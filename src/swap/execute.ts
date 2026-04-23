import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';

/** Load the server-held hot keypair from env. Throws on any failure so a
 * misconfigured deploy fails loudly at boot instead of silently at cycle time. */
export function loadHotKeypair(): Keypair {
  const secret = process.env.TREASURY_HOT_PRIVATE_KEY;
  if (!secret) throw new Error('TREASURY_HOT_PRIVATE_KEY not set');
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret);
  } catch (e) {
    throw new Error(
      `TREASURY_HOT_PRIVATE_KEY is not valid base58: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (bytes.length !== 64) {
    throw new Error(`expected 64-byte secret, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}

/**
 * Browser / wallet-adapter path. Caller must supply signTransaction +
 * connection from useWallet() and useConnection() hooks.
 *
 * Uses the blockhash already embedded in the Jupiter-built tx (via
 * tx.message.recentBlockhash) so confirmTransaction tracks the same
 * blockhash the tx was signed against.
 */
export async function executeUserSwap(
  txBase64: string,
  lastValidBlockHeight: number,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  connection: Connection,
): Promise<string> {
  if (!signTransaction) throw new Error('Wallet does not support signing');
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  );
  return sig;
}

/**
 * Server-signed swap (automated buyback). Uses the tx's own recentBlockhash
 * for confirmation — matches the blockhash Jupiter set on the tx.
 */
export async function executeServerSwap(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  keypair: Keypair,
): Promise<string> {
  tx.sign([keypair]);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 2,
    preflightCommitment: 'confirmed',
  });
  const conf = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`swap failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

/**
 * Confirm the ATA actually received at least `minOutAmount` after the swap.
 * A tx can confirm without delivering the expected output when a route
 * partially fills or the pool moves between quote and fill.
 */
export async function verifySwapOutput(
  connection: Connection,
  outputMint: PublicKey,
  owner: PublicKey,
  minOutAmount: bigint,
): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(outputMint, owner);
  const account = await getAccount(connection, ata, 'confirmed');
  if (account.amount < minOutAmount) {
    throw new Error(
      `swap output below minimum: got ${account.amount}, expected >= ${minOutAmount}`,
    );
  }
  return account.amount;
}
