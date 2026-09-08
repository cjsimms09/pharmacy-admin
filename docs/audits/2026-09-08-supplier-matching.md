# Audit — the two supplier matchers, and why adopting the wrong one would look like a fix

*Helper B, 8 September 2026. Not a branch audit: this came out of reading Helper A's
`docs/audits/2026-09-08-shelf.md` on `work/audit-shelf` beside session 2's `work/invoices`, which
landed the same day. Neither audit is wrong. The problem is only visible with both open.*

**Addressed to Helper A and session 1**, because A's finding 1 proposes the change this affects.

## The two matchers disagree, on purpose, in opposite directions

The site has two functions that turn a wholesaler's printed name into a register row, and they were
written to opposite rules by two sessions on the same day:

| | `rateForSupplier` (`supplier-match.ts`) | `supplierRecordFor` (`suppliers-registry.ts`) |
| --- | --- | --- |
| Rule | **containment**, longest wins, keys under 4 characters skipped | **equality only** — register name, catalogue name, typed aliases, then canonical spellings |
| Used by | `drug-catalog.ts`, `product-ledger.ts` | `suppliers.ts`, `invoices.ts`, `rebate-rates.ts` |
| Written because | an exact lookup misses "MCKESSON CONNECT" against "McKesson" | containment put eight invoice lines and $78.50 outside every rebate figure, silently, and would put a line printed "IP" on whichever of IPC and IPD the register listed first |

Session 2's commit `e78a7d0` is explicit that containment is unsafe in both directions and replaced
it with equality plus aliases the pharmacy types. Helper A's finding 1 recommends that `shelf.ts`
adopt the containment one. Both are reasonable from where they were standing. Together they mean
the site would have **three** modules on equality and **three** on containment, for the same
question.

## The part that matters: adopting `rateForSupplier` fixes McKesson and not IPC or IPD

Run against a rate table keyed the way the register keys it (`SHORTEST_MATCH` is 4):

```
rateForSupplier({ ipc: 0.04, ipd: 0.03, mckesson: 0.02 }, "MCKESSON CONNECT")        -> 0.02   ✓
rateForSupplier({ ipc: 0.04, ipd: 0.03, mckesson: 0.02 }, "Independent Pharmacy Cooperative") -> null   ✗
rateForSupplier({ ipc: 0.04, ipd: 0.03, mckesson: 0.02 }, "IPC Rx")                  -> null   ✗
rateForSupplier({ ipc: 0.04, ipd: 0.03 },                 "IP")                      -> null   ✓ (guard holds)
rateForSupplier({ smith: 0.01, "smith drug co": 0.05 },   "Smith Drug Company")      -> 0.05   ✓ (longest wins)
```

**The four-character guard is what does it.** A registered name shorter than four characters can
never match by containment — the loop skips it as a key — so only exact equality can reach it. IPC
and IPD are three characters each, and they are the pharmacy's actual secondaries: the suppliers the
buy list exists to recommend.

So the failure has a shape worth naming. A's finding 1 is right that the buy list prices contract
lines gross and pushes the order back to the primary. But adopting `rateForSupplier` would:

- **fix McKesson**, whose registered name is long enough to match by containment — the case in the
  audit, and the one anybody would test with;
- **leave IPC and IPD exactly as they are**, still priced gross whenever a catalogue or invoice
  spells them out, because no containment match is even attempted for a three-letter key.

That is worse than not fixing it, because it looks fixed. The obvious check after the change —
"McKesson's rate is applied now" — passes, and the two suppliers the module exists to compare
against the primary go on being compared at their printed prices with nothing on any screen saying
so. It is the same silent-gap failure session 2 spent a branch removing, surviving in the module A
is recommending.

## What I would do instead, and why it is not mine to do

**One matcher, and it should be `supplierRecordFor`'s rule, not `rateForSupplier`'s.** Session 2 has
already built what containment was standing in for: an `aliases` column on the register where the
pharmacy types the spellings a supplier's own paperwork uses, matched by equality. "MCKESSON CONNECT"
is an alias. "Independent Pharmacy Cooperative" is an alias. Neither needs a substring test, and
equality cannot put a line on the wrong ladder.

Concretely: `rateForSupplier` keeps its signature and resolves the supplier through the register
(name, catalogue name, aliases, canonical) instead of iterating rate keys — so `drug-catalog.ts`,
`product-ledger.ts` and `shelf.ts` all get the same answer as the invoice and rebate side, and there
is one definition of "which wholesaler is this" in the site, which is what `shelf.ts`'s own header
asks for.

`supplier-match.ts` and `shelf.ts` are session 1's, and this is a behaviour change to a rate that
decides purchasing, so it is not a patch from here. It is also A's finding to carry, not mine — I
am only adding the half that is invisible from inside either audit.

**One caveat on my own recommendation.** It only works if the aliases are actually typed. Today they
exist for IPC because session 1 typed them from two invoices; every other supplier's `aliases` is
empty, so switching to equality-only *without* filling them in would turn "MCKESSON CONNECT" from a
working containment match into a null. The order is: fill the aliases, then switch. Which is
`unplacedNames` from finding 2 of `2026-09-08-invoices.md` — the list nothing currently renders is
also the worklist for this.

## Queries to size it, for session 1

```sql
-- Registered names shorter than four characters: the ones containment can never reach.
select id, name, catalog_name, aliases from suppliers where length(trim(name)) < 4;

-- Every spelling a price file actually uses, against the register.
select distinct lower(trim(supplier)) from supplier_items order by 1;

-- How many suppliers have no alias typed yet, which is the precondition for the switch.
select count(*) from suppliers where coalesce(trim(aliases), '') = '';
```
