# Work assigned to the other sessions

The lead session on the pharmacy computer reviews and merges everything here. Workers open pull
requests against `feature/compliance` and never push to it.

**Every worker reads `docs/SESSION-RULES.md` first.** The file ownership below is what keeps three
sessions out of each other's way — if you need a file that is not yours, say so on the pull request
before touching it.

## Who owns what, right now

| Session | Branch | Files it is editing |
| --- | --- | --- |
| **Lead** (pharmacy computer) | `feature/compliance` | `product-groups.ts`, `product-key.ts`, `drug-profit-store.ts`, `products-store.ts`, `money-found.ts`, `replay-store.ts`, `suppliers.ts`, `nadac.ts`, `catalogue-check.ts`, `drug-directory-store.ts`, migrations |
| **Worker A** | `work/money-books` | `ledger.ts`, `ledger-store.ts`, `period-account.ts`, `profit-and-loss.ts`, `src/app/(app)/money/**`, `bars.tsx`, `charts.tsx`, `expense-categories.ts` |
| **Worker B** | `work/inbox-routing` | `mailbox.ts`, `src/app/(app)/inbox/**`, `labels.ts`, `autoroute.ts`, `intake-*`, the document-category plumbing |

| **Worker C** (second session on the pharmacy computer) | `work/invoices`, in the worktree `C:\Users\wwfprx\pharmacy-admin-invoices` | `invoices.ts`, `invoice-lines.ts`, `suppliers-registry.ts`, `rebate-rates.ts` (name matching only), `src/app/(app)/suppliers/**` |

**A second session on the same computer never works in the same folder as the lead.** Two sessions
editing one working copy overwrite each other, and a deploy runs `git checkout -- .` which deletes
whatever the other one had not committed. So a local worker gets a git worktree of its own — a
second folder, its own branch, its own scratch database, `node_modules` shared through a junction —
and uses absolute paths under it for everything. The lead sees the real database; the worktree's
`data/` is empty and migrated, so tests run there and real figures are asked of the lead by
message. When the branch is ready and `npm run check` passes there, the worker messages the lead;
the lead reads the diff, merges into `feature/compliance` and deploys. No GitHub round trip.

Worker A must not touch the catalogue, purchasing or NADAC modules. Worker B must not touch money
or purchasing modules. Neither touches `product-groups.ts` or `product-key.ts` — those are the
lead's and are being changed right now.

---

## Worker A — One set of books, and no figure counted twice

**Why this is the job.** The owner said, in his own words: *"The money tab needs to have sound
logic, needs to not forget about expenses or revenue it knows, needs to not double count things.
This is how I will track financials of pharmacy. It should be able to operate on a cash and accrual
basis. It needs to take into account everything and needs to do it correctly."* This is his books.
The bar is a bookkeeper's bar, not a dashboard's.

**The known problem.** Two period modules landed on the same night from two different sessions and
both are wired into the sidebar. They read the same claims and the same expenses by two different
routes:

- `period-account.ts` + `periodAccount()` / `monthlyTrend()` in `profit-and-loss.ts` + `/money/report`
- `ledger.ts` + `ledger-store.ts` + `/money` (the books)

Until one absorbs the other, neither can be trusted as "the books", and the site presents both to
the owner as if they were authoritative. The proposal already on the table in `docs/HANDOFF.md` is
to keep `/money/report` and the `period-account.ts` types as the reporting surface, and put
`loadShared()` underneath both. That is also a speed fix: `periodAccount()` and `monthlyTrend()`
read every claim once per month — twelve full passes for a year — where `loadShared(months, basis)`
plus `monthInputs()` reads them once.

**What to deliver.**

1. **The fold.** One path from the stored rows to a period's figures, used by both screens. Say in
   the pull request which module survived and what happened to the other one's callers.
