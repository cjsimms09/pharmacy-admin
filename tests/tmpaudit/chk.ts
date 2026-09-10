import { totals, rank, type MoneyRow } from "../../src/lib/money-found";
import { lineAddsUp } from "../../src/lib/invoice-lines";
import { pace } from "../../src/lib/ledger";
import { paidCents } from "../../src/lib/standing-math";

const row = (o: Partial<MoneyRow>): MoneyRow => ({ key: "k", says: "", todo: "", amountCents: 0, cadence: "one_off", confidence: "certain", basis: "", href: "", ...o } as MoneyRow);

console.log("A. overlap when the overlapping row is the SMALLER one:");
console.log(totals([
  row({ key: "loss", amountCents: 20_000, cadence: "recurring_monthly", overlapsWith: ["switch"] }),
  row({ key: "switch", amountCents: 30_000, cadence: "recurring_monthly" }),
]));
console.log("   (expected recurringMonthlyCents 30000 if overlap respected)");

console.log("B. lineAddsUp tolerance grows with quantity:");
console.log("  qty 5   @ 30418, ext 152089 ->", lineAddsUp(5, 30418, 152089));
console.log("  model-path exact test        ->", Math.round(5*30418) === 152089);
console.log("  qty 2400 @ 5, true ext 12000, misread 12400 ->", lineAddsUp(2400, 5, 12400), "tolerance cents:", Math.max(1, Math.ceil(2400/2)));

console.log("C. paidCents with paidDay 0 / negative:");
console.log("  paidDay 0, month 2026-09, today 2026-08-01 ->", paidCents(3000000, 0, "2026-09", "2026-08-01"));

console.log("D. pace scaling:");
console.log(pace({ month: "2026-09", netRevenueCents: 100000, grossProfitCents: 20000, operatingCents: 5000 }, 26));
console.log(pace({ month: "2026-09", netRevenueCents: 100000, grossProfitCents: 20000, operatingCents: 5000 }, 30));
