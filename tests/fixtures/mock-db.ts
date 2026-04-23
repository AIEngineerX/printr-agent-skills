// pg-mem-backed in-memory Postgres. Real SQL (UNIQUE, CHECK, UPDATE WHERE)
// enforced against our actual schema — so the UNIQUE + idempotent-UPDATE
// claims in the skill get exercised against a real database engine.

import { newDb, type IMemoryDb } from 'pg-mem';
import type { QueryablePool } from '../../src/payments/verify.js';

export interface TestDb {
  pool: QueryablePool;
  inner: IMemoryDb;
  reset: () => void;
}

const PAYMENT_INVOICE_SCHEMA = `
CREATE TABLE payment_invoice (
  memo                    BIGINT        PRIMARY KEY,
  session_id              TEXT          NOT NULL,
  user_wallet             TEXT          NOT NULL,
  currency_mint           TEXT          NOT NULL,
  amount_smallest_unit    BIGINT        NOT NULL,
  start_time              BIGINT        NOT NULL,
  end_time                BIGINT        NOT NULL,
  status                  TEXT          NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending','paid','expired','cancelled')),
  tx_sig                  TEXT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  paid_at                 TIMESTAMPTZ,
  purpose                 TEXT
);
CREATE INDEX payment_invoice_session_idx ON payment_invoice (session_id, created_at DESC);
`;

const BURN_EVENT_SCHEMA = `
CREATE TABLE burn_event (
  id                      BIGSERIAL     PRIMARY KEY,
  sol_in_lamports         BIGINT        NOT NULL,
  agent_token_bought      BIGINT        NOT NULL,
  agent_token_burned      BIGINT        NOT NULL,
  agent_token_staked      BIGINT        NOT NULL DEFAULT 0,
  swap_sig                TEXT          NOT NULL,
  burn_sig                TEXT,
  stake_sig               TEXT,
  status                  TEXT          NOT NULL DEFAULT 'swap_done'
                                        CHECK (status IN
                                          ('swap_done','burn_done','stake_done','complete','failed')),
  error                   TEXT,
  cycle_started_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ
);
`;

export function createTestDb(): TestDb {
  const db = newDb();
  db.public.query(PAYMENT_INVOICE_SCHEMA);
  db.public.query(BURN_EVENT_SCHEMA);

  const pool: QueryablePool = {
    async query(text, params) {
      // pg-mem's adapters.createPg() returns a pg-compatible Pool. Use
      // that so queries accept $1/$2 parameterization and return rowCount.
      const { Pool } = db.adapters.createPg();
      const p = new Pool();
      const res = await p.query(text, params as any[] | undefined);
      await p.end();
      return { rows: res.rows, rowCount: res.rowCount };
    },
  };

  return {
    pool,
    inner: db,
    reset: () => {
      db.public.none(`DELETE FROM payment_invoice`);
      db.public.none(`DELETE FROM burn_event`);
    },
  };
}
