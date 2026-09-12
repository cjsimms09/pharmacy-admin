# The buy list's controlled-substance test asks a name list, with two better answers already on file

*12 September 2026 — session 2 (cloud). `src/lib/minimum-store.ts:30-46` read against
`src/lib/invoice-lines.ts`, `src/lib/invoices.ts:120-155` and `src/lib/controlled-names.ts`. **No
file of session 1's is edited.***

## What the module says it is afraid of

`controlledNdcs` is the gate that keeps controlled substances off the page that says what to buy.
Its own docstring sets the asymmetry, and sets it correctly:

> *"Either source suffices to exclude; nothing is required to include, because the cost of a wrong
> exclusion is a generic not bought at the cheapest place and **the cost of a wrong inclusion is a
> controlled substance ordered by a page that must not**."*

It then asks two sources:

```ts
const lines = await db.query.invoiceLines.findMany({ columns: { ndc11: true, itemClass: true } });
for (const l of lines) if (l.ndc11 && l.itemClass && /^(X|B|D|E)$/i.test(l.itemClass.trim())) out.add(l.ndc11);
for (const [ndc, name] of names) if (scheduleFromNames([name]).schedule !== "none") out.add(ndc);
                                                                    // minimum-store.ts:38-45
```

## The first source fires for one supplier

`itemClass` is set by exactly one of the five readers in `invoice-lines.ts` — the McKesson branch at
`:641`, `itemClass: cls ?? null`. The other four set it to `null` outright: IPD `:600`, IPC `:695`,
IPC credit `:737`, ParMed `:766`. Even McKesson's is optional in the pattern, and its own comment
says the class letter *"prints on prescription lines and not on front-end ones"*.

Run against the fixtures:

```
McKesson   ndc=00002143611  itemClass="R"   controlled=null
IPC        ndc=65862050220  itemClass=null  controlled=null
IPD        ndc=70165002030  itemClass=null  controlled=true      <- oxycodone
IPD        ndc=54707560094  itemClass=null  controlled=false
```

So for everything not bought from McKesson on a prescription line, the first source contributes
nothing and the gate is a **name match alone**.

## The second answer is already stored, on the same rows, and is not selected

Look at the IPD line again. `itemClass` is null and **`controlled` is `true`** — the supplier's own
statement, read off the invoice's own "CII Subtotal:" and "Non-CII Subtotal:" headings
(`invoice-lines.ts:545-548`, `for (const l of pending) l.controlled = controlled;`), carried onto
every line, and written to the database:

```ts
controlled: (l as { controlled?: boolean | null }).controlled ?? null,     // invoices.ts, line insert
```

`invoice_lines.controlled` is a real column. `controlledNdcs` selects `{ ndc11: true, itemClass: true }`
and never reads it. A fact the document stated, that this codebase went to the trouble of reading and
storing, is not asked by the one gate whose stated fear is letting a controlled substance through.

## The third answer is the FDA's, per NDC, and is treated as authoritative three files away

`drug_directory.dea_schedule` holds the FDA's schedule for every NDC on file.
`scheduleFromInvoiceLines` uses it and trusts even its blanks:

> *"The directory's blank means 'not a controlled substance', and this is the one place such a null
> is a fact rather than an absence: every NDC in the directory has been looked at by the FDA, and a
> drug it lists with no schedule is uncontrolled."* — `invoices.ts:138-141`

The compliance path — which invoice goes in the Schedule II drawer — asks the FDA per NDC. The
ordering path, for the same NDCs, asks a name.

## Why a name list is the wrong tool here, in its own words

`controlled-names.ts` was written for a different job and says so. It files invoices, where the
consequences are asymmetric in a *different* direction:

> *"Missing a Schedule II is the failure that matters … The Schedule II list is therefore meant to be
> exhaustive … Missing a Schedule III to V is a much smaller thing, because 1304.04(h)(2) permits
> those to sit with ordinary business records … **So that list aims to be good rather than
> perfect.**"*

That reasoning is right for filing. It does not transfer. Reused as the buy list's gate, a list that
is deliberately "good rather than perfect" for Schedules III to V means a Schedule III to V generic
can reach the page that says it excludes controlled substances — bought from IPD, IPC or ParMed,
where no class letter exists and the stored `controlled` flag is not read.

**Stated fairly:** the Schedule II list is exhaustive by design, so the realistic gap is III to V,
and a III to V order needs no DEA 222 or CSOS. This is not "a CII in the cart". It is a controlled
substance appearing on a page whose whole premise is that it carries none, in a pharmacy where the
owner's instruction is *"I don't want to have to babysit everything"* — and the page gives him no
reason to look.

## The fix is two columns, both already populated

```ts
const lines = await db.query.invoiceLines.findMany({ columns: { ndc11: true, itemClass: true, controlled: true } });
for (const l of lines) if (l.ndc11 && (l.controlled === true || /^(X|B|D|E)$/i.test(l.itemClass?.trim() ?? ""))) out.add(l.ndc11);

const listed = await db.query.drugDirectory.findMany({ columns: { ndc11: true, deaSchedule: true } });
for (const d of listed) if (d.deaSchedule) out.add(d.ndc11);
```

Both keep the module's rule exactly — either source suffices to exclude, nothing is required to
include — and both strengthen it in the direction it says it wants. It is session 1's file, so this
is a proposal.

## For session 1

Two counts, and the second is the one that says whether anything is wrong today:

1. How many stored invoice lines have `controlled = 1` and `item_class` null? Those are NDCs the
   supplier itself called controlled and the buy-list gate cannot see.
2. Of the NDCs currently on the buy list or in `candidates`, how many have a non-blank
   `dea_schedule` in `drug_directory`? Anything above zero is a controlled substance on the page
   right now.
