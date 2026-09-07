# Design audit: from an internal tool to a product

Walked every page of the site on a scratch database seeded with the pharmacy's real catalogues,
the real 5 September transaction report, four suppliers with terms, and benchmark prices, at
1360 px, as an owner would see it on the pharmacy computer. Screenshots are on the cloud side
(never committed). Findings are ordered by what changes the owner's morning most, then by what
makes it a product somebody else would buy.

## 1. The verdict in one paragraph

The site is unusually honest and unusually wordy. Every page explains itself in full sentences,
every figure says where it came from, and nothing is estimated. That is the right foundation and
should not be lost. But the same trait makes it read like documentation with data inside it
rather than a product with help beside it: the pharmacist has to read to find the number. The
fix is not a new look. It is a consistent page shape, the explanation moved one click away, the
primary figure and the primary action made unmistakable, and the tables given the tools a table
needs. Then a visual identity on top.

## 2. What is already good, and must survive

- **The money list** (`/money`): amount, instruction, confidence, basis, link. That is the
  product. Everything else should look more like it.
- **Empty states everywhere**, and each says what fills it. Keep.
- **"Money this cannot see yet"**: naming what is missing instead of showing a short list.
- **Claims**: the three alert lines at the top, the four figures, the per-fill disclosure "why is
  this a loss, show the row as it arrived". The best page on the site.
- **The supplier cards** with catalogue, rebate and returns beside invoices, Edit on each.
- **Print pages and the checklist mechanics** on the compliance side.

## 3. The ten changes that matter most

1. **One page shape, everywhere.** Header (title, one-line subtitle, the page's actions on the
   right); then the figures (three to five, never more); then the one list the page exists for;
   then everything else behind disclosures. Today, Purchasing, Claims and Settings each do this
   differently; Purchasing puts a file-upload form between the figures and the list.
2. **Explanation goes behind a "Why" or "How this works" disclosure, one line stays.** Today's
   "Needs you" card, the invoices page's rule-by-rule section, Purchasing's two paragraphs, the
   NADAC page's six paragraphs: each is right and each is in the way. The claims page already
   does this ("▸ Why").
3. **Today leads with money, then what needs you, then compliance.** The scoreboard is there;
   under it should be the top three lines from the money list, with their amounts and actions,
   before "Needs you today". Compliance detail (one-click closures, "does this apply") folds
   into one card with a count and a link. Today is currently 2,950 px tall and the owner will
   stop scrolling at 900.
4. **Tables get table tools.** Sort by column, a filter box, sticky header, pagination or "show
   50 more", column alignment for money (right), and a row action menu. Purchasing's table is
   5,500 px with none of these; "Who pays best" is 9,000 px. A product does not ship a
   nine-thousand-pixel page.
5. **Forms move out of the page flow.** "Add a supplier", "Load a supplier price file", "Add an
   invoice by hand", "Add login" become a button in the header that opens a drawer or a
   dedicated page. Today the add form is the tallest thing on the suppliers page.
6. **Every list row gets its actions.** Edit, delete (or retire, with the reason), and open,
     in the same place on every row: a trailing "…" menu on tables, buttons on cards. See §5.
7. **A number is a number.** Money right-aligned, tabular figures, two decimals, unit on the
   header not the cell, negatives in red with a minus, and the unit price beside the pack price
   only when both are known. NDCs in monospace under the name, as now, but not in the sort key.
8. **Colour means something.** Green is the accent and also "ok"; amber is "worth checking";
   red is "money going the wrong way" or "late". Today the four scoreboard cards, the badges,
   the alert lines and the buttons use these inconsistently (a red-bordered "Needs you" card
   with green buttons inside it; an amber warning card with a black button).
9. **Charts where a trend is the point.** The scoreboard's month-to-date, the rebate position
   against the band ladder, NADAC coverage, and the six-month drill-down trend are all numbers
   today; each is a small chart with the number on it. Nothing else on the site needs a chart.
