# Security policy

This is a reference / portfolio library, not a hosted service. But it guards a
money-moving path — "process this webhook exactly once" — so a correctness hole
here is a security issue, and I want to know.

## Reporting

If you find a way the exactly-once guarantee fails — two concurrent deliveries
that both run the effect, a store that reports `duplicate` while the effect never
ran, a SQL-injection path through a table name or key, or a way a failed effect is
recorded as done — please report it privately:

- Open a **GitHub Security Advisory** on this repository (Security → Report a
  vulnerability), or
- email **security@shadowvivo.com**.

Please don't open a public issue for a security problem until it's fixed. No bounty
is offered, but I'll credit you unless you'd rather stay anonymous.

## Scope

In scope: the exactly-once-processing guarantee and the store implementations
(`src/`), including the Postgres table-name validation and the concurrency
behaviour described in [`DESIGN.md`](DESIGN.md).

Out of scope (documented limitations, not bugs — see DESIGN.md): the memory store's
single-process nature, the Redis store's non-transactional effect, table growth
needing a retention job (`pruneExpiredKeys`), and the requirement that stored
results be JSON-serialisable.
