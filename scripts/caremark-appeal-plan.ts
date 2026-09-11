/**
 * The Caremark MAC appeal worklist, pre-formatted to that portal's own rules.
 *
 * Run: tsx --tsconfig tsconfig.test.json scripts/caremark-appeal-plan.ts [limit]
 *
 * Three things the form taught us the hard way on the first filing, all applied here so the next
 * one is a single fill rather than a conversation with a validator:
 *
 *   **Rx numbers must be at least seven digits.** This pharmacy's are six, so they are zero-padded.
 *   Submitting the bare number is rejected with "The Rx Number should be a minimum of 7 digits."
 *
 *   **Comments are capped at 255 characters.** The first attempt ran to 490 and was refused. So the
 *   sentence is built to fit and checked before it is offered.
 *
 *   **The reason is framed against NADAC, not acquisition cost.** The only choices are "Reprice at
 *   NADAC" and "Reprice above NADAC" — so the NADAC in force on the fill date is the figure that
 *   matters to Caremark, and which reason to pick depends on whether NADAC actually covers cost:
 *   where it does, repricing at NADAC is enough; where NADAC itself sits below cost, asking for it
 *   would be asking to stay underwater.
 */
import "dotenv/config";

const FEE_CENTS = 1050;
const TODAY = "2026-09-11";

