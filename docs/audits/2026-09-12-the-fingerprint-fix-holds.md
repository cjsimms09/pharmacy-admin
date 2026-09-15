# The stale-page fix is right and well placed. Two residuals, by the file's own standard.

*12 September 2026 — session 2 (cloud). Audit of `df666bd`, "Show a press its result, and show a
plan its own claims". Concerns `src/lib/held.ts` and `src/lib/audit.ts`. **Nothing to fix.** Recorded
so the checking is not repeated, with two notes.*

## The fix

`fingerprint()` caches itself for two seconds; a server action writes, redirects and re-renders well
inside two seconds; the page was therefore built from the fingerprint taken *before* the write,
matched a cached value younger than ten minutes, and served it. Every action followed by a redirect
into a page reading a held value had it. `audit()` now calls `forgetFingerprint()`.

Hanging it off `audit()` rather than each call site is the right choice and the argument for it is
the right argument — *"the next action somebody writes would forget it"*. Keeping the two seconds is
right too: they exist so one page load asking for six readings takes one fingerprint.

## Checked: does every write really go through `audit()`?

The fix rests on it, so it was checked rather than taken.

| path | writes | audits |
|---|---|---|
| `recheckEverything` → `repairReversals` (updates `claims`, pairs reversals) | yes | yes, `claims.recheck` at `claims/page.tsx:245` |
| `settleStaleFills` (takes revenue off the books) | yes | yes, `claim.reversed.not_dispensed` at `claims.ts:1796` |
| `backfillInvoiceLines` (replaces invoice lines) | yes | yes, `invoice.lines.backfill` at `inventory/invoices/page.tsx:382` |
| `claims-import-job`, `drug-directory-job`, `nadac-job`, `manual-job` | yes | every one of them calls `audit()` |

No write path was found that changes stored figures without an audit row. The claim holds.

## Note one: `invoice_lines` is watched by count, and it is replaced in place

The fingerprint's terms, separated:

```
counted   claims, supplier_items, invoice_lines, driver_invoices, expenses,
          claim_payments, plan_groups, supplier_imports, ndc_pack_fixes
max-ed    audit_events.at, nadac_prices.file_as_of, on_hand_imports.counted_on,
          supplier_imports.created_at, ndc_pack_fixes.corrected_at
```

The docstring already identified this exact hazard once, for `supplier_items`:

> *"A catalogue import replaces only the NDCs the file covers — it deletes them and puts them back —
> so next week's McKesson file … lands on the same number of rows. Counting `supplier_items`
> therefore misses the one change that matters most."*

`invoice_lines` has the same shape and is still counted. `backfillInvoiceLines` re-reads invoices and
replaces their lines, and `86256fb` — three commits later — is precisely such a change: *"the only
stored figure that changed is the propranolol line's NDC and item number"*, same row count, different
drug against $3.99.

It is covered today, by the audit row the backfill's own action writes. But that is the arrangement
this same docstring declines to rely on two paragraphs further down, arguing for a dedicated
`ndc_pack_fixes` term:

> *"The audit event would catch it, but that is **a coincidence of two writes rather than a promise**,
> and this is a promise."*

By that standard `invoice_lines` wants a term that moves when its contents are replaced — a
`max(created_at)`, or the count of whatever row records the backfill — rather than a count that a
replace-in-place leaves untouched.

## Note two: the cache is per process

`fpCache` and `holds` are module-level. `scripts/launch.mjs:597` starts one `next start` with no
cluster flag, so the action and the render share a process and the fix works as deployed — checked,
not assumed. The day this runs behind more than one Node worker, a write in worker A leaves worker
B's two-second cache untouched and the original bug returns for that window. Worth a line in
`held.ts` so the property is stated rather than inherited.

## And the one it did cost

`tests/held-stale.test.ts`, added by this commit, reads the `claims` table through `fingerprint()`.
CI ran `npm run test` with no `npm run db:migrate`, so all four failed with "no such table: claims"
on every runner from this commit onward, on both branches. Fixed on this branch in `8d7c9db`; see
`docs/audits/2026-09-12-ci-never-migrated.md`. Not a fault in the change — the workflow was missing
the step CLAUDE.md already required.
