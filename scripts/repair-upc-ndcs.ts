/**
 * Puts the right drug against the front-end lines already on file.
 *
 * The reader now knows that McKesson's 6-5 column is a UPC and not an NDC — see `ndcFromUpc` — but
 * the lines read before it knew still carry what it used to produce: eleven digits that are not any
 * drug. $1,040.83 of purchases against nothing, and every cost-per-unit and margin computed from
 * those lines was computed against a product that does not exist.
 *
 * Only where the answer is not a judgement call: the stored code is not a drug, the UPC rule gives
 * exactly one real drug, and that is what it becomes. Where the rule gives two, or none — a pen
 * needle, a Dexcom sensor, an Omnipod, which have no NDC at all and are most of them — the line is
 * left exactly as it is. 8 of the 36 resolve; the other 28 are correct already.
 *
 * Every change is written to the audit trail with both codes on it, so it can be seen and undone.
 *
 * Run once: `tsx scripts/repair-upc-ndcs.ts`. Running it again does nothing, because after the
 * first pass no line matches the condition.
 */
import "dotenv/config";
import { db, schema } from "../src/db";
import { eq } from "drizzle-orm";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { ndcFromUpc } = await import("../src/lib/invoice-lines");
  const { knownNdcs } = await import("../src/lib/drug-directory-store");
  const { audit } = await import("../src/lib/audit");
  const known = await knownNdcs();

  const lines = await db
    .select({
      id: schema.invoiceLines.id,
      invoiceId: schema.invoiceLines.invoiceId,
      ndc11: schema.invoiceLines.ndc11,
      supplier: schema.invoiceLines.supplier,
      description: schema.invoiceLines.description,
      extendedCents: schema.invoiceLines.extendedCents,
    })
    .from(schema.invoiceLines);

  const directory = new Map(
    (await db.select({ n: schema.drugDirectory.ndc11, b: schema.drugDirectory.brandName, g: schema.drugDirectory.genericName }).from(schema.drugDirectory)).map((r) => [
      r.n,
      r.b ?? r.g,
    ]),
  );

  let changed = 0;
  let leftAlone = 0;
  let cents = 0;
  for (const l of lines) {
    if (known(l.ndc11)) continue;
    const resolved = ndcFromUpc(l.ndc11, known);
    if (!resolved || resolved === l.ndc11) {
      leftAlone++;
      continue;
    }
    changed++;
    cents += l.extendedCents;
    console.log(
      `${l.ndc11} → ${resolved}  [${l.supplier}] ${String(l.description ?? "").slice(0, 32).padEnd(32)} → ${String(directory.get(resolved) ?? "").slice(0, 40)}`,
    );
    if (dryRun) continue;
    await db.update(schema.invoiceLines).set({ ndc11: resolved }).where(eq(schema.invoiceLines.id, l.id));
    await audit({
      action: "invoice.line.ndc_repaired",
      userId: "system",
      userName: "the UPC repair",
      entity: "invoice",
      entityId: l.invoiceId,
      details:
        `${l.description ?? "a front-end line"} on ${l.supplier ?? "an invoice"}: ${l.ndc11} was not a drug and was read off a UPC. ` +
        `It is ${resolved}, ${directory.get(resolved) ?? "a drug the FDA lists"}.`,
    });
  }

  console.log(
    `\n${changed} line${changed === 1 ? "" : "s"} put against the right drug (${(cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} of purchases); ` +
      `${leftAlone} left as they are, having no NDC to resolve to.${dryRun ? " Nothing was written — this was a dry run." : ""}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
