import { createHmac, timingSafeEqual } from "node:crypto";

// Step 1 of the path: prove the request came from the provider and is recent.
//
// The scheme is the common "signed timestamp" one (Stripe uses this shape):
//   header:  t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
// The HMAC covers the RAW body bytes. Verifying after JSON.parse + re-stringify
// is a classic bug: key order or whitespace changes and every signature fails,
// or worse, someone "fixes" that by skipping verification.

export type Verdict = { ok: true } | { ok: false; reason: string };

export function sign(rawBody: string, secret: string, timestampSec: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSec: number,
  toleranceSec = 300,
): Verdict {
  if (!header) return { ok: false, reason: "missing signature header" };

  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const i = piece.indexOf("=");
    if (i <= 0) continue;
    const k = piece.slice(0, i).trim();
    parts.set(k, [...(parts.get(k) ?? []), piece.slice(i + 1).trim()]);
  }
  const t = Number(parts.get("t")?.[0]);
  const candidates = parts.get("v1") ?? [];
  if (!Number.isInteger(t) || candidates.length === 0) return { ok: false, reason: "malformed signature header" };

  // A captured request replayed later carries a valid signature. The timestamp is
  // inside the signed string, so it cannot be bumped; rejecting old ones closes
  // the replay window to `toleranceSec`. (Exactly-once handles replays inside it.)
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: "timestamp outside tolerance" };

  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "utf8");
  // Several v1 values are allowed so a secret can be rotated without downtime.
  // Constant-time compare: `===` on the hex leaks how many leading chars matched.
  const match = candidates.some((c) => {
    const got = Buffer.from(c, "utf8");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true } : { ok: false, reason: "signature mismatch" };
}
