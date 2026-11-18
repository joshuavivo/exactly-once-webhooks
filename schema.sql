-- Schema for the Postgres store. Run once before using createPostgresStore().
--
-- The guarantee rests on two things in this table:
--   1. `key` is the PRIMARY KEY, so a second insert of the same event id fails.
--   2. the store takes SELECT ... FOR UPDATE on the row, so a concurrent second
--      delivery blocks until the first one has committed its result.

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
