# The nightly proofs keep one night each, and the settings-key fault has grown from ten to sixty-seven

**Daily site audit, 12 September.** Base quiet at `1a8554f` — **no new commits since the last
audit**, so steps 1 and 2 had nothing new to check and the arithmetic pass had no changed reader to
read. This is step 3, the organisation check, which had never been run.

`docs/reference/data-audit.md` §3 item 7 says:

> *"**Ten settings keys carry data, not configuration**: the drill-down position, the rebate
> statement and rate, a whole parsed return policy, practice decisions, dataset ids, job state, and
> two that duplicate columns on `suppliers`. **Each is a row in a table somebody will one day want
> the history of.**"*

Measured today:

| | count |
| --- | ---: |
| distinct keys in `SETTING_KEYS` | **174** |
| matching a run-state/outcome pattern (`_last*`, `_result`, `_proof`, `_job`, `_compare`, `_reconcile`, `_on`) | **67** |
| `pioneer_*` alone, all added since that item was written | **25** |

The 67 is a pattern match and deliberately generous — the number to argue with is the seven below,
which is exact.

## The part that costs the owner what this routine exists for

Seven keys hold the outcome of a scheduled run, and **every one is written with `setSetting`, which
replaces the single row for that key**:

```
catalogue_proof   claims_proof   data_health_last   drug_directory_proof
invoice_proof     nadac_proof    rate_backtest
```

There is no proof-history table in `schema.ts`. So the site proves its own data every night and
**keeps exactly one night of it**. It can answer *"is the data sound tonight"* and it can never
answer *"is it getting better or worse"* — which is the whole of what the owner asked this routine
to do: *"the site must keep learning about the pharmacy."* A trend needs two points and the site
stores one.

The same shape is now on every new feed. `pioneer_pull_claims_on` / `_result`,
`pioneer_pull_invoices_on` / `_result`, `pioneer_pull_catalogue_on` / `_result`,
`pioneer_invoice_compare`, `pioneer_claims_reconcile`, `pioneer_catalogue_compare`, `sftp_last_pull`
/ `_result`, `ar_report_last_month` / `_result` — each a run's answer, each overwritten by the next
run. `pioneer_claims_reconcile` is the reconciliation of the pharmacy's own claims against
PioneerRx: the one figure whose *movement* is the measure of whether the feed is improving.

**This is `data-audit.md`'s own item 7 compounding rather than being paid down**, and it is the same
fault as its item 1 (*"catalogue price history is thrown away every Monday"*) and item 3 (*"the
rebate settlement is stored three ways… only the current month survives"*) in a different container.
The audit predicted it; what is new is the measurement that it is growing.

**Fix, and it is one small table, not a migration of 67 keys:** a `run_results` table — `(job,
ran_on, ok, summary_json)` — written by the same place that writes the key today, with the settings
key left alone as "latest" so nothing that reads it changes. Every nightly proof then has a history
from the day it lands, and Data health can show a line rather than a number. The keys that are
genuinely configuration (`pharmacy_*`, `mail_*`, `ai_*`, credentials) stay exactly where they are;
this touches only the ones that record what happened.

## Steps of this routine I could not perform, stated rather than skipped

- **Step 2's live half.** `scratchpad/tx/report.csv` and the three catalogue uploads are on the
  pharmacy computer; this container cannot reach them. The code half was done — there was no changed
  reader on the base to read — and the suite was run (below).
- **Step 5.** `profit-engine.md` §6's next item is not in my file group, and my standing brief is not
  to add a fifth pure module while four await store halves. Nothing built.
- **Step 6's prune.** Nothing to remove: the base has not moved since the last audit, so none of the
  open findings has been fixed since I last checked them.

`npm run check` clean: 3,125 tests, build compiled.

---

Nothing in `settings.ts`, `instrumentation.ts` or any store was edited by me.
