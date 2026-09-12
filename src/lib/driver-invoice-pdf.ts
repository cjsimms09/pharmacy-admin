import { drawnPdf, PAGE, textWidth, wrapForPdf, type Draw } from "./pdf";
import { monthLabel, money, weekdaysIn, type InvoiceLine, type DriverInvoice } from "./deliveries";

/**
 * The invoice as the person paying it sees it.
 *
 * This is the only part of this system anybody outside the pharmacy ever looks at. It arrives in
 * an accounts inbox alongside invoices from companies with design departments, and it is read by
 * somebody who has never heard of this software — so the entire impression it makes is the page
 * itself. The spreadsheet it replaces had the total in a cell marked #REF!, which is the kind of
 * thing that gets an invoice queried rather than paid.
 *
 * Two rules decide the layout, and both came from looking at one that had been sent.
 *
 * The page must look finished. The first version let every block fall wherever the block above it
 * ended, so a month with four days entered stopped two-thirds of the way down and the rest of the
 * sheet was empty — which reads as a document that was cut off rather than one that ended. The
 * payment terms and the page foot are therefore anchored to the bottom of the page, where the
 * reader's eye expects them, whatever the table did.
 *
 * And it must never run off the edge. A long month with notes on the quiet days could push the
 * total past the bottom, and an invoice whose total is not on it is worse than no invoice at all.
 * So the rows are measured against the space that is actually left, and a month that does not fit
 * continues onto a second page with the headings repeated.
 *
 * Laid out in the order the reader needs: what it is and what it costs at the top, who owes whom
 * next, the day-by-day working underneath for anyone who wants to check it, and how to pay at the
 * foot. Every date the driver worked is listed, including the days he did not, because a month
 * with gaps in it invites the question "what about the 14th?" and the answer should already be on
 * the page.
 */

const { width: W, height: H, margin: M } = PAGE;
const RIGHT = W - M;

/** Column positions, set once so the headings and the figures cannot drift apart. */
const COL = {
  date: M,
  day: M + 92,
  deliveries: M + 252,
  mail: M + 332,
  trips: M + 402,
  amount: RIGHT - 8,
};

/**
 * Where the note on a quiet day is written, and how much room it has.
 *
 * A day with no trips has three zeroes on it that say nothing, so the note takes their place and
 * gets the width it needs — the reason the driver did not work that day is the only thing on that
 * line worth reading. The trips count and the amount stay, because the column still has to add up
 * for anybody checking the total.
 */
const NOTE_X = COL.day + 62;
const NOTE_W = COL.trips - 10 - NOTE_X;

const ROW_H = 14;

/**
 * The bottom of the page, reserved.
 *
 * Everything above is laid out downwards; these three are laid out upwards from the foot, so the
 * sheet always ends where a sheet should end. The table is given what is left between them.
 */
const FOOT = {
  /** The page number line, below the margin, where a printer's own footer would sit. */
  pageNo: 34,
  /** The lowest baseline the payment block occupies. */
  note: 66,
  terms: 90,
  label: 106,
  rule: 122,
};

/** The lowest a table row may be drawn on a page that still has to carry the totals. */
const LAST_PAGE_FLOOR = FOOT.rule + 84;
/** The lowest a row may be drawn on a page that continues overleaf. */
const CONTINUED_FLOOR = FOOT.rule + 26;

export type Parties = {
  driverName: string;
  billToName: string;
  forWhom: string;
  terms: string;
  /** The pharmacy's own address and telephone, one line each. */
  pharmacyLines?: string[];
};

