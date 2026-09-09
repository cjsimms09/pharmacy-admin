import "dotenv/config";
/**
 * What each payer owes on September's claims, what has arrived, and what is still out.
 *
 * The owner: "it should be easy to know how much a payer owes us for a claim." It is one
 * subtraction, and this is it — per payer, so a plan that has stopped paying shows up as a row and
 * not as a feeling.
 */
import { db, schema } from "../../src/db";
import { and, gte, lte, eq } from "drizzle-orm";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const claims = await db
    .select()
    .from(schema.claims)
    .where(and(gte(schema.claims.dateFilled, "2026-09-01"), lte(schema.claims.dateFilled, "2026-09-30"), eq(schema.claims.status, "paid")));
  const payments = await db.select().from(schema.claimPayments);
  const paidByClaim = new Map<string, number>();
  for (const p of payments) {
    if (!p.claimId) continue;
    paidByClaim.set(p.claimId, (paidByClaim.get(p.claimId) ?? 0) + p.amountCents);
  }
  const cash = await db.query.cashPlans.findMany({ columns: { bin: true, pcn: true, name: true } });
  const { cashPlanFor } = await import("../../src/lib/cash-plans");

  type Row = { owed: number; got: number; claims: number; copay: number };
  const byPayer = new Map<string, Row>();
  for (const c of claims) {
    const plan = cashPlanFor(c.bin, c.pcn, cash);
    const name = plan ? `${plan.name} — cash, owes nothing` : c.pbmName ?? c.payerLabel ?? `BIN ${c.bin ?? "?"}`;
    const e = byPayer.get(name) ?? { owed: 0, got: 0, claims: 0, copay: 0 };
    byPayer.set(name, {
      owed: e.owed + (c.remitCents ?? 0),
      got: e.got + (paidByClaim.get(c.id) ?? 0),
      claims: e.claims + 1,
      copay: e.copay + (c.copayCents ?? 0),
    });
  }

  const rows = [...byPayer].sort((a, b) => b[1].owed - a[1].owed);
  console.log("payer".padEnd(42) + "claims".padStart(7) + "owes".padStart(14) + "paid".padStart(14) + "still out".padStart(14));
  let owed = 0, got = 0, copay = 0, n = 0;
  for (const [name, e] of rows) {
    owed += e.owed; got += e.got; copay += e.copay; n += e.claims;
    if (e.owed === 0 && e.got === 0) continue;
    console.log(name.slice(0, 41).padEnd(42) + String(e.claims).padStart(7) + money(e.owed).padStart(14) + money(e.got).padStart(14) + money(e.owed - e.got).padStart(14));
  }
  console.log("".padEnd(42, "-") + "-".repeat(49));
  console.log("all payers".padEnd(42) + String(n).padStart(7) + money(owed).padStart(14) + money(got).padStart(14) + money(owed - got).padStart(14));
  console.log(`\npatients paid ${money(copay)} at the register on top of that.`);
  console.log(`September revenue = ${money(owed)} owed by payers + ${money(copay)} from patients = ${money(owed + copay)}`);
}
main().then(() => process.exit(0));
