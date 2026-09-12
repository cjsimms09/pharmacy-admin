/**
 * Generates the one-page acquisition-cost evidence PDF for each filed MAC appeal.
 *
 * Run: tsx --tsconfig tsconfig.test.json scripts/mac-appeal-evidence-pdfs.ts <outDir>
 *
 * Reads the appeal, its claim, and the invoice line that covers the NDC, and writes one PDF per
 * appeal. The pack size comes from the FDA NDC directory, not from the wholesaler's description:
 * dividing by the wrong number turns a $2.46 tablet into a $245.98 one.
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FEE_CENTS = 1050;

async function main() {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("give an output directory");
  mkdirSync(outDir, { recursive: true });

  const { db } = await import("../src/db");
  const { buildEvidence } = await import("../src/lib/mac-appeal-evidence");
  const { packForClaim } = await import("../src/lib/pack-size");
  const { textPdf } = await import("../src/lib/pdf");
  const { getSettings } = await import("../src/lib/settings");
  const s = await getSettings();

  const appeals = await db.$client.execute(
    `SELECT a.id, a.rx_number, a.date_filled, a.ndc11, a.pbm_name, a.packet_json,
            c.item_name, c.quantity_thousandths, c.remit_cents, c.copay_cents,
            (SELECT dd.package_description FROM drug_directory dd WHERE dd.ndc11 = a.ndc11 LIMIT 1) AS pkg,
            (SELECT dd.form FROM drug_directory dd WHERE dd.ndc11 = a.ndc11 LIMIT 1) AS form
       FROM appeals a JOIN claims c ON c.id = a.claim_id
      WHERE a.kind = 'mac_appeal' ORDER BY a.rx_number`,
  );

  for (const a of appeals.rows as any[]) {
    const inv = await db.$client.execute({
      sql: `SELECT il.unit_cost_cents, il.description, il.invoice_date, si.invoice_number, si.supplier
              FROM invoice_lines il JOIN supplier_invoices si ON si.id = il.invoice_id
             WHERE il.ndc11 = ? AND il.unit_cost_cents > 0
          ORDER BY ABS(julianday(il.invoice_date) - julianday(?)) ASC LIMIT 1`,
      args: [a.ndc11, a.date_filled],
    });
    if (!inv.rows.length) { console.log(`  ${a.rx_number}: no invoice line, skipped`); continue; }
    const il = inv.rows[0] as any;

    /*
     * The pack and its unit together, from the one function that knows. See `pack-size.ts`.
     *
     * This read the outermost count off the description and labelled it from whether the same text
     * contained "ML" anywhere — so a carton of 25 vials of 10 mL was printed as "25 Milliliter" and
     * the division beside it was shown to a PBM as proof. Skipped rather than guessed now, with the
     * reason printed, because a divisor nobody can stand behind must not reach this document.
     */
    const read = packForClaim({ packageDescription: a.pkg, form: a.form }, Number(a.quantity_thousandths));
    if (!read.ok) { console.log(`  ${a.rx_number}: no pack size, skipped — ${read.why}`); continue; }

    const qty = Number(a.quantity_thousandths) / 1000;
    const ref = (() => { try { return JSON.parse(a.packet_json)?.confirmation ?? null; } catch { return null; } })();

    const built = buildEvidence({
      pharmacy: {
        name: s.pharmacy_name || "",
        ncpdp: s.pharmacy_ncpdp || "",
        npi: s.pharmacy_npi || "",
        address: [s.pharmacy_address, s.pharmacy_city, s.pharmacy_state, s.pharmacy_zip].filter(Boolean).join(", "),
        phone: s.pharmacy_phone || "",
        email: s.pharmacy_email || "",
      },
      appealRef: ref,
      pbmName: a.pbm_name ?? "the plan",
      claim: {
        rxNumber: String(a.rx_number),
        dateFilled: a.date_filled,
        ndc11: a.ndc11,
        drugName: a.item_name,
        quantity: qty,
        planPaidCents: Number(a.remit_cents),
        copayCents: Number(a.copay_cents ?? 0),
      },
      invoice: {
        supplier: il.supplier,
        number: String(il.invoice_number),
        date: il.invoice_date,
        description: il.description,
        packPriceCents: Number(il.unit_cost_cents),
      },
      pack: read.pack,
      dispensingFeeCents: FEE_CENTS,
    });

    const path = join(outDir, built.fileName);
    writeFileSync(path, textPdf("Acquisition Cost Evidence", built.lines));
    console.log(`  ${a.rx_number}  ${ref ?? "(no ref)"}  short $${(built.shortfallCents / 100).toFixed(2)}  -> ${built.fileName}`);
  }
}

main().catch((e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
