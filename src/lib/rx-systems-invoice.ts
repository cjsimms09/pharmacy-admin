/**
 * An Rx Systems supplies invoice, read off its own page.
 *
 * ── What this is not ──
 *
 * It is not a drug invoice, and the difference decides where every dollar of it lands. The owner,
 * 16 September 2026: *"Rx system is for pharmacy supplies. Not for drugs"*, and then *"It just needs
 * to be allocated as spending... it is pharmacy supply spending (bags, vials, labels)"*.
 *
 * Filed as a supplier invoice it would be counted as **Drug purchases** — cost of goods — which
 * overstates COGS, understates gross margin on every report that divides by it, puts a bag of
 * carrier bags in the archive that 21 CFR 1304.04 governs, and asks him on the setup list for a
 * price file, an order minimum and a rebate ladder from a company that sells bags. It is an
 * operating expense under **Pharmacy supplies**, which is a category this site already has and whose
 * own description reads "Vials, caps, labels, bags, unit-dose packaging, refrigerant."
 *
 * ── The freight, which is the whole reason this needs reading rather than typing ──
 *
 * Their invoice adds freight and then says, in its own words:
 *
 *   "Freight has been added to your invoice. If the invoice is paid within 30 days, you may deduct
 *    the freight amount from the invoice total."
 *
 * So the total on the page is not the spending. The owner, of the one that arrived: *"406 is freight
 * that gets refunded.. so just use the 1715"*. The document and the owner agree, and neither is
 * being inferred from the other.
 *
 * Booked as the goods alone, with the freight recorded beside it and the condition said out loud.
 * A bill is not the place to record a discount somebody might not take — but silently dropping $406
 * without saying why would leave an accountant unable to tie this to the paper.
 *
 * ── Proved by arithmetic before anything is stored ──
 *
 * CLAUDE.md: every reader that decides money is checked by arithmetic first. Goods plus freight plus
 * extras must equal the total the invoice prints, to the cent. On the invoice of 15 September that
 * is $1,715.00 + $406.00 + $0.00 = $2,121.00, and it holds. Where it does not hold, nothing is
 * returned and a person is asked — a supplies bill invented from a half-read PDF is worse than one
 * nobody entered, because only the second is visibly missing.
 *
 * The text layer arrives with its columns interleaved, which is why this reads labelled amounts
 * rather than positions: the word FREIGHT and the figures are reliably present, their order on the
 * page is not.
 *
 * Pure.
 */

export type RxSystemsInvoice = {
  invoiceNumber: string;
  /** ISO, from the invoice's own date. */
  invoiceDate: string;
  /** What the goods cost: the figure to book as spending. */
  goodsCents: number;
  /** Carriage, deductible if paid inside the window below. Recorded, never added to the spending. */
  freightCents: number;
  /** Anything the invoice calls an extra charge. Part of the goods total when it is not nought. */
  extrasCents: number;
  /** What the invoice says is owed in all, and what the arithmetic is checked against. */
  totalCents: number;
  /** The days inside which their invoice says the freight may be deducted. */
  freightDeductibleDays: number | null;
};

export type RxSystemsRead = { ok: true; invoice: RxSystemsInvoice } | { ok: false; why: string };

const cents = (s: string): number => Math.round(Number(s.replace(/[$,\s]/g, "")) * 100);
const MONEY = /\$[\d,]+\.\d{2}/g;

/** Whether a document is one of theirs at all, before any figure is taken from it. */
export function looksLikeRxSystemsInvoice(text: string, from = ""): boolean {
  if (/rxsystems\.com/i.test(from)) return /invoice/i.test(text);
  return /rx\s*systems,?\s*inc/i.test(text) && /invoice/i.test(text);
}