function packUnits(desc: string | null): number | null {
  if (!desc) return null;
  const m = /^\s*([\d.]+)\s+[A-Z]/i.exec(desc);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const money = (c: number) => "$" + (c / 100).toFixed(2);
const us = (iso: string) => iso.slice(5, 7) + "/" + iso.slice(8, 10) + "/" + iso.slice(0, 4);
const shortUs = (iso: string) => iso.slice(5, 7) + "/" + iso.slice(8, 10) + "/" + iso.slice(2, 4);

async function main() {
  const limit = Number(process.argv[2] ?? 40);
  const { db } = await import("../src/db");

  const rows = (await db.$client.execute(`
    SELECT c.id, c.rx_number, c.date_filled, c.ndc11, c.item_name, c.bin, c.pcn,
           c.quantity_thousandths, c.remit_cents, c.copay_cents, c.acquisition_cents,
           (SELECT dd.package_description FROM drug_directory dd WHERE dd.ndc11 = c.ndc11 LIMIT 1) AS pkg,
           (SELECT np.unit_micros FROM nadac_prices np
             WHERE np.ndc11 = c.ndc11 AND np.effective_on <= c.date_filled
             ORDER BY np.effective_on DESC LIMIT 1) AS nadac_micros,
           (SELECT np.classification FROM nadac_prices np
             WHERE np.ndc11 = c.ndc11 AND np.effective_on <= c.date_filled
             ORDER BY np.effective_on DESC LIMIT 1) AS cls
      FROM claims c
      JOIN claim_imports i ON i.id = c.import_id AND i.out_of_books = 0
     WHERE c.status = 'paid'
       AND c.date_filled >= '2026-09-01'
       AND lower(c.pbm_name) LIKE '%caremark%'
       AND c.remit_cents IS NOT NULL AND c.remit_cents > 0
       AND c.acquisition_cents IS NOT NULL
       AND c.quantity_thousandths > 0
       AND c.id NOT IN (SELECT claim_id FROM appeals WHERE kind = 'mac_appeal' AND claim_id IS NOT NULL)
  `)).rows as any[];

  const plan: any[] = [];
  for (const x of rows) {
    if ((x.cls ?? "") !== "G" || x.nadac_micros === null) continue;
    const qty = Number(x.quantity_thousandths) / 1000;
    const received = Number(x.remit_cents) + Number(x.copay_cents ?? 0);
    const cost = Number(x.acquisition_cents);
    if (received >= cost) continue;

    const inv = (await db.$client.execute({
      sql: `SELECT il.unit_cost_cents, il.invoice_date, si.invoice_number, si.supplier
              FROM invoice_lines il JOIN supplier_invoices si ON si.id = il.invoice_id
             WHERE il.ndc11 = ? AND il.unit_cost_cents > 0
          ORDER BY ABS(julianday(il.invoice_date) - julianday(?)) ASC LIMIT 1`,
      args: [x.ndc11, x.date_filled],
    })).rows[0] as any;
    if (!inv) continue;

    const units = packUnits(x.pkg);
    if (units === null) continue;

    /* The two sources must agree, or the figure going to a PBM is not trustworthy. */
    const invPerUnit = Number(inv.unit_cost_cents) / units;
    const claimPerUnit = cost / qty;
    if (Math.abs(invPerUnit - claimPerUnit) > Math.max(1, claimPerUnit * 0.02)) continue;

    const nadacPerUnit = Number(x.nadac_micros) / 10000;
    const nadacTotal = Math.round(nadacPerUnit * qty);
    const deadline = new Date(Date.parse(x.date_filled + "T00:00:00Z") + 10 * 86400000).toISOString().slice(0, 10);
    const daysLeft = Math.round((Date.parse(deadline + "T00:00:00Z") - Date.parse(TODAY + "T00:00:00Z")) / 86400000);

    /*
     * Which reason to ask for. Repricing at NADAC only helps where NADAC covers the cost; where
     * NADAC is itself below cost, asking for it would leave the pharmacy underwater and the honest
     * ask is above it.
     */
    const reason = nadacTotal >= cost ? "Reprice at NADAC" : "Reprice above NADAC";

    const comments =
      `Generic. NADAC on ${shortUs(x.date_filled)} was $${(nadacPerUnit / 100).toFixed(5)}/unit, ${money(nadacTotal)} for ${qty}. ` +
      `Paid ${money(received)} ($${(received / 100 / qty).toFixed(4)}/unit). ` +
      `Acquisition ${money(Number(inv.unit_cost_cents))} per ${units}ct, ${inv.supplier} inv ${inv.invoice_number} dtd ${shortUs(inv.invoice_date)}. ` +
      `${money(Math.abs(nadacTotal - received))} ${received < nadacTotal ? "below" : "above"} NADAC, ${money(cost - received)} below cost. ${reason} requested.`;

    plan.push({
      claimId: x.id,
      shortCents: cost - received,
      daysLeft,
      deadline,
      form: {
        RXNumber: String(x.rx_number).padStart(7, "0"),
        FillDate: us(x.date_filled),
        NCPDP: "1722734",
        BINSelected: x.bin,
        PCNNumber: x.pcn ?? "",
        InvoiceCost: (Number(inv.unit_cost_cents) / 100).toFixed(2),
        InvoiceNDCPackageSize: String(units),
        InvoiceEffectiveDate: us(inv.invoice_date),
        InternalTrackingNumber: "WWFP-" + x.rx_number,
        AppealReason: reason,
        Comments: comments.length <= 255 ? comments : comments.slice(0, 252) + "...",
      },
      evidence: { rx: String(x.rx_number), dos: x.date_filled },
      drug: String(x.item_name ?? "").slice(0, 26),
    });
  }

  plan.sort((a, b) => a.daysLeft - b.daysLeft || b.shortCents - a.shortCents);
  const take = plan.slice(0, limit);

  console.log(`Caremark: ${plan.length} filable, ${money(plan.reduce((n, p) => n + p.shortCents, 0))}`);
  console.log(`  comments over 255 chars: ${plan.filter((p) => p.form.Comments.length > 255).length}`);
  console.log("");
  for (const p of take) {
    console.log(
      `  ${p.form.RXNumber}  ${p.form.FillDate}  ${p.drug.padEnd(26)} ${money(p.shortCents).padStart(9)}  ${String(p.daysLeft).padStart(3)}d  ${p.form.AppealReason}`,
    );
  }
  console.log("\nfull plan:");
  console.log(JSON.stringify(take, null, 1));
}

main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
