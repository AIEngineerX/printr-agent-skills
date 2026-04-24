import { Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createBurnInstruction, getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TokenAccountNotFoundError, } from '@solana/spl-token';
import { quoteSwap, buildSwapTransaction, executeServerSwap, verifySwapOutput, SwapBelowMinimumError, } from '../swap/index.js';
import { claimAllAboveThreshold } from '../staking/index.js';
import { WSOL_MINT } from '../payments/constants.js';
export const FEE_RESERVE_LAMPORTS = 10000000n; // 0.01 SOL held back for tx fees
export async function findRecoveryCycle(cfg) {
    const ataBalance = await readAtaBalance(cfg);
    if (ataBalance === 0n)
        return null;
    const { rows } = await cfg.pool.query(`SELECT id, agent_token_bought
       FROM burn_event
      WHERE status = 'swap_done'
      ORDER BY cycle_started_at DESC
      LIMIT 1`);
    if (rows.length === 0) {
        throw new Error(`hot wallet holds ${ataBalance} agent tokens but no open burn_event row — manual intervention required`);
    }
    // Burn the actual ATA balance, not the recorded quote.
    return { id: Number(rows[0].id), amountToBurn: ataBalance };
}
export async function startCycle(cfg) {
    const hotBalanceLamports = BigInt(await cfg.connection.getBalance(cfg.hotKeypair.publicKey, 'confirmed'));
    const available = hotBalanceLamports - FEE_RESERVE_LAMPORTS;
    const amountIn = available < cfg.maxPerCycleLamports ? available : cfg.maxPerCycleLamports;
    if (hotBalanceLamports < cfg.thresholdLamports || amountIn <= 0n) {
        return { action: 'noop', reason: 'below_threshold', hotBalance: hotBalanceLamports };
    }
    // Snapshot the ATA balance BEFORE the swap so the slippage check compares
    // the delta (post - pre), not absolute. Required when autoClaim may have
    // pre-funded the ATA — otherwise a zero-fill swap passes trivially.
    const preSwapBalance = await readAtaBalance(cfg);
    const quote = await quoteSwap({
        inputMint: WSOL_MINT,
        outputMint: cfg.agentTokenMint.toBase58(),
        amount: amountIn,
        slippageBps: cfg.slippageBps,
    });
    const { tx, lastValidBlockHeight } = await buildSwapTransaction({
        quote,
        userPublicKey: cfg.hotKeypair.publicKey,
    });
    const swapSig = await executeServerSwap(cfg.connection, tx, lastValidBlockHeight, cfg.hotKeypair);
    // Record swap_done immediately post-confirmation so any later failure is
    // recoverable: RPC errors inside verifySwapOutput keep status='swap_done'
    // for next-tick recovery; a real slippage bust flips the row to 'failed'
    // so recovery doesn't auto-burn a partial fill. agent_token_bought is
    // seeded with the quote minimum and rewritten with the verified amount.
    const inserted = await cfg.pool.query(`INSERT INTO burn_event
       (sol_in_lamports, agent_token_bought, agent_token_burned, swap_sig, status)
     VALUES ($1, $2, 0, $3, 'swap_done')
     RETURNING id`, [amountIn.toString(), quote.otherAmountThreshold, swapSig]);
    const cycleId = Number(inserted.rows[0].id);
    let totalAtaAmount;
    try {
        totalAtaAmount = await verifySwapOutput(cfg.connection, cfg.agentTokenMint, cfg.hotKeypair.publicKey, BigInt(quote.otherAmountThreshold), cfg.tokenProgramId, preSwapBalance);
    }
    catch (e) {
        if (e instanceof SwapBelowMinimumError) {
            await cfg.pool.query(`UPDATE burn_event SET status = 'failed', error = $1 WHERE id = $2`, [
                e.message,
                cycleId,
            ]);
        }
        throw e;
    }
    // bought = swap delivery; totalAtaAmount = delivery + any pre-existing
    // (e.g. claimed telecoin rewards). Burning totalAtaAmount wipes the ATA.
    const bought = totalAtaAmount - preSwapBalance;
    await cfg.pool.query(`UPDATE burn_event SET agent_token_bought = $1 WHERE id = $2`, [
        bought.toString(),
        cycleId,
    ]);
    return {
        action: 'swapped',
        cycleId,
        swapSig,
        bought,
        solIn: amountIn,
        totalAtaAmount,
    };
}
/** Read the current ATA balance; returns 0n when the ATA doesn't exist yet. */
async function readAtaBalance(cfg) {
    const programId = cfg.tokenProgramId ?? TOKEN_PROGRAM_ID;
    const ata = await getAssociatedTokenAddress(cfg.agentTokenMint, cfg.hotKeypair.publicKey, false, programId);
    try {
        const acct = await getAccount(cfg.connection, ata, 'confirmed', programId);
        return acct.amount;
    }
    catch (e) {
        if (e instanceof TokenAccountNotFoundError)
            return 0n;
        throw e;
    }
}
export async function burnAgentTokens(cfg, cycleId, amountToBurn) {
    const programId = cfg.tokenProgramId ?? TOKEN_PROGRAM_ID;
    const ata = await getAssociatedTokenAddress(cfg.agentTokenMint, cfg.hotKeypair.publicKey, false, programId);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), createBurnInstruction(ata, cfg.agentTokenMint, cfg.hotKeypair.publicKey, amountToBurn, [], programId));
    const { blockhash, lastValidBlockHeight } = await cfg.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = cfg.hotKeypair.publicKey;
    tx.sign(cfg.hotKeypair);
    const sig = await cfg.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
    });
    const conf = await cfg.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) {
        throw new Error(`burn failed on-chain: ${JSON.stringify(conf.value.err)}`);
    }
    await cfg.pool.query(`UPDATE burn_event
        SET agent_token_burned = $1,
            burn_sig = $2,
            status = CASE WHEN agent_token_staked = 0 THEN 'complete' ELSE 'burn_done' END,
            completed_at = CASE WHEN agent_token_staked = 0 THEN now() ELSE completed_at END
      WHERE id = $3`, [amountToBurn.toString(), sig, cycleId]);
    return sig;
}
/** Run the claim phase. Null when autoClaim is off OR nothing was above
 *  threshold. Errors bubble up to runBuybackCycle's 'failed' handler. */