2. **A double-count test that would actually catch one.** Not "the function returns a number" — a
   fixture where the same money is reachable by two routes (a claim and its remittance; an invoice
   and its expense; a rebate that is both a credit and a cost reduction) and an assertion that it
   is counted once. Rebates are a reduction in cost of goods and never revenue
   (`expense-categories.ts` says why); putting them in revenue overstates both sales and cost.
3. **A completeness check.** Every feed that carries money must reach the books: claims,
   remittances, supplier invoices, other expense invoices, MTF/facilitator payments, cash receipts,
   bank lines, rebates. For each, either it is in, or the books say out loud that it is not yet.
   Silence is the failure mode here — a missing feed looks exactly like a quiet month.
4. **Cash and accrual, and the difference explained.** A cash change has no accrual side and prints
   as a dash, not a zero — that was caught once already on the books page. The split is on the
   audit list as never examined; examine it.
5. **Prove it balances.** The books should be able to state their own arithmetic: revenue minus
   cost of goods minus expenses equals the net it prints, from the stored rows, in a test.

**What you cannot do from a cloud container:** read the real database. If you are in the cloud,
build it against fixtures, and write into `docs/HANDOFF.md` exactly which figures you need counted
on the real data — the lead will run them and report back. Do not ask the owner to send you files.

---

## Worker B — An inbox that knows what arrived, and can always be corrected

**Why this is the job.** The owner's words: *"I have an email integrated into the site, so that I
can automatically send invoice, catalogs, claims, etc to this email to get into the site. The tools
I have on this inbox folder need to be a lot better and a lot smarter. The inbox should eventually
be able to know what's coming in based off name, email, contents but I also need tools on this page
to route things exactly where they need to be or tell system exactly what we received. There will
be numerous things coming to this email from employee compliance documents, to supplier catalogs,
to expense invoices, to more. It needs to be able to handle it all allow me to tell it what it
received. From there it should know how to use it."*

**The shape of it.** Two halves, and the second must never be missing.

1. **Guess well.** From sender address, sender display name, subject line, attachment filename, and
   the first few kilobytes of the file itself. The recognisers already exist but each knows exactly
   one shape and they are scattered: `looksLikePioneerCatalog`, `looksLikeNadacHeader`, the contract
   triage in `contract-extract.ts`, the routing in `mailbox.ts`. Build **one** place that asks all
   of them, ranks the answers, and returns *what it thinks, how sure it is, and why* — the "why" in
   words the owner can judge ("the sender is the McKesson catalogue address and the first line
   matches the PioneerRx export header"), not a score.
2. **Always be correctable.** The owner tells it what a document actually is, from the inbox page,
   and it is then handled exactly as if it had been recognised. This is the half that must not be
   skipped: a guess that cannot be overridden is worse than no guess, because the document goes
   somewhere wrong and silently. His correction should also be remembered — the same sender sending
   the same shape next week should not need correcting twice.

**Categories to handle today**, and the design must take a new one without a rewrite: supplier
catalogues, supplier invoices, expense invoices, claims exports, NADAC files, reimbursement
contracts, employee compliance documents, ERA enrolment, appeals, MTF/facilitator remittances.

**What to deliver.**

1. One recogniser that returns `{ kind, confidence, why, evidence }` for an arriving message and
   each of its attachments, pure and tested, with fixtures for each category.
2. The inbox page showing what it thinks and why, and a control to say what it actually is.
3. The correction persisted as a rule keyed on what is stable about the sender, so it applies next
   time, and visible somewhere the owner can see and undo it.
4. A test for the case that matters most: an unrecognised document does **not** get filed anywhere
   on a guess. It waits and says it is waiting.

**Do not** touch the money or purchasing modules. If routing a document requires a change inside an
importer that belongs to the lead, say so on the pull request and leave a seam rather than editing
it.

---

## What comes back to the lead

A pull request against `feature/compliance` with the five things `docs/SESSION-RULES.md` §7 asks
for, and a line in `docs/HANDOFF.md`. The lead checks it against the real database and pushes.
