import { verifySignature } from "./signature.ts";
import type { Ledger } from "./ledger.ts";
import type { IdempotencyStore } from "../../src/index.ts";

// The whole path for one webhook delivery, in order:
//   1. verify the signature on the raw body           → 400 if bad (nothing stored)
//   2. parse and validate the event                   → dead letter if malformed
//   3. run the ledger write exactly once per event id → 200
//      (with the Postgres store, the ledger row and the idempotency record
//      commit in ONE transaction: see pg-ledger.ts)
//   4. if the write fails: 500 so the provider retries,
//      and after `maxAttempts` failures, dead-letter it and 200 so retries stop.
//
// Why 400 for a bad signature but 200 for a dead-lettered event: a bad signature
// is not from the provider (or the secret is wrong) and must never be trusted or
// stored. A dead-lettered event IS genuine but cannot be applied; we keep it for a
// person, and acknowledge it so the provider stops hammering a request that will
// fail the same way every time.

export type PaymentEvent = {
  id: string;
  type: "charge.succeeded" | "charge.refunded";
  data: { charge: string; account: string; amount_cents: number };
};

/** Throw this from `apply` for an event that will fail the same way on every
 *  retry (a partial refund this ledger doesn't support, an unknown account). It is
 *  dead-lettered at once instead of burning the provider's retries. Any other
 *  error is treated as transient: 500, and the provider redelivers. */
export class PermanentError extends Error {}

export type DeadLetter = { eventId: string | null; reason: string; rawBody: string; attempts: number };

export type Response = { status: 200 | 400 | 500; body: string };

export type HandlerOptions<Ctx> = {
  secret: string;
  store: IdempotencyStore<Ctx>;
  /** The ledger write. It receives the store's context — for the Postgres store,
   *  the open transaction — so the write commits with the "done" record or not
   *  at all. Tests swap in a flaky version to drive the retry and dead letter. */
  apply: (event: PaymentEvent, ctx: Ctx) => Promise<void>;
  /** Failures of the ledger write before an event is dead-lettered. Default 3. */
  maxAttempts?: number;
  now?: () => number; // seconds
};

/** The in-memory apply, for the `Ledger` class (memory store, no database). */
export async function applyToLedger(event: PaymentEvent, ledger: Ledger): Promise<void> {
  if (event.type === "charge.succeeded") {
    ledger.append({
      account: event.data.account,
      amountCents: event.data.amount_cents,
      ref: event.data.charge,
      eventId: event.id,
      memo: "charge succeeded",
    });
  } else {
    const original = ledger.rows().find((r) => r.ref === event.data.charge && r.reverses === undefined && r.amountCents > 0);
    // Not there yet: webhooks arrive out of order, so a refund can beat its charge.
    // Transient — the provider's redelivery will find it.
    if (!original) throw new Error(`no credit found for charge ${event.data.charge}`);
    if (event.data.amount_cents !== original.amountCents) {
      throw new PermanentError(`partial refund (${event.data.amount_cents} of ${original.amountCents}) is not supported`);
    }
    ledger.reverseCharge(event.data.charge, event.id, "charge refunded");
  }
}

function parseEvent(raw: string): PaymentEvent | string {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return "body is not JSON";
  }
  const e = v as Partial<PaymentEvent>;
  if (typeof e?.id !== "string" || !e.id) return "missing event id";
  if (e.type !== "charge.succeeded" && e.type !== "charge.refunded") return `unsupported event type ${JSON.stringify(e.type)}`;
  const d = e.data;
  if (!d || typeof d.charge !== "string" || typeof d.account !== "string") return "missing charge or account";
  if (!Number.isInteger(d.amount_cents) || d.amount_cents <= 0) return "amount_cents must be a positive integer";
  return e as PaymentEvent;
}