async function runClaimPhase(cfg) {
    if (!cfg.autoClaim)
        return null;
    const result = await claimAllAboveThreshold({
        owner: cfg.hotKeypair,
        telecoinIds: cfg.autoClaim.telecoinIds,
        minClaimableLamports: cfg.autoClaim.minClaimableLamports,
        connection: cfg.connection,
    }, cfg.autoClaim.printrOptions);
    if (!result)
        return null;
    return {
        signature: result.signature,
        claimedLamports: result.totalClaimedLamports,
        claimedTelecoinAtomic: result.totalClaimedTelecoinAtomic,
        positionsClaimed: result.perPosition.length,
    };
}
export async function runBuybackCycle(cfg) {
    let stage = 'preflight';
    let claim = null;
    try {
        // Phase 0 — recovery. Burn leftover tokens from a prior
        // swap-succeeded-burn-failed state before running anything else.
        // Claim stays OFF here to avoid mixing fresh rewards into a recovery burn.
        const recovery = await findRecoveryCycle(cfg);
        if (recovery) {
            stage = 'burn';
            const burnSig = await burnAgentTokens(cfg, recovery.id, recovery.amountToBurn);
            return {
                action: 'recovered',
                cycleId: recovery.id,
                burnSig,
                amountBurned: recovery.amountToBurn,
            };
        }
        // Phase 0.5 — autoClaim. After recovery, before threshold check, so
        // claimed SOL can lift the wallet over the threshold.
        stage = 'claim';
        claim = await runClaimPhase(cfg);
        // Phase 1 — swap.
        stage = 'swap';
        const start = await startCycle(cfg);
        if (start.action === 'noop') {
            return {
                action: 'noop',
                reason: 'below_threshold',
                hotBalance: start.hotBalance,
                claim: claim ?? undefined,
            };
        }
        // Phase 2 — burn totalAtaAmount (swap delivery + any claimed telecoin
        // rewards sitting in the same ATA) in a single ix.
        stage = 'burn';
        const burnSig = await burnAgentTokens(cfg, start.cycleId, start.totalAtaAmount);
        return {
            action: 'completed',
            cycleId: start.cycleId,
            swapSig: start.swapSig,
            burnSig,
            solIn: start.solIn,
            amountBurned: start.totalAtaAmount,
            claim: claim ?? undefined,
        };
    }
    catch (e) {
        return {
            action: 'failed',
            stage,
            error: e instanceof Error ? e.message : String(e),
            claim: claim ?? undefined,
        };
    }
}
//# sourceMappingURL=cycle.js.map