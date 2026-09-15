# CI has been red since `df666bd`, and `npm run check` could not see it

*12 September 2026 — session 2 (cloud). Concerns `.github/workflows/check.yml` and
`tests/held-stale.test.ts`. Fixed on `claude/repo-audit-catalog-claims-2l37sj` (PR #25).*

## What happened

A `check_run.completed` event on my own head commit `b26ca33` reported `failure`. The commit is
docs-only — one audit file — so the failure could not be the change. The log tail said:

```
# tests 3205
# pass 3201
# fail 4
```

but stopped short of the names.

## The four

Reproduced by doing locally what the runner does — delete `data/pharmacy-admin.db*` and run
`npm run test` **without** migrating first:

```
tests/held-stale.test.ts
  not ok 1 - the same fingerprint inside two seconds is reused — the saving this cache exists for
  not ok 2 - forgetting it makes the next call go back to the tables
  not ok 3 - a held reading recomputes once the fingerprint is forgotten
  not ok 4 - REGRESSION: audit clears it, so the page after a press is not the page before it

error: 'SQLITE_ERROR: no such table: claims'
  async fingerprint (src/lib/held.ts:70:13)
```

All four call `fingerprint()`, which queries `claims` to decide whether a cached reading is still
good. On a runner `./data` is empty, so there is no `claims` table and there never was.

## Not mine, and that first

`tests/held-stale.test.ts` arrives in `df666bd` — *"Show a press its result, and show a plan its own
claims"* — on `feature/compliance`, which is my base. Confirmed against the run history rather than
assumed: runs **1490 (push) and 1491 (pull_request), both on `521dd79`, both `failure`** — the base
branch failing its own CI, before my branch touched it. `6c95f2b`, `6a04682` and `25f5b00` were the
last green. So every commit from `df666bd` onward is red, on both branches.

## Why nobody noticed

`.github/workflows/check.yml` ran `npm ci`, `npm run typecheck`, `npm run test`, `npm run build`.
There was no `npm run db:migrate`. On either developer machine there is a migrated
`data/pharmacy-admin.db` sitting in the working tree from `npm run dev`, so `npm run check` passes
there and passed for both sessions. The only place the schema is genuinely absent is the one place
nobody runs by hand.

CLAUDE.md states the rule already: *"Tests that touch the database need a migrated one:
`npm run db:migrate` first."* The workflow was the half that did not say it.

## The fix

One step, before the tests:

```yaml
- run: npm run db:migrate
- run: npm run test
```

No env. `scripts/migrate.ts` and `src/db/index.ts` both default to `./data/pharmacy-admin.db`, and
`migrate.ts` `mkdirSync`s the directory, so a runner with no `./data` is fine. The `build` step keeps
its own `DATABASE_PATH: ./data/ci.db`; it runs after the tests and does not read the file.

## Checked, not assumed

On the same tree, deleting `data/pharmacy-admin.db*` each time:

| | tests | pass | fail |
|---|---|---|---|
| `npm run test` with no migrate — what CI did | 3205 | 3201 | 4 |
| `npm run db:migrate` then `npm run check` | 3205 | 3205 | 0 |

Build clean.

## What this costs if it is dropped

A red tick that is red for a reason nobody is acting on stops being read. Both sessions push to this
repository without seeing each other's work, and the check is the only thing that tells either one
that the other's commit broke something. Four failures that are *always* there mask the fifth that
is not.