10. **An identity.** A name that is not "Pharmacy Admin", a mark, the pharmacy's own logo in
    the sidebar (the setting exists), a type pairing, and a colour system with tokens for
    surface, ink, line, accent and the three semantic tones. Then the same on every printed
    page.

## 4. Page by page

| Page | What is prominent now | What should be | Tools missing |
|---|---|---|---|
| Today | scoreboard, then compliance | scoreboard, top three money lines, then what needs you | mark a money line acted / not doing |
| Where the money is | the list (good) | add: age on the list, acted/dismissed buttons, the scorecard under it | act / dismiss per row |
| Purchasing | upload form, catalogue table, then a 5,500 px comparison | the buy list first; comparison table with sort, filter, pagination; upload behind a button | sort, filter, page, export |
| The shelf | upload form | days of stock and surplus first, upload behind a button | filters by state |
| Claims | alerts, figures, loss list (good) | keep; the day-range default is one day, which surprises | export the range |
| Who pays best | three tables totalling 9,000 px | the payer ranking first; drug table and chain table behind tabs | sort, filter, page |
| Payers | search, lookup, reload | the ranked payers; search in the header | edit a link; delete a wrong one |
| Plans | one button | the register as a table with classification inline | edit classification per row (exists on detail?) |
| Suppliers | McKesson rebate card, four cards, add form | cards; add behind a button; the ratio card only when a ratio is held | delete (retire exists); edit terms inline |
| Supplier terms | two forms | the ladder as a table with the current band marked; forms behind Edit | delete a schedule version |
| Supplier invoices | five figures, a long search form, empty list, rules section | figures, list, search in the header, rules behind a disclosure | delete an invoice (exists now), mark received |
| What to send back | list | ranked by money at risk (the shelf page now does this) | mark returned, with the credit memo |
| NADAC | six paragraphs and five forms | one status line, one Fetch button, coverage figures, weeks table; everything else behind "Advanced" | delete a bad week |
| Inbox | list | list with filters by kind and outcome | re-run, delete |
| Settings | one 3,200 px column | tabs: Pharmacy, Identifiers, Logo, Claude, Logins, Network, Backups | edit / remove a login |
| Staff, Compliance, Licences, CQI, Temps | (out of this audit's money scope) | the same page shape | per the inventory |

## 5. The tools on every screen

Every screen that shows records must offer, in the same place, the same way: **add** (header
button), **edit** (row or card), **delete or retire** (row menu, with a confirmation that says
what else goes with it), **open** (the row itself). The inventory in §7 lists where any of the
four is missing. Two rules: a delete that cascades says so before it runs ("this also removes
its 21 lines"), and a delete on a record the law says to keep (an invoice, a controlled
substance record) is a retire with a reason, never a removal.

## 6. Making it a product

- **Onboarding.** A first-run flow: pharmacy details, the mailbox, the suppliers and their
  addresses, the feature flags. Today these are spread over Settings and three pages.
- **Feature flags as plans.** "Extra sections" becomes Compliance / Money / Both, on the
  pharmacy record, not a settings string.
- **Multi-pharmacy.** Every table keyed to a pharmacy id from the start of the next migration;
  one database per pharmacy is fine for now, but the schema should not assume one.
- **Help in place.** The prose that comes out of the pages goes into a help panel per page,
  opened from a "?" in the header, and into a manual.
- **Notifications.** The digest exists; a notification tray in the header for the daily audit,
  a failed fetch, a report that did not arrive.
- **Responsive.** The sidebar is fixed at 227 px and the pages assume 1,360; a tablet at the
  bench should get a collapsible sidebar and cards that stack.
- **Accessibility.** Contrast on the grey helper text (#6b7280 on white fails AA at 12 px);
  focus rings; table headers as `th` with scope; buttons that are buttons.
- **A design system.** `src/components/ui` has PageHeader (now with `help`), Card, Notice, Empty,
  Figure (now with `size`), badges. Added 6 September: `data-table.tsx` (sort, filter, page),
  `kit.tsx` (LinkTabs, Stat with delta and sparkline, `deltaOf`), `kit-client.tsx` (Drawer,
  RowMenu, HelpPanel), `bars.tsx` (grouped bars each a link, Sparkline) and the pharmacy
  session's `charts.tsx` (BarChart, LineChart, Movement, for the printed report). Used so far on
  the books, appeals, sort, minimums and replay pages; the rest of the site still hand-rolls (see
  §7.3), and moving each page onto these is the page-by-page pass still to do.

## 7. Inventory of pages, sections and actions

Every `page.tsx` under `src/app/(app)` (92 pages) was read for its header, sections, buttons,
empty state and feedback. The full table is at the end; the findings come first because they are
what to fix.

### 7.1 Lists of records with no way to edit or delete a row

| Page | What can be added | What cannot be changed or removed |
|---|---|---|
| `/expenses` | a bill (record, confirm) | a bill, once recorded |
| `/inventory/discrepancies` | a discrepancy | correct or delete one; it can only be closed |
| `/inventory/power-of-attorney` | a POA | revoke or delete beyond printing a revocation |
| `/staff/rotations` | a student | edit or end a rotation |
| `/payers/[pbm]` | nothing on the page | contacts, network rates, contract documents, notices: all render-only |
| `/plans` | a plan, from the claims | correct a plan's classification or remove a wrong one |
| `/deliveries` | a day, an invoice | delete a delivery day or a raised invoice |
| `/settings/backups` | a backup | restore or delete a listed archive |
| `/suppliers` | a supplier (edit exists) | delete; the retire path is on the terms page only |
| `/cqi/import` | an import | delete; it lives on the child page only |

Read-only **by design** and correct as such: `/audit`, `/compliance/training/records`,
`/compliance/register`, `/inventory/returns`, `/purchasing` comparison tables. A delete on a
record the law says to keep is a retire with a reason (§5).

### 7.2 Forms without a success message

Error-only (`?error=` and a red notice, nothing on success): `/cqi/import`, `/cqi/import/[id]`,
`/cqi/summaries/new`, `/cqi/incidents/new`, `/intake/[id]` (six forms), `/reports`,
`/settings/updates`. No feedback at all: `/money/monthly`, `/staff/new-hire/pack`. The success
key itself is spelt three ways: `?ok=` in 31 files, `?saved=` in 14, `?done=` in 1, so a
"Saved." notice is three different code paths. One helper (`feedback(searchParams)`) and one key.

### 7.3 Where the shared components are not used

- **`PageHeader` missing on 20 pages.** Six are real screens, not print pages:
  `/compliance/attestations`, `/compliance/training/records`, `/inventory/pharmacist-log`,
  `/inventory/power-of-attorney`, `/staff/technician-list`, `/documents/manual`.
- **`Card` on 20 pages; a raw `<h2>` on about 40.** Whole screens without a Card: `/settings`
  (9 headings), `/nadac` (8), `/remits/mtf` (8), `/purchasing` (7), the training course page (6),
  `/cqi` and the CQI summary (5 each). The `.section*` classes in `globals.css` are used by no
  file; 26 pages hand-roll `rounded-lg border border-line bg-surface` instead.
- **A second primary button** — done at `66784b2`: the hand-typed `rounded-md bg-ink …` button is
  gone from all twelve pages; every primary is `btn btn-primary` (`btn-sm` where it was small).
- **Destructive actions as bare text links** — done: the deletes on `/licenses`, `/staff/[id]`,
  `/cqi/incidents` and "Remove the stored key" on `/settings/connections` are `btn btn-sm btn-danger`.
  Retire, make-inactive and put-back controls stay quiet links on purpose: they are reversible.
- **`Empty` on 35 pages; ten more hand-write "Nothing yet"**: `/forms`, `/documents`,
  `/settings`, `/staff/technician-list`, the supplier terms page, `/cqi/import/[id]`,
  `/compliance`. `StatusBadge` on 4 pages; `className="badge …"` hand-written on about 30.
- **`Hub`** is used by `/records`, `/settings`, `/tools` and now `/purchasing`, which also opens
  with five figures (today's order, saved, next band, switches, losses), each a link to the card
  or page that explains it. The other group landings still hand-roll it.
- **Tables without an overflow wrapper** — done for the screens (`/settings`, `/inventory`, `/cqi`,
  `/cqi/import`, the CQI summary); the print sheets (`/compliance/training/records`,
  `/staff/technician-list`, `/forms/vaccine-administration`, `/documents/manual`, the training
  handout) are paper-width by design and stay as they are.
- **Headings off the type scale**: `/manual/print` (`text-[2.1rem]`), the temperature print
  (`text-xl` h1), `/staff/new-hire/pack` (`text-3xl` h1).

### 7.4 Navigation

Regrouped on 6 September into the sections the owner named, in the order the day runs: Today,
Money (the books, statement, spending, driver invoices, money found, who pays best), Ordering (what
to buy, the shelf, suppliers and rebates, supplier invoices, returns, supplies), Claims (claims,
Kansas floor, payers, contracts, plans), Remits, Compliance (register, licences, inspection, walk,
manual, CQI, temperatures, records), People, Controlled substances, Tools (inbox, add documents,
NADAC, report check, find, activity log), Settings. Ten groups, none over eight items; a group whose
every page is behind the flag is hidden with them. **Revised 7 September (§8): nine groups, the
one-page Remits group folded into Claims, and pages that are sides of one thing joined as families
with a row of tabs.** `/money` is the books; the money list is
`/money/found`. Section landings still to build as dashboards: Ordering (`/purchasing` has no
figures), Claims (has them), Remits (lands on the facilitator page), Compliance (has them).

### 7.5 Design tokens (`src/app/globals.css`)

Tailwind v4 `@theme`. One accent (`#0e6b5a`) with soft and line variants; ink ramp
`#16201f` / `#4a5553` / `#7c8683`; ground `#f6f7f8`, surface white, two line greys; `warn`
`#8a5d0a` and `crit` `#a5312a` with soft variants. Segoe UI stack; two shadows; a four-step type
scale set on the elements. Components: `.btn` (+primary, danger, sm), `.card`, the unused
`.section*`, `.field`/`.label`/`.hint`, `.badge` (+ok/warn/crit/muted), `.table` (sticky head,
banding, `.num`), `.rows`/`.row`. No spacing tokens; no dark mode (`color-scheme: light` is
hard-set); a print block that collapses the shell. What is missing for §3: an `info` tone, a
`success` tone distinct from the accent, a numeric font feature setting on `.num`
(`font-variant-numeric: tabular-nums`), and tokens for the three semantic tones' text on dark.

`src/components/ui.tsx` exports `PageHeader`, `Card`, `Figure`, `Empty`, `Notice`,
`StatusBadge`, `BackLink`, `Field`, `Row`, `History`. `ConfirmButton`, `SubmitButton`,
`PrintButton`, `Hub` and the rest live beside it, outside the barrel. The DataTable, Drawer,
RowMenu, Tabs and Stat-with-trend of §6 do not exist yet.

### 7.6 The pages

Legend: `*` primary button, `!` danger button, `bg-ink` the hand-rolled dark button.

| Route | Title | Sections | Actions | Empty state | Notes |
|---|---|---|---|---|---|
| `/` | Today | Scoreboard; Needs you today; One-click closures; Nothing is late; Does this apply here? | Where the money is\*, Compliance, Training, Work through\*, Install now, Yes\*, Not us | no | 8 cards, 1 raw h2 |
| `/money` | Where the money is | list; Money this cannot see yet | Do it, Go and do it\* | yes | 1 raw h2; no act/dismiss |
| `/money/monthly` | Monthly profit and loss | figures | Spending, Show (bg-ink) | yes | no feedback on its form |
| `/purchasing` | Purchasing | Today's order; Load a price file; Scheduled catalogues; Buy these instead; What to do about it; What each drug earns; How this compares | The shelf, Load, Inbox | yes | 7 raw h2, no Card; tables wrapped |
| `/purchasing/shelf` | The shelf | Upload today's count; Surplus | Upload, What to send back | yes | |
| `/claims` | (standing) | Dispensed at a loss; Loads | Who pays best\*, Paid under the floor, Classify plans, Recheck, Search, Load | yes (3) | gated; 2 bg-ink; 7 hand badges |
| `/claims/floor` | Paid under the floor | What is stopping the rest; Paid below the floor; Assuming | Plan register, Load, Go and fix it | yes | gated; read-only |
| `/payers` | Payers | Search contracts; Look up a BIN; Reload reference data | Who pays best\*, Kansas floor, Classify plans, Search\*, Name it, Run import | yes | gated; 3 non-btn; not in nav |
| `/payers/[pbm]` | payer | MAC appeal; Where the money comes from; Network rates; BINs; Contacts; Documents; Notices | Back only | yes (6) | read-only throughout |
| `/payers/performance` | Who pays best | Paying best; Copay cards; Per drug; Company/BIN/group/contract; Where the chain breaks | Kansas floor, Classify plans, Claims, Set, Link it once | yes (3) | gated; 9,000 px |
| `/plans` | Plans | How to establish one | Build it from the claims, Record, Pick up plans | yes (2) | 3 bg-ink; no edit/delete |
| `/suppliers` | Suppliers | ratio card; supplier cards; Add/Edit | Supplier invoices, The ladders, Bring them across\*, Edit, Cancel | yes | no delete |
| `/suppliers/[id]/terms` | supplier | How they take an order; What comes off; Rebate programmes; How you know it read right; File a rebate report; Return policy; Edit; Superseded | Save terms, See what it would order, Read and file\*, Remove, Save return policy\*, Change it | no | 9 Cards; hand-rolled empty |
| `/inventory/invoices` | Supplier invoices | 15 cards | Save\*, File all\*, Not an invoice, Delete, Read them off\*, Send by email\*, Fix it, Received | yes | largest page; 17 forms |
| `/inventory/returns` | What to send back | Still inside the window | open the supplier | yes | read-only |
| `/nadac` | NADAC | Fetch automatically; Weeks missing; What CMS calls these; Earlier weeks; Load from address; Load by hand; Against our claims; Weeks loaded | Save, Fetch now, Fetch this week, Read the listing, Load | yes | 7 buttons none btn; 8 raw h2; not in nav |
| `/expenses` | Spending | Bills | Monthly P&L\*, Record it\*, Add, Confirm | yes | no edit/delete |
| `/remits/mtf` | Medicare MFP refunds | 8 sections | Find it, Save and check, Test, Download, Read and post | yes | 5 non-btn; 8 raw h2 |
| `/inbox` | Inbox | list | Email settings, Check now\*, File it\*, Read again, Clear | yes (2) | 2 non-btn |
| `/intake`, `/intake/[id]` | Add documents | Waiting for you; Where does it belong; What is on it | Read and sort\*, Check and file, Try again\*, Leave it, Delete!, File it\* | yes | no inbound link; error-only |
| `/reports` | Report check | What to ask for; Field by field; Send this back; Unused columns | Check it | yes | error-only; only from /tools |
| `/settings` | Settings | Pharmacy; Identifiers; PSO; Logo; Claude; Logins; Network; Backups; Elsewhere | Save\*, Remove it, Test, Remove key!, Save and test\*, Create login\* | no | 9 raw h2; 2 unwrapped tables; 3,200 px |
| `/settings/backups` | Backups | OneDrive; Archives held; Key; What is in a backup | Use as\*, Save (bg-ink), Back up now, Prove restore | yes | no per-archive action |
| `/settings/connections` | Connections | How these are protected | Save (bg-ink), Remove key (bare link) | no | |
| `/settings/email` | Email | Before you start; Mailbox; Status; Sending; What happens | Save and test\*, Test reading, Check now\*, Remove password!, Send it\* | no | 7 forms |
| `/settings/features` | Extra sections | Reimbursement and purchasing | toggle (non-btn) | no | gates 11 pages |
| `/settings/network`, `/settings/training`, `/settings/updates` | | | Save (bg-ink); Check, Install\* | no | updates: error-only |
| `/staff` | Staff & licenses | board | Rotations, C-900, Add\*, Make inactive, Reactivate\*, Hide/Show | yes | |
| `/staff/[id]` | person | Edit; Required credentials; Other; Training; Documents; Employment | Send training, Protocol\*, Edit, Renew, Add\*, Ask again, Seen it, Delete (bare link), Reactivate\* | no | `?saved=` |
| `/staff/rotations` | Rotations | What a student needs; groups | Add a student\*, Add someone, send it | yes | no edit/delete |
| `/staff/new-hire`, `/pack` | New employee | Started recently; Add the person; groups; Contents | Print pack, Open, Full record, Send all\*, Rebuild | no | pack: raw h1, no feedback |
| `/staff/technician-list` | (none) | 3 tables | Today\* | no | no header; tables unwrapped |
| `/licenses` | Licences | The two that close the pharmacy; Everything with an expiry | Save\*, Delete (bare), Add\*, Documents | yes | 1 table unwrapped |
| `/agreements` | Agreements | The register; Add/Edit | Documents, Edit, Cancel, Delete! | yes | full CRUD, the model |
| `/documents`, `/documents/manual` | Pharmacy documents | Protocols; All other; Upload; manual | Licences, Forms, Manual; I have put version\* | no | 3 raw h2; manual: no header |
| `/forms`, `/forms/*` | Forms | cards; six printable forms | Manual, Inspection pack\*, Open\* | no | forms: no header, 2 unwrapped tables |
| `/compliance` | Compliance | You are clean; Does this apply | Full register, Send, Record, Yes\*, Not us | no | 3 bg-ink; no Card; no subtitle |
| `/compliance/register`, `/attestations` | register | table | What I have signed, Back; Everything\* | no | attestations: no header |
| `/compliance/training` and children | Training | Who needs what; Waiting; Sent; Another way; Email counts; Completed; course; handout; material; records | Print, Chase all, Send\*, Record, File, Sign\*, Hand it over | yes | records: 3 unwrapped tables, no header |
| `/cqi` and children | CQI | Current summary; Carried forward; Needs you; On file; Upload; import; incidents; summaries | Import\*, Log incident\*, Open\*, Print, Upload\*, Read with Claude\*, Create\*, Discard!, Delete!, Prepare\*, Finalize\*, Reopen | yes | 5 raw h2; error-only on new/import; ConfirmButton unstyled |
| `/inventory` and children | Controlled substance inventories | On file; Record; discrepancies; POA; pharmacist log | Print C-250\*, Delete!, Save (bg-ink), Close, Fill it in\*, Record\* | yes | discrepancies and POA: no edit/delete; log: no header |
| `/deliveries` | Deliveries | Driver and rate; Check it; state; Invoices | Save\*, Done, Show, Raise and send\*, Stop tracking, Send the test, clear | yes (2) | 9 forms, 2 with feedback; no delete |
| `/invoices`, `/records`, `/inspection`, `/manual` | hubs | | | | only `/records` and `/settings` use `Hub` |
| `/inspection/walk` | Self-inspection | Found; Previous; sections; Finish | Start\*, Print, Put right\*, In order, Finding!, Not us, Finish\* | yes | good Card discipline |
| `/manual`, `/manual/decisions` | P&P manual | Bring it in; What the audit reads; Find; Contents; Pick a chapter; Replace; Generated sections | about 35 actions | yes | 12 Cards, 17 submit buttons: split it |
| `/temps` and children | Temperatures | Connect; Months not signed; Needs explanation; Latest; Months; Setup; readings; review | Pull\*, Print, Connect\*, Save\*, Disconnect!, Sign off (bg-ink) | yes | 6 Cards; good |
| `/audit` | Audit log | table | none | no | read-only by design |
| `/find` | Find anything | result cards | Find\*, Clear | yes | sidebar only |
| `/tools` | Tools | list | none | no | flag only; no inbound link |

## 8. Which pages exist, and whether each should

The owner's question on 7 September: *is this page needed? Should it be combined with another,
or split? The pages seem random, sometimes unnecessary.* The test applied to every page below:
what does somebody open it **to do**, and is there already a page they open to do that? A page
passes by having a job no other page has. A page that only chooses between two pages, or shows
one side of something another page shows the other side of, fails, and either goes or joins.

Two mechanisms carry the verdicts out. A **family** (`src/lib/families.ts`) is a set of pages
that are one thing seen from several sides; the sidebar lists it once, by the page opened first,
and every page in it carries the same row of tabs under its title (`PageHeader tabs`). The
breadcrumb and the sidebar highlight follow the family (`itemFor` in `nav.ts`). A **redirect**
retires a page whose address is still linked.

### 8.1 The verdicts

| Page | Verdict | Why |
|---|---|---|
| Today `/` | keep | The only page that ranks everything due across sections. |
| The books `/money` | keep, heads the **money** family | The period on both bases with every figure linked to its rows. |
| Statement `/money/monthly` | join the money family | The same account laid out to print or file; one tab, not one sidebar line. |
| Reports `/money/report` | join the money family as "Over time" | The same account month by month. The fold of its engine into `loadShared` is still open (HANDOFF). |
| Money found `/money/found` | keep | The ranked list of what to chase; Today shows the top of it, this is the whole of it. |
| Spending `/expenses` | keep | Bills, standing costs, vendors, filing rules: nowhere else. |
| Driver invoices `/deliveries` | keep | A count a day and an invoice a month; its own feed. |
| Who pays best `/payers/performance` | keep, **moved to Claims** | It ranks payers; it was under Money because it prints dollars. |
| What to buy `/purchasing` | keep, heads the **order** family; **rebuilt** | The secondaries only. One card per wholesaler, one ranked table: what is short and cheapest there, then every generic that qualifies to add, soonest needed first, with a running total down the list and the line where the minimum is reached marked. The primary is one line. Price-file upload and the scheduled-catalogue panel fold under a `<details>`. |
| The shelf `/purchasing/shelf` | join the order family | The stock behind today's order; the same question from the shelf's side. |
| Order minimums `/purchasing/minimums` | **folded into What to buy**, redirects | It decided a basket the pharmacist had not put in a cart; a ranked list with a running total does what it was for. |
| Is everything arriving? `/settings/feeds` | **new** | Every feed and outside service: cadence, last arrival, state from the data, a proof of completeness, a live check on request. The answer to "how do I know it is all working". |
| Bought over NADAC `/purchasing/over-nadac` | **new**, join the order family | The weekly list for the buying group: every NDC invoiced above NADAC after the rebate, the gap in dollars, where it is cheaper, and what the gap cost on fills paying NADAC by law. Downloads as the file. |
| Which NDC pays `/purchasing/products` | **new**, join the order family | Leads with the per-drug answer: how each drug is paid (NADAC + fee, AWP − discount, MAC, flat), and therefore which NDC to buy and from where to earn the most on this pharmacy's fills. Then the comparison cards that used to sit under today's order: buy these instead, what each drug earns, dispensed at a loss. |
| Which contract `/purchasing/replay` | keep | A renewal decision made once a year; nothing daily belongs beside it. |
| Suppliers and rebates `/suppliers` | keep | The counterparties, their ladders, the ratio. |
| Supplier invoices `/inventory/invoices` | keep | The records the C2 separation is for, and the cash side's cost of goods. |
| What to send back `/inventory/returns` | keep | Deadlines that expire; a list somebody works through. |
| Supplies `/purchasing/supplies` | keep | A separate feed with its own counts. |
| Invoices `/invoices` | **retired**, redirects to supplier invoices | Two links and a figure each, both links already in the sidebar. |
| Claims `/claims` | keep | Every dispensing, what it made, what is owed. |
| Kansas floor `/claims/floor` | keep, heads the **floor** family | Claims paid under NADAC plus the fee. |
| Plans `/plans` | join the floor family as "Which plans it reaches" | The register that decides what the floor reaches; it exists for the floor and nothing else. |
| Appeals `/claims/appeals` | join the floor family as "Appeals filed" | What was filed on the floor and on MAC; the same law, the next step. |
| Payers `/payers` | keep, heads the **payers** family | Every BIN, and the unnamed ones. |
| Contracts `/payers/contracts` | keep in the sidebar, in the payers family | The reading of the agreements; a starting point in its own right. |
| Sort the folder `/payers/sort` | join the payers family | The step before reading; never opened except from the contracts. |
| 835 routing `/payers/routing` | join the payers family | Per payer, from the contracts; one side of the payer file. |
| Facilitator payments `/remits/mtf` | keep, **moved to Claims** | A section of one page is a page in the wrong place. The Remits group is gone until a second remittance feed exists. |
| Compliance `/compliance` and `/compliance/register` | keep both | The register is the landing; the grid by period is a view reached from it. |
| Licences, P&P manual, CQI, Temperatures | keep | Each its own record with its own cadence. |
| Inspection `/inspection` | keep, heads the **inspection** family | By inspector, what each would ask. |
| Walk the pharmacy `/inspection/walk` | join the inspection family | The self-inspection is the same readiness, walked. |
| Records `/records` | keep | The one index of what can be produced on request; now links the two invoice pages directly. |
| Documents `/documents`, Forms `/forms`, Agreements `/agreements`, Attestations | keep, reached from Records | Each holds records of its own; none is a starting point, so none is in the menu. |
| Staff, New employee, Technician list, Students on rotation | keep | Each a different set of people or a different form. |
| Training `/compliance/training` | keep, heads the **training** family | Send it, chase it. |
| Training file `/compliance/training/records` | join the training family | The same training as the inspector sees it. (A print document: the tabs are on its siblings, its own header is the back link.) |
| Training material `/compliance/training/material` | join the training family | What is sent. |
| Inventories, Discrepancies, Daily log, Power of attorney | keep | Four distinct records the law names separately. |
| Inbox `/inbox` | keep, heads the **arrivals** family as "What arrived" | Reports by email. |
| Add documents `/intake` | join the arrivals family as "By hand" | The same intake, dropped in rather than emailed. |
| NADAC, Report check, Activity log | keep | Reference data and the log. |
| Find anything `/find` | keep, **out of the sidebar** | The search box above the menu is the way in; a menu line for it was a second door to the same room. |
| Tools `/tools` | keep, the hand-typed status board dropped | The section landing, like `/compliance` and `/staff`. Its second half was nine cards with a typed "ready / waiting / needs work" that was wrong within a month of being written; the pages say what they wait on, in figures. |
| Settings and its eight pages | keep | Each a different connection or fact; eight is the ceiling and it is at it. |

**Revised again, 7 September, on the owner's verdict ("this site has too many tools; I don't
understand anything"): six groups.** Today; Buying (`/purchasing`: what the primary's order would
get wrong and what to add to each secondary, with Which NDC pays and Bought over NADAC as its
tabs; Suppliers and rebates; Supplier invoices); Getting paid (Claims, Kansas floor, Payers and
contracts); Money (The books, Spending); Compliance (the pharmacy session's pages under one entry:
Register, Licences, Staff, Training, Controlled substances, Inspection, P&P manual, Records);
Settings (Pharmacy details, Connections, Email, What arrived). Every other page is `hidden` in
`nav.ts`: still in its group for the highlight and the breadcrumb, on the group's hub, and in the
sidebar under a folded "more" line that opens when you are on one of them. Tools is gone as a
section (`/tools` redirects to Settings); People and Controlled substances are under Compliance.
The rule in `nav.ts` is now six groups and eight *listed* pages each, the list being what
somebody opens on a normal day.

Nine groups, none over seven items, twelve fewer lines in the sidebar than on 6 September. Still
open, for the page-by-page pass to settle when it reaches them: the `/documents` upload form and
`/intake` do the same job for a pharmacy document (one should call the other); `/compliance`
and `/compliance/attestations` both show duties confirmed; `/manual` at 1,900 lines is three pages
wearing one address (read, edit, decisions).
