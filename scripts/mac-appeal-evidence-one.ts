/**
 * One acquisition-cost evidence page, for a claim not yet recorded as appealed.
 *
 * The batch script works from filed appeals; this one works from a claim, so evidence can be
 * attached at the moment of filing rather than afterwards. Same builder, same arithmetic.
 *
 * Run: tsx --tsconfig tsconfig.test.json scripts/mac-appeal-evidence-one.ts <rx> <dateFilled> <pbm> <outDir>
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FEE_CENTS = 1050;

function packUnits(desc: string | null): number | null {
  if (!desc) return null;
  const m = /^\s*([\d.]+)\s+[A-Z]/i.exec(desc);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const [rx, dos, pbm, outDir] = process.argv.slice(2);
  if (!rx || !dos || !pbm || !outDir) throw new Error("give rx, dateFilled, pbm, outDir");
  mkdirSync(outDir, { recursive: true });

  const { db } = await import("../src/db");
  const { buildEvidence } = await import("../src/lib/mac-appeal-evidence");
  const { textPdf } = await import("../src/lib/pdf");
  const { getSettings } = await import("../src/lib/settings");
  const s = await getSettings();

  const c = (await db.$client.execute({
    sql: `SELECT c.*, (SELECT dd.package_description FROM drug_directory dd WHERE dd.ndc11 = c.ndc11 LIMIT 1) AS pkg
            FROM claims c WHERE c.rx_number = ? AND c.date_filled = ? LIMIT 1`,
    args: [rx, dos],
  })).rows[0] as any;
  if (!c) throw new Error("claim not found");

  const il = (await db.$client.execute({
    sql: `SELECT il.unit_cost_cents, il.description, il.invoice_date, si.invoice_number, si.supplier
            FROM invoice_lines il JOIN supplier_invoices si ON si.id = il.invoice_id
           WHERE il.ndc11 = ? AND il.unit_cost_cents > 0
        ORDER BY ABS(julianday(il.invoice_date) - julianday(?)) ASC LIMIT 1`,
    args: [c.ndc11, dos],
  })).rows[0] as any;
  if (!il) throw new Error("no invoice line for that NDC");

  const units = packUnits(c.pkg);
  if (units === null) throw new Error("no pack size in the FDA directory for " + c.ndc11);

  const built = buildEvidence({
    pharmacy: {
      name: s.pharmacy_name || "",
      ncpdp: s.pharmacy_ncpdp || "",
      npi: s.pharmacy_npi || "",
      address: [s.pharmacy_address, s.pharmacy_city, s.pharmacy_state, s.pharmacy_zip].filter(Boolean).join(", "),
      phone: s.pharmacy_phone || "",
      email: s.pharmacy_email || "",
    },
    appealRef: null,
    pbmName: pbm,
    claim: {
      rxNumber: String(c.rx_number),
      dateFilled: c.date_filled,
      ndc11: c.ndc11,
      drugName: c.item_name,
      quantity: Number(c.quantity_thousandths) / 1000,
      unitLabel: /\bML\b|MILLILITER/i.test(String(c.pkg)) ? "Milliliter" : "Each",
      planPaidCents: Number(c.remit_cents),
      copayCents: Number(c.copay_cents ?? 0),
    },
    invoice: {
      supplier: il.supplier,
      number: String(il.invoice_number),
      date: il.invoice_date,
      description: il.description,
      packPriceCents: Number(il.unit_cost_cents),
      packUnits: units,
      packSource: "FDA NDC directory",
    },
    dispensingFeeCents: FEE_CENTS,
  });

  const path = join(outDir, built.fileName);
  writeFileSync(path, textPdf("Acquisition Cost Evidence", built.lines));
  console.log(path);
  console.log("shortfall $" + (built.shortfallCents / 100).toFixed(2));
}

main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
