# The recogniser answers without a sender, and the drop path never asks it

*Helper B (cloud, Session 2's helper), 8 September 2026. On `feature/compliance` at `103bc90`.
Reproduced by running the recogniser, not by reading it.*

The inbox recogniser (BACKLOG item 5, merged in PR #11) is reached from one place: `/inbox`, for
lines that arrived by email and were not placed. A file the owner **drops on `/intake`** never
consults it. The seam for that already exists and is one line away from being used, so this is a
wiring note rather than a design one — and the file it belongs in is 1's, so I have not made it.

## What the recogniser can do with no sender at all

Every field on `Evidence` is optional, and the strongest band — content, at `CERTAIN_AT` — needs
nothing but the bytes. Run against evidence carrying no address, no name and no subject:

| Evidence | Answer | How sure | Score |
| --- | --- | --- | ---: |
| `content: pioneer_catalog` | a supplier's catalogue | **certain** | 80 |
| `content: supplier:invoice` | a supplier invoice | **certain** | 80 |
| `content: claims` + `claims_export_20260908.csv` | a claims export | **certain** | 85 |
| `IPC_invoice_0908.pdf`, no readable content | a supplier invoice | possible | 25 |
| `scan0012.pdf`, no readable content | *no guess* | — | — |

The last two are the design working: a file name alone is suggestive and never sufficient, and a
scan with no text layer answers nothing rather than guessing. **The first three are the point.** A
dropped file has no sender and no subject, and it does not need them.

## What the drop path does instead

`readIntoIntake` in `src/app/(app)/intake/actions.ts`, in order: the balance-on-hand hint (new
today); `importDropped` from `mailbox.ts`; the 835 reader; then, if none of those fired —

```ts
if (!(await hasApiKey())) {
  … "This is not a report the site recognises, and there is no API key set for Claude to read it."
}
const doc = await readBusinessDocument(…);   // a Claude call
… const result = await classifyDocument(…);  // and a second one
```

So a dropped file that the cheap routers miss costs **up to two Claude calls**, against a monthly
ceiling that has already stopped work once this week — HANDOFF, 8 September: *"the site's own
monthly Claude ceiling (Settings → Claude, default $50 when blank) is what stopped the contract
read"*. And where there is no key, the owner is told the site does not recognise it and is offered
**no guess and no control to say what it is** — which is the half of item 5 the brief says must
never be missing: *"A guess that cannot be overridden is worse than no guess."*

Meanwhile `contentVerdict()` — `classify()`, then the supplier-document sorter and contract triage
over extracted PDF text — is free, deterministic and already written.

## The seam is already there

I had expected to have to build one. `intake-recognise-store.ts` already exports:

```ts
export async function recogniseBytes(input: {
  fileName: string; buf: Buffer;
  fromAddress?: string | null; fromName?: string | null; subject?: string | null;
  rules?: StoredRule[];
}): Promise<Recognition>
```

Its only caller is `recogniseStored()`, and that one's only caller is the inbox page. Nothing else
in the site calls it. `readIntoIntake` has the bytes and the file name in hand, so the call is

```ts
const r = await recogniseBytes({ fileName: file.fileName, buf: bytes });
```

**Where it goes: after the cheap routers, before the API-key check** — so the free answer is taken
before the paid one is attempted, and so a missing key stops being the end of the road. What to do
with the answer is 1's to decide; the two that seem plain are to place a `certain` guess the way
the inbox places one, and to put the guess and the "tell it what this is" control on the intake
review screen in place of a bare failure.

## Why it matters to a decision being made right now

The comment added to that file today reads: *"Every other kind falls through to the recogniser
below, which is B's and is generally right… Wiring the rest is worth doing only where a named kind
would actually beat the guess."*

That is fair reasoning, but the guess it is weighed against is `importDropped`'s, not the ranked
recogniser's — those are two different things of mine, and only the first one is below that
comment. The bar for "would a named kind beat the guess" is materially higher once the recogniser
is in the path, and several of the hint kinds 1 is deciding whether to wire may turn out not to be
worth wiring at all.

## What I have not done

`src/app/(app)/intake/actions.ts` is 1's and was edited by 1 today; I have not touched it. Nothing
in the recogniser or its store needs to change for this — the entry point exists, is tested, and
takes exactly the arguments a dropped file can supply.

One thing I cannot see: **how often this path is actually reached.** A query for it is under "Open
items". If almost every dropped file is caught by `importDropped` or the 835 reader, this is worth
little; if the Claude calls are running often, it is worth the one line.
