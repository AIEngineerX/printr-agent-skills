# Monitoring a production tokenized-agent cycle

The kit itself emits no logs or metrics — it throws typed errors and returns a `CycleResult` discriminated union. This reference collects the alert queries and routing rules that adopters should wire into their own observability stack.

## What the kit gives you to monitor

| Signal                                                     | Where                | Meaning                                                                                                                                                    |
| ---------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CycleResult.action === 'completed'`                       | Handler return value | Healthy cycle — swap + burn both landed                                                                                                                    |
| `CycleResult.action === 'recovered'`                       | Handler return value | Prior cycle's burn failed; this tick cleaned it up. **Every occurrence deserves a look** — the prior cycle's stage=burn failure left tokens in the hot ATA |
| `CycleResult.action === 'noop'`                            | Handler return value | Hot wallet balance below threshold. Normal when revenue is slow; concerning if it persists across cycles when you expect volume                            |
| `CycleResult.action === 'failed'`                          | Handler return value | `stage` pinpoints preflight / claim / swap / burn; `error` carries the typed-error message                                                                 |
| `burn_event.status = 'swap_done'` rows older than 2 cycles | Postgres             | Either recovery hasn't fired yet (investigate) or the ATA is now empty but the DB didn't update (real bug — call the kit)                                  |
| `burn_event.status = 'failed'` rows in last 24h            | Postgres             | Slippage bust, on-chain confirm failure, or claim-phase failure. Count per `error LIKE '%'` pattern for triage                                             |
| Thrown `JupiterApiError` / `PrintrApiError`                | Error tracker        | Upstream availability issue — route to a different alert channel than code bugs                                                                            |
| Thrown `OnChainConfirmError`                               | Error tracker        | Tx landed but program returned error. `.operation` says which (swap/burn/claim); `.chainError` carries the raw RPC error for root-cause analysis           |
| Thrown `SwapBelowMinimumError`                             | Error tracker        | Slippage bust. The `burn_event` row is already flipped to `'failed'`; this error is the operator-visible signal                                            |

## Error-routing pattern (adopter-side)

```typescript
import {
  runBuybackCycle,
  JupiterApiError,
  PrintrApiError,
  OnChainConfirmError,
  SwapBelowMinimumError,
} from '@printr/agent-skills/tokenized-agent';
import { captureException } from '@sentry/node';

try {
  const result = await runBuybackCycle(cfg);
  if (result.action === 'failed') {
    metrics.increment('buyback.failed', { stage: result.stage });
    captureException(new Error(`buyback failed at ${result.stage}: ${result.error}`), {
      tags: { stage: result.stage, kit: 'printr-agent-skills' },
    });
  } else if (result.action === 'recovered') {
    metrics.increment('buyback.recovered');
    captureException(new Error(`cycle ${result.cycleId} recovered — prior burn failed`), {
      level: 'warning',
      tags: { kit: 'printr-agent-skills' },
    });
  } else {
    metrics.increment(`buyback.${result.action}`);
  }
} catch (e) {
  // Errors thrown OUT of runBuybackCycle are the orchestrator's catch-escape
  // class — should be vanishingly rare given runBuybackCycle wraps its own
  // try/catch. If one fires, it's a bug in the kit itself.
  if (e instanceof JupiterApiError) {
    metrics.increment('upstream.jupiter.error', { status: e.status });
  } else if (e instanceof PrintrApiError) {
    metrics.increment('upstream.printr.error', { status: e.status });
  } else if (e instanceof OnChainConfirmError) {
    metrics.increment('onchain.confirm.error', { operation: e.operation });
  } else if (e instanceof SwapBelowMinimumError) {
    metrics.increment('onchain.slippage.bust');
  }
  captureException(e, { tags: { kit: 'printr-agent-skills', path: 'uncaught' } });
  throw e;
}
```

## SQL alert queries

The schema is in `printr-tokenized-agent/SKILL.md` §Database Schema. These queries assume Postgres 13+ (Neon compatible).

### Stranded tokens — highest-priority alert

A `swap_done` row older than two scheduler cadences means recovery hasn't run or has failed. Two missed cycles at the hourly default = 2 hours. Page whoever is on-call.

```sql
SELECT id, swap_sig, cycle_started_at, now() - cycle_started_at AS age
  FROM burn_event
 WHERE status = 'swap_done'
   AND cycle_started_at < now() - interval '2 hours'
 ORDER BY cycle_started_at ASC;
