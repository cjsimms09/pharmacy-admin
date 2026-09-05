/**
 * Reading the item lines off a wholesaler's invoice, as data rather than as text.
 *
 * The invoices were already being filed, searched and kept — but only as a block of text. Every
 * question worth asking of them needs the numbers: what this pharmacy actually paid for an NDC,
 * from whom, on what date, and whether that line earned a rebate. Without those the site can
 * compare catalogue list prices and NADAC and never know what was really paid.
 *
 * ── Why the arithmetic matters ──
 *
 * Both formats run fields together with no separator — McKesson prints the NDC, item number and
 * document number as one unbroken string of digits, and IPD prints the order and ship quantities
 * the same way, so "11" is either one ordered and one shipped or eleven ordered and one. A parser
 * that guesses is a parser that quietly puts a wrong cost against a drug. So every line is checked
 * against its own arithmetic — shipped quantity times unit price must equal the extended amount —
 * and a line that does not reconcile is returned as unreadable rather than as a number somebody
 * might act on. That check also settles the ambiguous split: the reading that balances is the
 * right one.
 *
 * ── The rebate flag ──
 *
 * McKesson prints a K against lines bought on the generics contract. That single letter is the
 * fact that decides whether a gross price gets the tier rate taken off it before it is compared
 * with anything, and it is read from the invoice rather than inferred from the drug.
 */

export type InvoiceLineRead = {
  ndc11: string;
  description: string | null;
  /** The supplier's own catalogue number for the item, where the invoice prints one. */
  itemNumber: string | null;
  quantity: number;
  /** "EA", "CT", "BX" — the unit the quantity counts, where the invoice prints one. */
  unitOfMeasure: string | null;
  unitCostCents: number;
  extendedCents: number;
  /** AWP as printed, where the invoice prints it. */
  awpCents: number | null;
  /** The supplier's own item class: R for legend, X for Schedule II, B/D/E for III-V. */
  itemClass: string | null;
  /** True where the line was marked as earning the supplier's contract rebate. */
  rebated: boolean | null;
};

export type LineParse = {
  lines: InvoiceLineRead[];
  format: "mckesson" | "ipc" | null;
  /** Lines that looked like items but did not reconcile, kept verbatim so somebody can look. */
  unreadable: string[];
  /** Sum of the extended amounts read, for checking against the invoice total. */
  totalCents: number;
  /**
   * Whether the lines read add up to the total printed on the invoice.
   *
   * The check that matters most, and the one that found the bug this parser shipped with: a single
   * line whose format differed by one trailing figure was dropped, and the remaining four read
   * perfectly. Nothing about the result looked wrong — four plausible lines, no errors — and the
   * pharmacy would have been eighty-three dollars short on a drug it bought. So the reconciliation
   * is part of the answer rather than something a person might think to do, and lines that do not
   * add up are held back from the ledger instead of quietly under-counting a product's cost.
   */
  reconciles: boolean | null;
  /** What the invoice says it came to, where that could be read. */
  printedTotalCents: number | null;
};

const money = (s: string): number => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
const MONEY = String.raw`[\d,]+\.\d{2}`;

/**
 * McKesson: NDC, item number and document number printed as one run of digits, then the quantity
 * and unit, the description, AWP, the item class, the unit price, an optional K, and the extended
 * amount.
 */
const MCK = new RegExp(
  String.raw`^(\d{5}-\d{4}-\d{2})` + // NDC, hyphenated
    String.raw`(\d{3}-\d{4})` + // McKesson item number
    String.raw`\d{9}` + // document number, not kept
    String.raw`\s+(\d+)\*?([A-Z]{2})\s+` + // quantity, an optional asterisk, unit of measure
    String.raw`(.*?)\s+(${MONEY})` + // description, then AWP
    String.raw`\s+([A-Z])` + // item class
    String.raw`\s+(${MONEY})` + // unit price
    String.raw`(\s+K)?` + // the contract rebate flag
    String.raw`\s+(${MONEY})` + // extended amount
    // Some lines carry one more figure after the extended amount — a pack multiple on the
    // testosterone gel line of a real invoice. It is not a field this needs, but a pattern
    // anchored hard to the end of the line silently dropped the whole line rather than the
    // figure, and eighty-three dollars went missing from an invoice that otherwise reconciled.
    String.raw`(?:\s+[\d.,]+)?\s*$`,
);

/**
 * IPD and IPC: item number, description, an eleven-digit NDC run onto the end of the description,
 * WAC, AWP, an optional note code, the order and ship quantities run together, unit price and
 * extended amount.
 */
