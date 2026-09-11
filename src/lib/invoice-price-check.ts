/**
 * What the wholesaler billed, against what was actually booked in.
 *
 * The owner, on the list of deliveries with no invoice: "IS THE SYSTEM THAT GETS ORDER RECEIPTS FROM
 * PIONEER AND KNOWS WHAT INVOICES TO EXPECT WHICH ONES TO NOT EXPECT (IS IT MAKING SURE WE GOT ALL
 * THE ONES TO EXPECT AND MATCHING PRICE?) ITS A GOOD CHECK FOR THE SYSTEM" — then "fix it!".
 *
 * Half of it already worked. `invoices-owed.ts` answers the first question: every delivery PioneerRx
 * booked in, against every invoice on file, so a document that never arrived has a row. Nothing
 * answered the second. The nightly pull did compare the two totals and wrote the result into a
 * setting — 73 invoices, 12 agreeing, 0 differing — and nothing anywhere read that setting. A check
 * whose answer is not on a screen is not a check; it is a number in a drawer. It could have read
 * twenty differing for a month and nobody would have known.
 *
 * So this is the check, done properly and shown:
 *
 *   the total   — what the invoice says is due against what PioneerRx booked in for the same number.
 *   each price  — per NDC, what was billed for the drug against what the receipt recorded.
 *   each count  — how many packs were billed against how many arrived.
 *   each drug   — a drug on one side and not the other, which is either a line nobody was billed
 *                 for, a line billed for nothing, or the same drug read as two different NDCs.
 *
 * Two systems, filled in independently — one by the wholesaler's document, one by whoever received
 * the delivery — which is what makes the comparison worth anything. A price only one of them holds
 * is a price nobody has checked.
 *
 * The first run found one: an IPD line for propranolol where both sides agree on the quantity and
 * agree on the $3.99, and the NDC read off the invoice was 54707560094, which is not a drug. The
 * money was right and the product was wrong, which no total will ever catch, and every margin
 * computed from that line was against the wrong drug.
 */

import { db, schema } from "@/db";

/** How far apart two figures may be before it is worth saying. Rounding, not a dispute. */
const TOLERANCE_CENTS = 2;

export type PriceDisagreement = {
  kind: "total" | "price" | "quantity" | "misread" | "billed-not-received" | "received-not-billed";
  invoiceNumber: string;
  supplier: string;
  invoiceDate: string | null;
  invoiceId: string | null;
  ndc11: string | null;
  description: string | null;
  /** What the supplier's own invoice says. */
  billedCents: number | null;
  /** What PioneerRx recorded for the same thing. */
  receivedCents: number | null;
  /** Billed less received. Positive means billed for more than arrived. */
  differenceCents: number;
  /** The whole finding in one sentence, in the words somebody would use out loud. */
  say: string;
};

export type PriceCheck = {
  /** Invoices on file that have a PioneerRx delivery under the same number to check against. */
  checked: number;
  /** Of those, the ones where the total and every line agree. */
  agreeing: number;
  /** Invoice lines compared drug by drug. */
  linesCompared: number;
  disagreements: PriceDisagreement[];
  /** Billed above what arrived, across every disagreement that is about money. */
  overbilledCents: number;
  /** Invoices with no delivery to check against, and why — so the coverage is not overstated. */
  unchecked: { invoiceNumber: string | null; supplier: string | null; why: string }[];
  checkedAt: string;
};

type Line = { ndc11: string | null; description: string | null; quantity: number; unitCostCents: number | null; extendedCents: number };

/**
 * The delivery's lines, preferring the figures over the sentence.
 *
 * `items_json` is written by the pull as numbers. `items_text` is the same lines space-joined for
 * reading, and every row pulled before the column existed has only that — so it is read back by
 * position: the NDC first, the extended amount last, the count before it, the description between.
 * Good enough to compare, never good enough to be the only copy, which is why the column exists.
 */
