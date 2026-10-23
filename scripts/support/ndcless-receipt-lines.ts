import "dotenv/config";
/**
 * What the delivery lines with no usable drug code actually are.
 *
 * Session 1's 14 September measurement of the uninvoiced deliveries: 554 item lines across 62
 * receipts, 548 of them with an eleven-digit NDC and a cost. The other six have never been looked
 * at, and both of the obvious answers lead somewhere different:
 *
 *   a front-end item with a twelve-digit UPC-A  →  recoverable, and `ndcFromUpc` is most of the way
 *                                                  there already
 *   a device, a fee, a delivery charge          →  correctly has no NDC, and must be counted as
 *                                                  "not a drug" rather than as a drug the site
 *                                                  failed to price
 *
 * Nothing should be built for them until somebody has seen them, which is what this is for. It
 * decides nothing and writes nothing.
 *
 *   npx tsx --tsconfig tsconfig.script.json scripts/support/ndcless-receipt-lines.ts
 *
 * Prints the code, its length, the description and what each recovery attempt makes of it. Product
 * descriptions and wholesaler codes only — an invoice names drugs and a supplier, never a person.
 */
import { db, schema } from "../../src/db";
import { ndc11, ndcFromUpc } from "../../src/lib/invoice-lines";

type Line = { ndc11?: unknown; description?: unknown; quantity?: unknown; unitCostCents?: unknown; extendedCents?: unknown; packSize?: unknown };

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const rows = await db
    .select({
      id: schema.pioneerPurchases.id,
      supplier: schema.pioneerPurchases.supplier,
      invoiceNumber: schema.pioneerPurchases.invoiceNumber,
      invoiceDate: schema.pioneerPurchases.invoiceDate,
      itemsJson: schema.pioneerPurchases.itemsJson,
    })
    .from(schema.pioneerPurchases);

  /*
   * Every NDC the site holds, so `ndcFromUpc` has something to check a candidate against. Without
   * it the function returns the digits unchanged rather than guessing, which is right and tells us
   * nothing — the whole question here is whether a real drug is hiding behind the code.
   */
  const held = new Set<string>();
  for (const r of await db.select({ ndc11: schema.drugDirectory.ndc11 }).from(schema.drugDirectory)) {
    if (r.ndc11) held.add(r.ndc11);
  }
  for (const r of await db.select({ ndc11: schema.supplierItems.ndc11 }).from(schema.supplierItems)) {
    if (r.ndc11) held.add(r.ndc11);
  }
  const known = (n: string) => held.has(n);
  console.log(`${held.size.toLocaleString()} distinct NDCs on file to check a candidate against.`);

  let lines = 0;
  let withNdc = 0;
  const odd: string[] = [];

  for (const r of rows) {
    const raw = (r.itemsJson ?? "").trim();
    if (!raw) continue;
    let parsed: Line[] = [];
    try {
      const j = JSON.parse(raw) as unknown;
      parsed = Array.isArray(j) ? (j as Line[]) : [];
    } catch {
      odd.push(`${r.supplier ?? "?"} ${r.invoiceNumber ?? "?"}: itemsJson is not readable JSON.`);
      continue;
    }
    for (const l of parsed) {
      lines++;
      const code = typeof l.ndc11 === "string" ? l.ndc11 : "";
      const digits = code.replace(/\D/g, "");
      if (digits.length === 11 && ndc11(code)) {
        withNdc++;
        continue;
      }
      /*
       * Everything the site could try, so the report says which recovery would work rather than
       * leaving somebody to test them by hand.
       */
      const asNdc = ndc11(code);
      const asUpc = digits.length === 11 ? ndcFromUpc(code, known) : null;
      // A twelve-digit UPC-A carries a check digit the NDC does not. Dropping the leading zero of a
      // UPC-A is the standard reading of a drug packed for retail.
      const twelve = digits.length === 12 ? digits.slice(0, 11) : null;
      const twelveIsKnown = twelve ? known(twelve) : false;

      odd.push(
        [
          `${r.supplier ?? "?"} ${r.invoiceNumber ?? "?"} ${r.invoiceDate ?? ""}`,
          `  code: ${JSON.stringify(code)} (${digits.length} digits)`,
          `  description: ${typeof l.description === "string" ? l.description : "(none)"}`,
          `  pack: ${typeof l.packSize === "string" ? l.packSize : "(none)"}  qty: ${String(l.quantity ?? "?")}  ` +
            `unit: ${typeof l.unitCostCents === "number" ? money(l.unitCostCents) : "?"}  ` +
            `ext: ${typeof l.extendedCents === "number" ? money(l.extendedCents) : "?"}`,
          `  ndc11(): ${asNdc ?? "null"}   ndcFromUpc(): ${asUpc ?? "n/a"}   ` +
            `12→11: ${twelve ?? "n/a"}${twelve ? (twelveIsKnown ? " (a drug the site knows)" : " (not on file)") : ""}`,
        ].join("\n"),
      );
    }
  }

  console.log(`\n${lines} item lines across ${rows.length} deliveries; ${withNdc} carry a usable NDC.`);
  console.log(`${odd.length} do not:\n`);
  for (const o of odd) console.log(o + "\n");

  if (odd.length === 0) console.log("Nothing to look at. Every line carries a drug code.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