const IPC = new RegExp(
  String.raw`^(\d{6,8})` + // item number
    String.raw`(.*?)` + // description, with the pack size run onto its end
    String.raw`(\d{11})` + // NDC, eleven digits, unhyphenated
    String.raw`\$(${MONEY})` + // WAC
    String.raw`\$(${MONEY})` + // AWP
    String.raw`([A-Za-z]{0,2})` + // note code, often absent
    String.raw`(\d+)` + // order and ship quantities, run together
    String.raw`\$(${MONEY})` + // unit price
    String.raw`\$(${MONEY})\s*$`, // extended amount
);

/** An eleven-digit NDC to the hyphenated form's digits, unchanged; a hyphenated one padded to 11. */
export function ndc11(raw: string): string | null {
  const m = /^(\d{4,5})-(\d{3,4})-(\d{1,2})$/.exec(raw.trim());
  if (m) return m[1].padStart(5, "0") + m[2].padStart(4, "0") + m[3].padStart(2, "0");
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

/**
 * Splits a run of digits into an order quantity and a ship quantity, using the arithmetic to
 * decide.
 *
 * "11" is one ordered and one shipped, or eleven ordered and one; the invoice prints no separator
 * and both readings are possible. The extended amount settles it: shipped times unit price is the
 * extended amount, and only one split satisfies that. Where none does, the line is not read at all
 * rather than read wrongly.
 */
export function splitQuantities(run: string, unitCents: number, extendedCents: number): { ordered: number; shipped: number } | null {
  for (let cut = 1; cut < run.length; cut++) {
    const ordered = Number(run.slice(0, cut));
    const shipped = Number(run.slice(cut));
    if (!Number.isFinite(ordered) || !Number.isFinite(shipped)) continue;
    if (String(shipped).length !== run.length - cut) continue; // a leading zero is not a quantity
    if (shipped * unitCents === extendedCents) return { ordered, shipped };
  }
  // A single digit is both, and the commonest line on any invoice: one ordered, one shipped.
  const only = Number(run);
  if (Number.isFinite(only) && only * unitCents === extendedCents) return { ordered: only, shipped: only };
  return null;
}

/**
 * Reads whatever item lines a wholesaler's invoice text carries.
 *
 * `printedTotalCents` is the figure read off the front of the invoice, passed in by the caller
 * that already read it. Given one, the result says whether the lines add up to it.
 */
export function parseInvoiceLines(text: string, printedTotalCents: number | null = null): LineParse {
  const out: InvoiceLineRead[] = [];
  const unreadable: string[] = [];
  let format: LineParse["format"] = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const mck = MCK.exec(line);
    if (mck) {
      const [, ndc, item, qtyText, uom, desc, awp, cls, unit, k, ext] = mck;
      const quantity = Number(qtyText);
      const unitCostCents = money(unit);
      const extendedCents = money(ext);
      const key = ndc11(ndc);
      // The line's own arithmetic. A description containing something that looks like money would
      // otherwise shift every field after it, and the wrong cost would look perfectly plausible.
      if (!key || quantity * unitCostCents !== extendedCents) {
        unreadable.push(line.slice(0, 200));
        continue;
      }
      format = "mckesson";
      out.push({
        ndc11: key,
        description: desc.trim() || null,
        itemNumber: item,
        quantity,
        unitOfMeasure: uom,
        unitCostCents,
        extendedCents,
        awpCents: money(awp),
        itemClass: cls,
        rebated: Boolean(k),
      });
      continue;
    }

    const ipc = IPC.exec(line);
    if (ipc) {
      const [, item, desc, ndc, , awp, , qtyRun, unit, ext] = ipc;
      const unitCostCents = money(unit);
      const extendedCents = money(ext);
      const key = ndc11(ndc);
      const qty = splitQuantities(qtyRun, unitCostCents, extendedCents);
      if (!key || !qty) {
        unreadable.push(line.slice(0, 200));
        continue;
      }
      format = format ?? "ipc";
      out.push({
        ndc11: key,
        description: desc.trim() || null,
        itemNumber: item,
        quantity: qty.shipped,
        unitOfMeasure: null,
        unitCostCents,
        extendedCents,
        awpCents: money(awp),
        itemClass: null,
        // This invoice prints no contract marking, so nothing is claimed either way. Saying "not
        // rebated" here would strip a discount off a price in every comparison that followed.
        rebated: null,
      });
    }
  }

  const totalCents = out.reduce((n, l) => n + l.extendedCents, 0);
  return {
    lines: out,
    format,
    unreadable,
    totalCents,
    printedTotalCents,
    reconciles: printedTotalCents === null || out.length === 0 ? null : totalCents === printedTotalCents,
  };
}
