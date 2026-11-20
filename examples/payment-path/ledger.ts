// Step 3 of the path: where the money is recorded.
//
// Append-only. There is no update and no delete method — not hidden, absent. A
// mistake or a refund is corrected by appending a reversal row that points at the
// original, so the history always answers "what happened, and when". Rows are
// frozen, so even code holding a reference cannot edit one in place.
//
// In production this is a table with no UPDATE/DELETE grants (or a trigger that
// rejects them); see the append-only-ledger repo for that version in SQLite.

export type LedgerRow = Readonly<{
  seq: number;
  account: string;
  amountCents: number; // positive = credit, negative = debit/reversal
  ref: string; // the provider's charge id
  eventId: string; // the webhook event that caused this row
  reverses?: number; // seq of the row this one reverses
  memo: string;
}>;

export class Ledger {
  #rows: LedgerRow[] = [];

  append(row: Omit<LedgerRow, "seq">): LedgerRow {
    if (!Number.isInteger(row.amountCents) || row.amountCents === 0) {
      throw new Error(`amountCents must be a non-zero integer, got ${row.amountCents}`);
    }
    const frozen = Object.freeze({ ...row, seq: this.#rows.length + 1 });
    this.#rows.push(frozen);
    return frozen;
  }

  /** Reverse the credit for a charge by appending its negative. Refuses to
   *  reverse twice: the reversal is itself a row, so a second one is visible. */
  reverseCharge(ref: string, eventId: string, memo: string): LedgerRow {
    const original = this.#rows.find((r) => r.ref === ref && r.reverses === undefined && r.amountCents > 0);
    if (!original) throw new Error(`no credit found for charge ${ref}`);
    if (this.#rows.some((r) => r.reverses === original.seq)) throw new Error(`charge ${ref} is already reversed`);
    return this.append({
      account: original.account,
      amountCents: -original.amountCents,
      ref,
      eventId,
      reverses: original.seq,
      memo,
    });
  }

  balance(account: string): number {
    return this.#rows.filter((r) => r.account === account).reduce((sum, r) => sum + r.amountCents, 0);
  }

  rows(): readonly LedgerRow[] {
    return [...this.#rows];
  }
}
