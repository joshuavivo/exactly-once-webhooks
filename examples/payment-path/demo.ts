// node examples/payment-path/demo.ts — one story, start to finish, no services.
import { createMemoryStore } from "../../src/index.ts";
import { sign } from "./signature.ts";
import { Ledger } from "./ledger.ts";
import { applyToLedger, createPaymentHandler } from "./handler.ts";

const secret = "whsec_demo";
const ledger = new Ledger();
const h = createPaymentHandler({ secret, store: createMemoryStore(), apply: (e) => applyToLedger(e, ledger) });
const now = Math.floor(Date.now() / 1000);
const send = (event: object, s = secret) => {
  const body = JSON.stringify(event);
  return h.handle(body, sign(body, s, now));
};
const paid = { id: "evt_1", type: "charge.succeeded", data: { charge: "ch_1", account: "acct_42", amount_cents: 2500 } };

console.log("forged signature        →", await send(paid, "attacker_guess"));
const copies = await Promise.all([1, 2, 3, 4, 5].map(() => send(paid)));
console.log("5 copies at once        →", copies.map((r) => r.body).join(", "));
console.log("balance                 →", ledger.balance("acct_42"));
console.log("refund                  →", await send({ id: "evt_2", type: "charge.refunded", data: { charge: "ch_1", account: "acct_42", amount_cents: 2500 } }));
console.log("malformed (genuine)     →", await send({ id: "evt_3", type: "charge.succeeded", data: { charge: "ch_3", account: "acct_42", amount_cents: 0 } }));
console.log("ledger rows             →");
for (const r of ledger.rows()) console.log("   ", r.seq, r.amountCents, r.ref, r.reverses ? `reverses #${r.reverses}` : "");
console.log("balance                 →", ledger.balance("acct_42"));
console.log("dead letters            →", h.deadLetters().map((d) => d.reason));
