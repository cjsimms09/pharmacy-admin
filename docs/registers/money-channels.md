# Every way money reaches the pharmacy, and whether it is traced

*Generated 2026-09-12 18:48 by `scripts/registers.ts`. Do not edit — edit `docs/registers/decisions.md` and run it again.*

The register behind `docs/MONEY-TRACE.md`. A channel with nothing against it has either never paid or is not being read, and those are different — the second one loses money silently.

## Claim payments, by channel

| Channel | Payments | Amount | Unmatched | Last |
|---|---|---|---|---|
| plan | 9550 | $899,466.98 | 8959 | 2026-08-31 |
| mtf | 31 | $6,774.31 | 31 | 2026-09-11 |

## Cash receipts, by kind

| Kind | Receipts | Amount |
|---|---|---|
| third_party | 104 | $1,131,521.97 |
| rebate | 1 | $9,706.52 |

## Channels known to exist and not in the tables above

These are named because they are how this pharmacy is actually paid, and each is money that
arrives as something other than a deposit:

- **Aytu / IPD RxRescue top-offs** — arrive as a *credit line on the IPD statement*, never as cash.
- **McKesson returns** — arrive as *credits on account*. $8,526.77 read on 12 September.
- **Wholesaler rebates** — credit or cheque, on the generics contract.
- **Copay card processors** (DST/CNRX, DST/Argus GLP-1 bridge) — remit like a payer; $0.00 ever received to date.
- **DIR reconciliation** — usually money out, occasionally a true-up in.
- **PBM audit recoupments** — money taken back after the fact. No category names it directly;
  `DIR fees and price concessions` is arguably its home, and nobody has ruled on that.
