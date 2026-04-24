import { VersionedTransaction } from '@solana/web3.js';
import { jupiterFetch } from './jupiter.js';
export async function buildSwapTransaction(params) {
    const body = {
        quoteResponse: params.quote,
        userPublicKey: params.userPublicKey.toBase58(),
        wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
        prioritizationFeeLamports: !params.priorityFee || params.priorityFee === 'auto'
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
    const { swapTransaction, lastValidBlockHeight } = (await res.json());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    return { tx, lastValidBlockHeight };
}
//# sourceMappingURL=build.js.map