export function createPaymentHandler<Ctx>(opts: HandlerOptions<Ctx>) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const apply = opts.apply;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const deadLetters: DeadLetter[] = [];
  // Failed DELIVERIES per event id. In production this lives next to the
  // dead-letter table (or comes from the provider's attempt header), not in memory.
  const failures = new Map<string, number>();
  // Deliveries of an event currently in flight. Concurrent copies that fail
  // together are one failed delivery, not N: only the last one out counts it.
  // Otherwise a burst of three copies during one DB blip would exhaust
  // maxAttempts=3 in a single moment and dead-letter a payment that a later,
  // ordinary redelivery would have applied.
  const inFlight = new Map<string, number>();
  const idOf = (raw: string): string | null => {
    try {
      const id = (JSON.parse(raw) as { id?: unknown })?.id;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  };

  async function handle(rawBody: string, signatureHeader: string | undefined): Promise<Response> {
    const verdict = verifySignature(rawBody, signatureHeader, opts.secret, now());
    if (!verdict.ok) return { status: 400, body: verdict.reason };

    const parsed = parseEvent(rawBody);
    if (typeof parsed === "string") {
      // Keep the id when the body has one, so redeliveries of the same malformed
      // event don't each add another letter.
      const id = idOf(rawBody);
      if (id && deadLetters.some((d) => d.eventId === id)) return { status: 200, body: "already dead-lettered" };
      deadLetters.push({ eventId: id, reason: parsed, rawBody, attempts: 0 });
      return { status: 200, body: "dead-lettered" };
    }
    const event = parsed;
    if (deadLetters.some((d) => d.eventId === event.id)) return { status: 200, body: "already dead-lettered" };

    inFlight.set(event.id, (inFlight.get(event.id) ?? 0) + 1);
    try {
      const outcome = await opts.store.run(event.id, async (ctx) => {
        await apply(event, ctx);
        return event.type;
      });
      failures.delete(event.id);
      return { status: 200, body: outcome.status };
    } catch (err) {
      if (err instanceof PermanentError) {
        if (!deadLetters.some((d) => d.eventId === event.id)) {
          deadLetters.push({ eventId: event.id, reason: err.message, rawBody, attempts: 1 });
        }
        failures.delete(event.id);
        return { status: 200, body: "dead-lettered" };
      }
      // The store stored nothing (a failed effect is never recorded), so the next
      // delivery will try again. Count the failed delivery once per burst of
      // concurrent copies; give up into the dead letter at the cap.
      if ((inFlight.get(event.id) ?? 1) > 1) return { status: 500, body: "retry" };
      const n = (failures.get(event.id) ?? 0) + 1;
      failures.set(event.id, n);
      if (n >= maxAttempts) {
        failures.delete(event.id);
        deadLetters.push({ eventId: event.id, reason: (err as Error).message, rawBody, attempts: n });
        return { status: 200, body: "dead-lettered" };
      }
      return { status: 500, body: "retry" };
    } finally {
      const left = (inFlight.get(event.id) ?? 1) - 1;
      if (left > 0) inFlight.set(event.id, left);
      else inFlight.delete(event.id);
    }
  }

  /** After the cause is fixed, a person replays a dead letter. It goes through the
   *  same exactly-once path, so replaying twice still writes once. */
  async function replay(eventId: string): Promise<Response> {
    const letter = deadLetters.find((d) => d.eventId === eventId);
    if (!letter) return { status: 400, body: "no such dead letter" };
    // A letter parked because the event itself was malformed is still malformed:
    // refuse it (400) and keep it, rather than hand the unparsed body to the write.
    const parsed = parseEvent(letter.rawBody);
    if (typeof parsed === "string") return { status: 400, body: `still malformed: ${parsed}` };
    const event = parsed;
    // If the replay fails too, the letter stays where it is: nothing is lost.
    const outcome = await opts.store.run(event.id, async (ctx) => {
      await apply(event, ctx);
      return event.type;
    });
    deadLetters.splice(deadLetters.indexOf(letter), 1);
    return { status: 200, body: outcome.status };
  }

  return { handle, replay, deadLetters: () => [...deadLetters] };
}
