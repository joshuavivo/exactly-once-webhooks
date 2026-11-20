import type { Queryable } from "../../src/index.ts";
import { PermanentError, type PaymentEvent } from "./handler.ts";

// The Postgres apply. `tx` is the transaction the Postgres store opened for this
// event id, so the INSERT below and the store's "this key is done" UPDATE commit
// together. If this throws, both roll back: there is never a ledger row without a
// done key, or a done key without its ledger row.

export async function applyToPgLedger(event: PaymentEvent, tx: Queryable): Promise<void> {
  if (event.type === "charge.succeeded") {
    await tx.query(
      `INSERT INTO ledger_entries (account, amount_cents, ref, event_id, memo)
       VALUES ($1, $2, $3, $4, 'charge succeeded')`,
      [event.data.account, event.data.amount_cents, event.data.charge, event.id],
    );
    return;
  }
  const { rows } = await tx.query(
    `SELECT seq, account, amount_cents FROM ledger_entries
     WHERE ref = $1 AND reverses IS NULL AND amount_cents > 0
     ORDER BY seq
     LIMIT 1`,
    [event.data.charge],
  );
  const original = rows[0];
  // Not there yet: webhooks arrive out of order, so a refund can beat its charge.
  // Transient — the provider's redelivery will find it.
  if (!original) throw new Error(`no credit found for charge ${event.data.charge}`);
  if (event.data.amount_cents !== Number(original.amount_cents)) {
    throw new PermanentError(`partial refund (${event.data.amount_cents} of ${original.amount_cents}) is not supported`);
  }
  // The UNIQUE on `reverses` rejects a second reversal even if this code races.
  await tx.query(
    `INSERT INTO ledger_entries (account, amount_cents, ref, event_id, reverses, memo)
     VALUES ($1, $2, $3, $4, $5, 'charge refunded')`,
    [original.account, -Number(original.amount_cents), event.data.charge, event.id, original.seq],
  );
}

export async function pgBalance(db: Queryable, account: string): Promise<number> {
  const { rows } = await db.query(
    "SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM ledger_entries WHERE account = $1",
    [account],
  );
  return Number(rows[0]!.total);
}
