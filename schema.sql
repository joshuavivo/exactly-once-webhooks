-- Schema for the Postgres store. Run once before using createPostgresStore().
--
-- The guarantee rests on two things in this table:
--   1. `key` is the PRIMARY KEY, so only one insert of an event id succeeds.
--   2. a concurrent second insert of the same key blocks until the first
--      transaction ends; on commit it gets zero rows and reads the stored result.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  status        text NOT NULL CHECK (status IN ('pending', 'done')),
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- Optional: let a cleanup job drop old finished keys.
CREATE INDEX IF NOT EXISTS idempotency_keys_completed_at_idx
  ON idempotency_keys (completed_at);
