import { VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { jupiterFetch, type JupiterQuote, type PriorityFee } from './jupiter.js';

export interface BuildSwapParams {
  quote: JupiterQuote;
  userPublicKey: PublicKey;
  wrapAndUnwrapSol?: boolean; // default true — auto-handles wSOL
  priorityFee?: PriorityFee; // default 'auto' — Jupiter picks based on congestion
}

export async function buildSwapTransaction(
  params: BuildSwapParams,
): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey.toBase58(),
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    prioritizationFeeLamports:
      !params.priorityFee || params.priorityFee === 'auto'
        ? 'auto'
        : {
            priorityLevelWithMaxLamports: {
              maxLamports: params.priorityFee.maxLamports,
              priorityLevel: params.priorityFee.level,
            },
          },
  };

  const res = await jupiterFetch('/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { swapTransaction, lastValidBlockHeight } = (await res.json()) as {
    swapTransaction: string;
    lastValidBlockHeight: number;
  };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  return { tx, lastValidBlockHeight };
}