export function invoicePdf(invoice: DriverInvoice, lines: InvoiceLine[], parties: Parties): Buffer {
  const draft = invoice.invoiceNumber === "DRAFT";
  const pages: Draw[][] = [];

  let page: Draw[] = [];
  const text = (d: Omit<Extract<Draw, { kind: "text" }>, "kind">) => page.push({ kind: "text", ...d });
  const rule = (y: number, opts: { x1?: number; x2?: number; weight?: number; grey?: number } = {}) =>
    page.push({ kind: "rule", x1: opts.x1 ?? M, x2: opts.x2 ?? RIGHT, y, weight: opts.weight, grey: opts.grey });

  // ── The masthead, drawn on every page ────────────────────────────
  /*
   * Draws into whichever page it is handed, so its height can be measured on a scratch page before
   * the rows are split. Working out how many rows fit on a continuation sheet needs to know where
   * that sheet's table starts, and that depends on how many address lines the pharmacy has.
   */
  const mastheadInto = (target: Draw[]): number => {
    const text = (d: Omit<Extract<Draw, { kind: "text" }>, "kind">) => target.push({ kind: "text", ...d });
    const rule = (y: number, opts: { weight?: number } = {}) =>
      target.push({ kind: "rule", x1: M, x2: RIGHT, y, weight: opts.weight });
    let y = H - M;

    text({ x: M, y, text: "INVOICE", size: 26, bold: true });

    /*
     * The details, as labelled pairs rather than as a sentence.
     *
     * An accounts clerk is looking for one of these four things at a time — the number to type
     * into their system, the period it covers, the date for their ageing, the terms. Labelling
     * them is the difference between finding one at a glance and reading a paragraph.
     */
    // Wide enough that a label and its value cannot touch: the invoice number is fourteen
    // characters of bold, and it was landing on top of the word beside it.
    const labelX = RIGHT - 210;
    let dy = y + 8;
    const pair = (label: string, value: string, size = 9.5, bold = false) => {
      text({ x: labelX, y: dy, text: label, size: 7.5, bold: true, grey: 0.5 });
      text({ x: RIGHT, y: dy, text: value, size, bold, align: "right" });
      dy -= 14;
    };
    pair("INVOICE NO.", draft ? "Not yet issued" : invoice.invoiceNumber, 10.5, !draft);
    pair("PERIOD", monthLabel(invoice.month));
    pair("ISSUED", longDate(invoice.createdAt.slice(0, 10)));
    // The figure, where an accounts department looks for it before it reads anything else.
    dy -= 2;
    pair("AMOUNT DUE", money(invoice.totalCents), 15, true);

    // The pharmacy's own identity, under the word INVOICE. It raises this on the driver's behalf,
    // and an invoice with no address on it looks like something somebody typed up at home.
    y -= 16;
    text({ x: M, y, text: parties.forWhom, size: 10.5, bold: true, grey: 0.15 });
    for (const line of (parties.pharmacyLines ?? []).slice(0, 3)) {
      y -= 11;
      text({ x: M, y, text: line, size: 8.5, grey: 0.45 });
    }

    y = Math.min(y, dy + 13) - 16;
    rule(y, { weight: 1.4 });
    return y - 24;
  };

  const masthead = (): number => mastheadInto(page);

  // ── The foot, drawn on every page ────────────────────────────────
  const foot = (pageNo: number, total: number) => {
    rule(FOOT.rule, { grey: 0.75 });
    text({ x: M, y: FOOT.label, text: "PAYMENT", size: 8, bold: true, grey: 0.45 });
    // The terms are typed by the pharmacy and can be any length, so they wrap rather than running
    // off the edge of the paper.
    wrapForPdf(parties.terms, 10, RIGHT - M).slice(0, 2).forEach((line, i) => {
      text({ x: M, y: FOOT.terms - i * 12, text: line, size: 10 });
    });
    /*
     * The closing sentence, wrapped.
     *
     * It was one long line drawn from the left margin, and it ran past the right-hand edge of the
     * sheet — the last thing on the invoice, cut off mid-word. Nothing in the code could show that:
     * a position off the page is drawn exactly as happily as one on it.
     */
    wrapForPdf(
      `Raised by ${parties.forWhom} on behalf of ${parties.driverName}. Questions about any day on this invoice can be answered from the pharmacy's own record.`,
      8.5,
      RIGHT - M,
    )
      .slice(0, 2)
      .forEach((line, i) => {
        text({ x: M, y: FOOT.note - i * 11, text: line, size: 8.5, grey: 0.45 });
      });
    text({
      x: M,
      y: FOOT.pageNo,
      text: draft ? `Draft — ${monthLabel(invoice.month)}` : `Invoice ${invoice.invoiceNumber} — ${monthLabel(invoice.month)}`,
      size: 7.5,
      grey: 0.55,
    });
    text({ x: RIGHT, y: FOOT.pageNo, text: `Page ${pageNo} of ${total}`, size: 7.5, grey: 0.55, align: "right" });
  };

  // ── The table's own heading, repeated on a continuation page ─────
  const columnHeadings = (y: number): number => {
    page.push({ kind: "rect", x: M, y: y - 5, w: RIGHT - M, h: 17, grey: 0.93 });
    const head = y + 2;
    text({ x: COL.date, y: head, text: "DATE", size: 8, bold: true, grey: 0.3 });
    text({ x: COL.day, y: head, text: "DAY", size: 8, bold: true, grey: 0.3 });
    text({ x: COL.deliveries, y: head, text: "DELIVERIES", size: 8, bold: true, grey: 0.3, align: "right" });
    text({ x: COL.mail, y: head, text: "MAIL", size: 8, bold: true, grey: 0.3, align: "right" });
    text({ x: COL.trips, y: head, text: "TRIPS", size: 8, bold: true, grey: 0.3, align: "right" });
    text({ x: COL.amount, y: head, text: "AMOUNT", size: 8, bold: true, grey: 0.3, align: "right" });
    return y - 20;
  };

  let y = masthead();

  // ── A draft says so, unmistakably ───────────────────────────────
  /*
   * A draft that reaches an accounts department by accident gets paid, or gets queried, and either
   * way somebody quotes a number that was never issued. "No. DRAFT" in nine-point type at the top
   * corner was not enough to prevent that.
   */
  if (draft) {
    page.push({ kind: "rect", x: M, y: y - 12, w: RIGHT - M, h: 26, grey: 0.9 });
    text({ x: M + 10, y: y - 4, text: "DRAFT — NOT YET ISSUED", size: 11, bold: true, grey: 0.25 });
    text({
      x: RIGHT - 10,
      y: y - 3,
      text: "The month is not finished. An invoice number is assigned when it is.",
      size: 8.5,
      grey: 0.4,
      align: "right",
    });
    y -= 34;
  }

  // ── Who, and how much ────────────────────────────────────────────
  // The amount goes at the top as well as the bottom. An accounts department sorts by amount
  // before it reads anything, and making somebody hunt for the figure is how an invoice ends up
  // at the bottom of the pile.
  /*
   * Two columns, not three.
   *
   * The amount used to sit here as a third column, and the party being billed — "West Wichita
   * Family Physicians, PA" — ran straight underneath it. Names are as long as they are; the figure
   * has a fixed home in the block at the top right and another in the box below the table, which
   * is twice already.
   */
  const BILL_X = M + 244;
  text({ x: M, y, text: "FROM", size: 8, bold: true, grey: 0.45 });
  text({ x: BILL_X, y, text: "BILL TO", size: 8, bold: true, grey: 0.45 });
  y -= 16;

  text({ x: M, y, text: fit(parties.driverName, 12, BILL_X - M - 16), size: 12, bold: true });
  text({ x: BILL_X, y, text: fit(parties.billToName, 12, RIGHT - BILL_X), size: 12, bold: true });
  y -= 13;

  const trips = invoice.deliveries + invoice.mailTrips;
  text({ x: M, y, text: `Delivery driver for ${parties.forWhom}`, size: 9, grey: 0.35 });
  y -= 30;

  text({
    x: M,
    y,
    text: `Prescription deliveries and daily mail runs for ${parties.forWhom}, ${monthLabel(invoice.month)}.`,
    size: 10,
  });
  y -= 13;
  text({
    x: M,
    y,
    text: `${invoice.deliveries} deliveries and ${invoice.mailTrips} mail trips, ${trips} trips in total at ${money(invoice.rateCents)} each.`,
    size: 10,
    grey: 0.3,
  });
  y -= 28;

  // ── The working ──────────────────────────────────────────────────
  /*
   * How many rows fit is worked out rather than assumed.
   *
   * The last page has to carry the totals and the amount due as well as the rows, so it has less
   * room for them than a page that continues overleaf. Splitting on the wrong count is how the
   * total ends up alone on a second sheet, or off the bottom of the first — and an invoice whose
   * total is not on it is worse than no invoice at all.
   */
  const scratch: Draw[] = [];
  const continuedTableTop = mastheadInto(scratch) - 22 - 20;
  const sizes = paginate(lines.length, y - 20, continuedTableTop);
  const chunks: InvoiceLine[][] = [];
  {
    let rest = lines;
    for (const n of sizes) {
      chunks.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
  }

  const pageCount = chunks.length;

  chunks.forEach((chunk, index) => {
    const last = index === pageCount - 1;
    if (index > 0) {
      pages.push(page);
      page = [];
      y = masthead();
      text({ x: M, y, text: `${monthLabel(invoice.month)} continued`, size: 10, bold: true, grey: 0.3 });
      y -= 22;
    }
    y = columnHeadings(y);

    chunk.forEach((line, i) => {
      const zero = line.trips === 0;
      // A faint band on alternate rows. Six columns of small figures is exactly the situation
      // where an eye slips a line, and the amount is the column it slips on.
      if (i % 2 === 1) page.push({ kind: "rect", x: M, y: y - 4, w: RIGHT - M, h: ROW_H, grey: 0.97 });
      const said = zero && line.note ? fit(line.note, 8.5, NOTE_W) : "";
      text({ x: COL.date, y, text: shortDate(line.onDate), size: 9.5, grey: zero ? 0.5 : 0 });
      text({ x: COL.day, y, text: dayName(line.onDate), size: 9.5, grey: zero ? 0.5 : 0.35 });
      // A day with nothing on it says why, on the day it happened, rather than leaving a gap the
      // reader has to ask about. It takes the room the two zero counts were using, since a zero
      // delivery count on a day that already reads 0 trips tells nobody anything.
      if (said) {
        text({ x: NOTE_X, y, text: said, size: 8.5, grey: 0.5 });
      } else {
        text({ x: COL.deliveries, y, text: String(line.deliveries), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
        text({ x: COL.mail, y, text: String(line.mailTrips), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
      }
      text({ x: COL.trips, y, text: String(line.trips), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
      text({ x: COL.amount, y, text: money(line.amountCents), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
      y -= ROW_H;
    });

    if (!last) {
      text({ x: RIGHT, y: y - 2, text: "continued overleaf", size: 8.5, grey: 0.5, align: "right" });
      foot(index + 1, pageCount);
      return;
    }

    // ── The totals, on the last page only ─────────────────────────
    y -= 4;
    rule(y, { x1: COL.deliveries - 60, weight: 1 });
    y -= 16;

    text({ x: COL.date, y, text: "Total deliveries and mail trips", size: 10, bold: true });
    text({ x: COL.deliveries, y, text: String(invoice.deliveries), size: 10, bold: true, align: "right" });
    text({ x: COL.mail, y, text: String(invoice.mailTrips), size: 10, bold: true, align: "right" });
    text({ x: COL.trips, y, text: String(trips), size: 10, bold: true, align: "right" });
    text({ x: COL.amount, y, text: money(invoice.totalCents), size: 10, bold: true, align: "right" });

    y -= 32;
    const boxX = COL.deliveries - 60;
    // Tall enough for both lines. The working under the label was clipping its descenders against
    // the bottom edge of the box.
    page.push({ kind: "rect", x: boxX, y: y - 16, w: RIGHT - boxX, h: 36, grey: 0.9 });
    text({ x: boxX + 12, y, text: "AMOUNT DUE", size: 10, bold: true });
    text({
      x: boxX + 12,
      y: y - 11,
      text: `${trips} trips at ${money(invoice.rateCents)}`,
      size: 8,
      grey: 0.45,
    });
    text({ x: RIGHT - 12, y: y - 2, text: money(invoice.totalCents), size: 15, bold: true, align: "right" });

    /*
     * What a draft is still waiting for.
     *
     * A month with four days entered has a great deal of empty paper below the total, and empty
     * paper on an invoice reads as a document that stopped rather than one that finished. This is
     * the one thing worth saying in that space, and it is the whole reason a draft exists: how
     * much of the month is in, and what happens when the rest is.
     */
    if (draft) {
      const total = weekdaysIn(invoice.month).length;
      const left = Math.max(0, total - lines.length);
      y -= 44;
      text({
        x: M,
        y,
        text: `${lines.length} of the ${total} weekdays in ${monthLabel(invoice.month)} have been entered.`,
        size: 9.5,
        grey: 0.35,
      });
      y -= 12;
      text({
        x: M,
        y,
        text:
          left === 0
            ? "The month is complete. The invoice is issued, numbered and sent as soon as it is closed."
            : `The remaining ${left} ${left === 1 ? "day is" : "days are"} still to come. The invoice is numbered and sent on its own once the last weekday is entered.`,
        size: 9.5,
        grey: 0.35,
      });
    }

    foot(index + 1, pageCount);
  });

  pages.push(page);

  return drawnPdf(
    draft
      ? `Delivery invoice DRAFT — ${monthLabel(invoice.month)}`
      : `Delivery invoice ${invoice.invoiceNumber} — ${monthLabel(invoice.month)}`,
    pages,
  );
}

/** How many rows fit between a table top and a given floor. */
function roomFor(top: number, floor: number): number {
  return Math.max(1, Math.floor((top - floor) / ROW_H) + 1);
}

/**
 * How the day rows are split across sheets.
 *
 * Exported because it is the part with an off-by-one in it and no way to see the mistake by
 * looking at the page: a month that fits gets one sheet, and a month that does not must never put
 * the totals somewhere they can be missed.
 */
export function paginate(count: number, firstTableTop: number, continuedTableTop: number): number[] {
  if (count <= 0) return [0];
  const sizes: number[] = [];
  let left = count;
  let top = firstTableTop;
  while (left > 0) {
    // Everything left fits on a sheet that also carries the totals: this is the last one.
    if (left <= roomFor(top, LAST_PAGE_FLOOR)) {
      sizes.push(left);
      break;
    }
    /*
     * At least one row must be left over.
     *
     * A page that continues overleaf has room for more rows than the last page does, because the
     * last page also carries the totals. Taking everything that fits here would leave a final page
     * with nothing on it — so the totals would be drawn on this one, below the floor they were
     * measured against, and off the bottom of the sheet.
     */
    const take = Math.min(left - 1, roomFor(top, CONTINUED_FLOOR));
    sizes.push(take);
    left -= take;
    top = continuedTableTop;
  }

  /*
   * No orphan last page.
   *
   * Filling each sheet to the brim leaves the remainder alone on the final one — a page carrying
   * one day and the totals looks like a mistake, and invites the reader to wonder whether the rest
   * is missing. Moving a few rows forward costs nothing and the split reads as deliberate.
   */
  for (let i = sizes.length - 1; i >= 1; i--) {
    while (sizes[i] < 5 && sizes[i - 1] > sizes[i] + 1) {
      sizes[i - 1] -= 1;
      sizes[i] += 1;
    }
  }
  return sizes;
}

/** Cuts a note to the width it has, with an ellipsis, rather than letting it run into the figures. */
export function fit(note: string, size: number, width: number): string {
  const clean = note.replace(/\s+/g, " ").trim();
  if (width <= 0) return "";
  if (textWidth(clean, size) <= width) return clean;
  let out = clean;
  while (out.length > 1 && textWidth(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

function dayName(iso: string): string {
  return DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()] ?? "";
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
