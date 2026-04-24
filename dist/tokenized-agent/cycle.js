import { Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createBurnInstruction, getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TokenAccountNotFoundError, } from '@solana/spl-token';
import { quoteSwap, buildSwapTransaction, executeServerSwap, verifySwapOutput, SwapBelowMinimumError, } from '../swap/index.js';
import { claimAllAboveThreshold } from '../staking/index.js';
import { WSOL_MINT } from '../payments/constants.js';
export const FEE_RESERVE_LAMPORTS = 10000000n; // 0.01 SOL held back for tx fees
export async function findRecoveryCycle(cfg) {
    const programId = cfg.tokenProgramId ?? TOKEN_PROGRAM_ID;
    const ata = await getAssociatedTokenAddress(cfg.agentTokenMint, cfg.hotKeypair.publicKey, false, programId);
    let ataBalance;
    try {
        const acct = await getAccount(cfg.connection, ata, 'confirmed', programId);
        ataBalance = acct.amount;
    }
    catch (e) {
        if (e instanceof TokenAccountNotFoundError)
            return null;
        throw e;
    }
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
    // Snapshot the agent-token ATA balance BEFORE the swap so the slippage
    // check below compares delta (post - pre), not absolute. When auto-claim
    // is enabled the ATA may be pre-funded with telecoin rewards; without
    // this snapshot, a zero-fill swap would silently pass because pre+0
    // already exceeds minOut.
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
    // Record the swap_done row IMMEDIATELY after swap confirmation. Any failure
    // past this point leaves a durable row: RPC errors inside verifySwapOutput
    // keep status='swap_done' so findRecoveryCycle picks up the ATA balance next
    // tick; a real slippage bust is caught below and flips the row to 'failed'
    // so recovery does not auto-burn a partial fill without operator review.
    // agent_token_bought is seeded with the quote's minimum and rewritten with
    // the verified amount on the happy path.
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
    // Record the delta as agent_token_bought for accounting accuracy. The
    // burn amount passed to burnAgentTokens will be the TOTAL ATA balance
    // (includes any pre-existing telecoin rewards), so the burn naturally
    // wipes the ATA regardless of source.
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
/** Execute the claim phase. Returns the summary, or null if nothing was
 *  claimable above threshold (no tx submitted). Errors bubble up — the
 *  orchestrator's try/catch wraps them into a 'failed' CycleResult with
 *  stage='claim'. */
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
        // Phase 0 — recovery takes precedence. If the hot ATA has leftover
        // tokens from a previous cycle's swap-succeeded-burn-failed state,
        // burn those first. Do not run claim here — recovery uses existing
        // ATA balance; we don't want to mix in fresh claim-delivered tokens
        // until the prior swap's output is resolved. The next cycle tick
        // after recovery picks up claim + normal flow.
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
        // Phase 0.5 — optional auto-claim. Happens AFTER recovery (so we
        // don't mix claim output into a recovery burn) but BEFORE the
        // threshold check (so the claim's SOL can lift us over the threshold
        // when the hot wallet would otherwise no-op).
        stage = 'claim';
        claim = await runClaimPhase(cfg);
        // Phase 1 — swap. startCycle snapshots the ATA pre-swap so if the
        // claim deposited telecoin rewards into the same ATA, the slippage
        // check still works.
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
        // Phase 2 — burn. Pass totalAtaAmount (not bought) so any claimed
        // telecoin rewards in the ATA are burned alongside the swap output.
        // This is the supply-reduction double-hit: swap burns X, claim adds
        // Y, single burn ix destroys X+Y.
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