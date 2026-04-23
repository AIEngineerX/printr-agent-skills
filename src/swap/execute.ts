import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';

export function loadHotKeypair(): Keypair {
  const secret = process.env.TREASURY_HOT_PRIVATE_KEY;
  if (!secret) throw new Error('TREASURY_HOT_PRIVATE_KEY not set');
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64) {
    throw new Error(`expected 64-byte secret, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}

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
    { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

export async function executeServerSwap(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  keypair: Keypair,
): Promise<string> {
  tx.sign([keypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
    preflightCommitment: 'confirmed',
  });
  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    throw new Error(`swap failed on-chain: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

/** Throws if the ATA didn't receive at least minOutAmount — the tx can confirm
 *  without delivering expected output if a route partially fills. */
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