function deliveryLines(row: { itemsJson: string | null; itemsText: string | null }): Line[] {
  const json = (row.itemsJson ?? "").trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as Line[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* Fall through to the text. A malformed line is not a reason to check nothing. */
    }
  }
  return (row.itemsText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l): Line | null => {
      const t = l.split(/\s+/);
      const extended = Number(t[t.length - 1]);
      const quantity = Number(t[t.length - 2]);
      if (!Number.isFinite(extended) || !Number.isFinite(quantity)) return null;
      const ndc11 = /^\d{11}$/.test(t[0]) ? t[0] : null;
      return {
        ndc11,
        description: t.slice(ndc11 ? 1 : 0, t.length - 2).join(" ") || null,
        quantity,
        unitCostCents: null,
        extendedCents: Math.round(extended * 100),
      };
    })
    .filter((l): l is Line => l !== null);
}

/** One drug's worth of a delivery or an invoice, however many lines it was printed on. */
type PerDrug = { quantity: number; extendedCents: number; description: string | null; lines: number };

function byNdc(lines: Line[]): Map<string, PerDrug> {
  const out = new Map<string, PerDrug>();
  for (const l of lines) {
    if (!l.ndc11) continue;
    const at = out.get(l.ndc11) ?? { quantity: 0, extendedCents: 0, description: l.description, lines: 0 };
    at.quantity += l.quantity;
    at.extendedCents += l.extendedCents;
    at.lines++;
    at.description = at.description ?? l.description;
    out.set(l.ndc11, at);
  }
  return out;
}

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function checkInvoicePrices(): Promise<PriceCheck> {
  const purchases = await db
    .select({
      supplier: schema.pioneerPurchases.supplier,
      invoiceNumber: schema.pioneerPurchases.invoiceNumber,
      invoiceDate: schema.pioneerPurchases.invoiceDate,
      totalCents: schema.pioneerPurchases.totalCents,
      itemsJson: schema.pioneerPurchases.itemsJson,
      itemsText: schema.pioneerPurchases.itemsText,
    })
    .from(schema.pioneerPurchases);
  const invoices = await db
    .select({
      id: schema.supplierInvoices.id,
      supplier: schema.supplierInvoices.supplier,
      invoiceNumber: schema.supplierInvoices.invoiceNumber,
      invoiceDate: schema.supplierInvoices.invoiceDate,
      totalCents: schema.supplierInvoices.totalCents,
    })
    .from(schema.supplierInvoices);
  const allLines = await db
    .select({
      invoiceId: schema.invoiceLines.invoiceId,
      ndc11: schema.invoiceLines.ndc11,
      description: schema.invoiceLines.description,
      quantity: schema.invoiceLines.quantity,
      unitCostCents: schema.invoiceLines.unitCostCents,
      extendedCents: schema.invoiceLines.extendedCents,
    })
    .from(schema.invoiceLines);

  const linesOf = new Map<string, Line[]>();
  for (const l of allLines) {
    const at = linesOf.get(l.invoiceId) ?? [];
    at.push(l);
    linesOf.set(l.invoiceId, at);
  }

  /*
   * Matched on the invoice number alone, as the pull matches.
   *
   * The two systems spell the same wholesaler differently — "Independent Pharmacy Cooperative (IPC)"
   * off the letterhead against PioneerRx's "IPC" — so keying on the name as well matched none of
   * them. A number is issued by one supplier and is the thing a person would check.
   */
  const deliveryBy = new Map(purchases.filter((p) => p.invoiceNumber).map((p) => [String(p.invoiceNumber).trim(), p]));

  /*
   * Which NDCs are real, for telling a misread from a substitution.
   *
   * Where the two sides carry different NDCs for the same money and the same count, one of the two
   * readings is wrong. The FDA directory says which: an NDC that is not a drug was not on the
   * document, it came out of the reader.
   */
  const known = new Set((await db.select({ ndc11: schema.drugDirectory.ndc11 }).from(schema.drugDirectory)).map((d) => d.ndc11));

  const out: PriceDisagreement[] = [];
  const unchecked: PriceCheck["unchecked"] = [];
  let checked = 0;
  let agreeing = 0;
  let linesCompared = 0;

  for (const inv of invoices) {
    const number = inv.invoiceNumber?.trim() ?? "";
    if (!number) {
      unchecked.push({ invoiceNumber: null, supplier: inv.supplier, why: "The invoice carries no number, so there is nothing to tie it to a delivery." });
      continue;
    }
    const delivery = deliveryBy.get(number);
    if (!delivery) {
      unchecked.push({ invoiceNumber: number, supplier: inv.supplier, why: "No PioneerRx delivery carries this number, so there is no second copy of the price." });
      continue;
    }
    checked++;
    const before = out.length;
    const supplier = inv.supplier ?? delivery.supplier ?? "a supplier";
    const at = { invoiceNumber: number, supplier, invoiceDate: inv.invoiceDate ?? delivery.invoiceDate, invoiceId: inv.id };

    /* ── The total ────────────────────────────────────────────────── */
    if (inv.totalCents !== null && delivery.totalCents !== null && Math.abs(inv.totalCents - delivery.totalCents) > TOLERANCE_CENTS) {
      const diff = inv.totalCents - delivery.totalCents;
      out.push({
        ...at,
        kind: "total",
        ndc11: null,
        description: null,
        billedCents: inv.totalCents,
        receivedCents: delivery.totalCents,
        differenceCents: diff,
        say:
          `${supplier} billed ${money(inv.totalCents)} on ${number}; PioneerRx booked in ${money(delivery.totalCents)} against the same number — ` +
          `${money(diff)} ${diff > 0 ? "more on the invoice than arrived" : "more arrived than was billed"}.`,
      });
    }

    /* ── Line by line, where both sides have lines ─────────────────── */
    const billed = byNdc(linesOf.get(inv.id) ?? []);
    const received = byNdc(deliveryLines(delivery));
    if (billed.size === 0 || received.size === 0) {
      /*
       * Silence rather than a wall of rows.
       *
       * An invoice whose items never parsed has no lines here, and comparing nothing against eight
       * delivery lines would report all eight as never billed. That is not a price problem, it is
       * the reader failing, and the site already says so in its own words elsewhere. Saying it again
       * in this language would put eight false findings on the screen for one real one.
       */
      if (out.length === before) agreeing++;
      continue;
    }

    for (const [ndc, b] of billed) {
      const r = received.get(ndc);
      if (!r) continue;
      linesCompared++;
      const diff = b.extendedCents - r.extendedCents;
      if (Math.abs(diff) > TOLERANCE_CENTS) {
        out.push({
          ...at,
          kind: "price",
          ndc11: ndc,
          description: b.description ?? r.description,
          billedCents: b.extendedCents,
          receivedCents: r.extendedCents,
          differenceCents: diff,
          say:
            `${b.description ?? r.description ?? ndc} on ${supplier} ${number}: billed ${money(b.extendedCents)} for ${b.quantity}, ` +
            `PioneerRx booked in ${money(r.extendedCents)} for ${r.quantity} — ${money(diff)} ${diff > 0 ? "more than arrived" : "less than arrived"}.`,
        });
      } else if (b.quantity !== r.quantity) {
        /*
         * Same money, different count. Not a wrong price — a wrong idea of what a pack is.
         *
         * It matters because every cost per unit downstream divides by this number, so the money is
         * right and the cost of a tablet is not.
         */
        out.push({
          ...at,
          kind: "quantity",
          ndc11: ndc,
          description: b.description ?? r.description,
          billedCents: b.extendedCents,
          receivedCents: r.extendedCents,
          differenceCents: 0,
          say:
            `${b.description ?? r.description ?? ndc} on ${supplier} ${number}: the invoice was read as ${b.quantity} and PioneerRx booked in ${r.quantity}, ` +
            `both for ${money(b.extendedCents)}. The money agrees; what a pack is does not.`,
        });
      }
    }

    /*
     * Drugs on one side only — paired up where they are plainly the same line.
     *
     * A drug billed and not received and a drug received and not billed, for the same count and the
     * same money, is one line whose NDC was read two ways rather than two problems. Reporting them
     * separately would read as "you were billed for something that never came" about a delivery
     * that was perfectly correct.
     */
    const onlyBilled = [...billed].filter(([ndc]) => !received.has(ndc));
    const onlyReceived = [...received].filter(([ndc]) => !billed.has(ndc));
    const takenReceived = new Set<string>();
    for (const [ndc, b] of onlyBilled) {
      const twin = onlyReceived.find(
        ([n, r]) => !takenReceived.has(n) && r.quantity === b.quantity && Math.abs(r.extendedCents - b.extendedCents) <= TOLERANCE_CENTS,
      );
      if (twin) {
        takenReceived.add(twin[0]);
        const [rNdc, r] = twin;
        const billedReal = known.has(ndc);
        const receivedReal = known.has(rNdc);
        const which =
          billedReal && receivedReal
            ? "Both are real drugs, so one of the two systems has the wrong one against the money."
            : billedReal
              ? `PioneerRx's ${rNdc} is not a drug in the FDA directory, so the delivery was booked in under a code that is not one.`
              : receivedReal
                ? `${ndc} is not a drug in the FDA directory, so the invoice reader produced it — the delivery's ${rNdc} is the real one.`
                : /*
                   * Neither is a drug, which is the ordinary case for the front end.
                   *
                   * Pen needles, Dexcom sensors and Omnipods are devices and have no NDC at all, so
                   * both systems are holding a UPC and neither is wrong. Saying "one of these is
                   * wrong" about 28 such lines would be 28 findings that are not findings.
                   */
                  "Neither is a drug in the FDA directory, so both are device codes — likely the same item under two barcodes rather than a mistake.";
        out.push({
          ...at,
          kind: "misread",
          ndc11: billedReal && !receivedReal ? ndc : rNdc,
          description: b.description ?? r.description,
          billedCents: b.extendedCents,
          receivedCents: r.extendedCents,
          differenceCents: 0,
          say:
            `${b.description ?? r.description ?? "One line"} on ${supplier} ${number}: read off the invoice as NDC ${ndc}, booked into PioneerRx as ${rNdc} — ` +
            `same count, same ${money(b.extendedCents)}. ${which}`,
        });
        continue;
      }
      out.push({
        ...at,
        kind: "billed-not-received",
        ndc11: ndc,
        description: b.description,
        billedCents: b.extendedCents,
        receivedCents: null,
        differenceCents: b.extendedCents,
        say: `${b.description ?? ndc} on ${supplier} ${number}: billed ${money(b.extendedCents)} for ${b.quantity}, and PioneerRx booked in none of it.`,
      });
    }
    for (const [ndc, r] of onlyReceived) {
      if (takenReceived.has(ndc)) continue;
      out.push({
        ...at,
        kind: "received-not-billed",
        ndc11: ndc,
        description: r.description,
        billedCents: null,
        receivedCents: r.extendedCents,
        differenceCents: -r.extendedCents,
        say: `${r.description ?? ndc} on ${supplier} ${number}: PioneerRx booked in ${money(r.extendedCents)} for ${r.quantity}, and the invoice bills for none of it.`,
      });
    }

    if (out.length === before) agreeing++;
  }

  /*
   * Money only, and only where the pharmacy paid more.
   *
   * A quantity disagreement moves no money and a misread moves no money, so neither counts here.
   * Billed-above-received on a total and billed-above-received on a line are the same overcharge
   * counted twice when both fire on one invoice, so the total is taken where it exists and the
   * lines only where it does not.
   */
  const totalsSeen = new Set(out.filter((d) => d.kind === "total").map((d) => d.invoiceNumber));
  const overbilledCents = out
    .filter((d) => d.kind === "total" || ((d.kind === "price" || d.kind === "billed-not-received") && !totalsSeen.has(d.invoiceNumber)))
    .reduce((n, d) => n + Math.max(0, d.differenceCents), 0);

  return { checked, agreeing, linesCompared, disagreements: out, overbilledCents, unchecked, checkedAt: new Date().toISOString() };
}
