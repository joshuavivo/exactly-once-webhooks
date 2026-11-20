# Contributing

Thanks for looking. This is a small, focused library maintained by one person, so
the bar for a change is: does it keep the one guarantee true, and stay easy to read?

## Running it

```sh
npm test            # the full contract against the memory + Redis (fake) stores, no services
npm run typecheck   # strict TypeScript
npm run build       # compile to dist/
make check          # all three at once
make db-test        # the contract against a real Postgres + Redis via docker compose
```

## The one rule for a new store

Every store runs the same behavioural contract in
[`test/contract.ts`](test/contract.ts): process once, dedup repeat deliveries, the
concurrent double-credit race, independent keys, and retry after a thrown effect.
If you add a store or a client adapter, wire it into the contract the way the
memory, Postgres and Redis stores do. A store that doesn't run the contract won't
be merged — that contract is the whole point.

## Style

- **No runtime dependencies.** Database/cache clients (`pg`, `redis`) stay optional
  and are reached through the small interfaces in the source, never imported
  directly.
- **Document trade-offs honestly.** A new store's limitations go in the
  "Known limitations" section of [`DESIGN.md`](DESIGN.md), not left for a user to
  discover.
- **Keep it readable.** The library's value is that you can read all of it.

## How changes land

- Every change goes in through a pull request. `main` is protected: the `tests`
  workflow (Node 22 and 24, real Postgres and Redis) must pass before a merge,
  and that applies to the maintainer too.
- Dependabot opens weekly update PRs for dev dependencies and Actions; they pass
  the same gate as anything else.

## Releasing

1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new `## [x.y.z]` heading
   and set `"version"` in `package.json` to match, in one PR.
2. After it merges: `git tag vx.y.z && git push origin vx.y.z`.
3. The `release` workflow reruns the full test gate, refuses a tag that doesn't
   match `package.json`, and publishes a GitHub Release with that changelog section
   as the notes and the `npm pack` tarball attached.

## Reporting a problem

A security issue goes privately through [`SECURITY.md`](SECURITY.md). Anything else
— a bug, a question, a store you'd like to see — is welcome as an issue.