export function readRxSystemsInvoice(text: string): RxSystemsRead {
  const number = /invoice\s*number:?[^\n]*\n\s*(\d{6,})/i.exec(text);
  /* Their number and the customer number are printed adjacent and run together: 1440395 then 16874. */
  const invoiceNumber = number ? number[1].slice(0, 7) : null;
  if (!invoiceNumber) return { ok: false, why: "No invoice number could be read from the page." };

  const date = /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/.exec(text);
  if (!date) return { ok: false, why: "No invoice date could be read from the page." };
  const invoiceDate = `20${date[3]}-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}`;

  /*
   * The freight is the amount on, or immediately before, the line their page labels FREIGHT. The
   * columns interleave, so the label and its figure are near each other rather than in a fixed place.
   */
  const lines = text.split(/\r?\n/);
  /*
   * The label, never the sentence about it.
   *
   * Their page says "FREIGHT" as a column label and then explains the deduction in three lines of
   * prose that also say "freight". Taking the first line containing the word finds the label on this
   * invoice only because the label happens to come first — and a test with the label removed proved
   * the point: the reader picked the sentence and carried on, which is the way this fails silently
   * on a page laid out slightly differently. A label is short and is not a sentence.
   */
  const freightAt = lines.findIndex((l) => /freight/i.test(l) && l.trim().length <= 30 && !/\bthe\b|invoice|paid|deduct|amount/i.test(l));
  if (freightAt < 0) return { ok: false, why: "The page does not label a freight line, so the goods cannot be told from the carriage." };
  const near = lines.slice(Math.max(0, freightAt - 4), freightAt + 2).join("\n");
  const nearby = near.match(MONEY) ?? [];
  const firstNearby = nearby[0];
  if (!firstNearby) return { ok: false, why: "No amount sits with the freight line." };
  const freightCents = cents(firstNearby);
  const secondNearby = nearby[1];
  const extrasCents = secondNearby ? cents(secondNearby) : 0;

  const all = (text.match(MONEY) ?? []).map(cents);
  if (all.length === 0) return { ok: false, why: "No amounts at all could be read from the page." };
  const totalCents = Math.max(...all);

  /*
   * Goods are what is left, and the subtraction is only believed when the page's own figures agree
   * with it. This is the check, not a formatting nicety: the one number that must never be wrong
   * here is the one that becomes spending.
   */
  const goodsCents = totalCents - freightCents - extrasCents;
  if (goodsCents <= 0) return { ok: false, why: `The freight and extras come to more than the invoice total, so the goods cannot be what is left.` };
  if (!all.includes(goodsCents)) {
    return {
      ok: false,
      why: `The goods would be $${(goodsCents / 100).toFixed(2)} by subtraction, and no line on the invoice prints that figure. Nothing was booked.`,
    };
  }

  const window = /deduct the freight[\s\S]{0,80}?(\d{1,3})\s*days|within\s*(\d{1,3})\s*days[\s\S]{0,120}?deduct the freight/i.exec(text);
  const freightDeductibleDays = window ? Number(window[1] ?? window[2] ?? 0) || null : null;

  return { ok: true, invoice: { invoiceNumber, invoiceDate, goodsCents, freightCents, extrasCents, totalCents, freightDeductibleDays } };
}

/** What the bill says on the account, so an accountant can tie it to the paper without opening it. */
export function rxSystemsBillNote(i: RxSystemsInvoice): string {
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    `Rx Systems invoice ${i.invoiceNumber} of ${i.invoiceDate}: ${money(i.goodsCents)} of pharmacy supplies` +
    `${i.extrasCents > 0 ? ` including ${money(i.extrasCents)} of extra charges` : ""}. ` +
    `The invoice totals ${money(i.totalCents)} including ${money(i.freightCents)} of freight, which their page says may be deducted` +
    `${i.freightDeductibleDays ? ` if it is paid within ${i.freightDeductibleDays} days` : ""}. ` +
    `The freight is not counted as spending here; if it is ever paid, it belongs on the account as carriage on the day it is paid.`
  );
}