```

### Failed cycles (last 24h) grouped by error class

```sql
SELECT
    CASE
      WHEN error ILIKE '%swap output below minimum%' THEN 'slippage_bust'
      WHEN error ILIKE '%Jupiter%failed%'            THEN 'jupiter_upstream'
      WHEN error ILIKE '%Printr%failed%'             THEN 'printr_upstream'
      WHEN error ILIKE '%failed on-chain%'           THEN 'onchain_confirm'
      WHEN error ILIKE '%manual intervention%'       THEN 'stranded_no_row'
      ELSE 'other'
    END AS error_class,
    count(*) AS n
  FROM burn_event
 WHERE status = 'failed'
   AND cycle_started_at > now() - interval '24 hours'
 GROUP BY 1
 ORDER BY n DESC;
```

### Cumulative supply burned — transparency metric

Public dashboards often render this directly.

```sql
SELECT
    date_trunc('day', completed_at) AS day,
    sum(agent_token_burned)::text   AS burned_atomic,
    count(*)                        AS cycles
  FROM burn_event
 WHERE status = 'complete'
 GROUP BY 1
 ORDER BY 1 DESC;
```

### Cycle-latency hygiene

If `completed_at - cycle_started_at` starts drifting upward, a provider (RPC or Jupiter) is slowing down.

```sql
SELECT
    percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - cycle_started_at)) AS p50_seconds,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - cycle_started_at)) AS p95_seconds
  FROM burn_event
 WHERE status = 'complete'
   AND completed_at > now() - interval '24 hours';
```

### Payment invoice health (when `printr-agent-payments` is in use)

```sql
-- Pending invoices that never got paid (24h window)
SELECT count(*)
  FROM payment_invoice
 WHERE status = 'pending'
   AND end_time + 300 < extract(epoch FROM now())::bigint;

-- Payment volume by currency, last 7d
SELECT currency_mint, count(*), sum(amount_smallest_unit)::text
  FROM payment_invoice
 WHERE status = 'paid'
   AND paid_at > now() - interval '7 days'
 GROUP BY currency_mint;
```

## Recommended metric set (Prometheus / StatsD naming)

| Metric                           | Type      | Labels                                           |
| -------------------------------- | --------- | ------------------------------------------------ |
| `buyback_cycle_total`            | counter   | `action` (completed / recovered / noop / failed) |
| `buyback_cycle_failed_total`     | counter   | `stage` (preflight / claim / swap / burn)        |
| `buyback_cycle_duration_seconds` | histogram | `action`                                         |
| `buyback_sol_spent_lamports`     | counter   | —                                                |
| `buyback_tokens_burned`          | counter   | —                                                |
| `upstream_api_error_total`       | counter   | `provider` (jupiter / printr), `status`          |
| `onchain_confirm_error_total`    | counter   | `operation` (swap / burn / claim)                |
| `slippage_bust_total`            | counter   | —                                                |

## Alert thresholds — starting points

Tune to your cycle cadence and tolerance. These are defaults, not prescriptions.

| Condition                                                                    | Severity              | Where                       |
| ---------------------------------------------------------------------------- | --------------------- | --------------------------- |
| Stranded `swap_done` row > 2 scheduler cadences                              | **page**              | SQL alert above             |
| `buyback_cycle_failed_total{stage="burn"}` > 0 in 1h                         | **page**              | metrics                     |
| `buyback_cycle_failed_total{stage="swap"}` > 3 in 1h                         | page                  | metrics                     |
| `buyback_cycle_failed_total{stage="claim"}` > 0 in 24h                       | warning (investigate) | metrics                     |
| `upstream_api_error_total{provider="jupiter"}` > 10 in 1h                    | warning               | metrics                     |
| `upstream_api_error_total{provider="printr"}` > 10 in 1h                     | warning               | metrics                     |
| `slippage_bust_total` > 1 per day                                            | warning               | metrics                     |
| `buyback_cycle_duration_seconds{p95}` > 30s                                  | warning               | metrics                     |
| No `action=completed` in last 4 cycles AND hot-wallet balance > 2× threshold | **page**              | cross-join of metrics + RPC |

## See also

- `SCENARIOS.md` — six canonical end-to-end scenarios including recovery and slippage-bust triage.
- `CUSTODY_PATTERNS.md` — which metrics matter most per custody tier (Pattern 4 operators need tighter alerting).
- `KNOWN_ISSUES.md` (repo root) — runtime assumptions you should also monitor (clock skew, RPC jsonParsed support, Meteora label stability).
