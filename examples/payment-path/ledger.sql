-- The ledger table for the Postgres version of the example. Load after schema.sql.
--
-- Three database rules carry the guarantees, so they hold even if the app code
-- around them has a bug:
--   1. event_id is UNIQUE: one webhook event can produce at most one ledger row.
--      This is a second, independent guard behind idempotency_keys.
--   2. reverses is UNIQUE: a row can be reversed at most once.
--   3. a trigger rejects every UPDATE and DELETE: history is append-only.
--      Corrections are new rows (a reversal), never edits.

CREATE TABLE IF NOT EXISTS ledger_entries (
  seq           bigserial PRIMARY KEY,
  account       text      NOT NULL,
  amount_cents  bigint    NOT NULL CHECK (amount_cents <> 0),
  ref           text      NOT NULL,
  event_id      text      NOT NULL UNIQUE,
  reverses      bigint    UNIQUE REFERENCES ledger_entries (seq),
  memo          text      NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_no_edit ON ledger_entries;
CREATE TRIGGER ledger_entries_no_edit
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
-- TRUNCATE bypasses row triggers, so block it too.
DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries;
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only();
