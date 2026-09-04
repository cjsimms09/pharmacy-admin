import { drawnPdf, PAGE, type Draw } from "./pdf";
import { monthLabel, money, type InvoiceLine, type DriverInvoice } from "./deliveries";

/**
 * The invoice as the person paying it sees it.
 *
 * This is the only part of this system anybody outside the pharmacy ever looks at. It arrives in
 * an accounts inbox alongside invoices from companies with design departments, and it is read by
 * somebody who has never heard of this software — so the entire impression it makes is the page
 * itself. The spreadsheet it replaces had the total in a cell marked #REF!, which is the kind of
 * thing that gets an invoice queried rather than paid.
 *
 * Laid out to be read in the order the reader needs: what it is and what it costs at the top,
 * who owes whom next, the day-by-day working underneath for anyone who wants to check it, and how
 * to pay at the bottom. Every date the driver worked is listed, including the days he did not,
 * because a month with gaps in it invites the question "what about the 14th?" and the answer
 * should already be on the page.
 */

const { width: W, margin: M } = PAGE;
const RIGHT = W - M;

/** Column positions, set once so the headings and the figures cannot drift apart. */
const COL = {
  date: M,
  day: M + 96,
  deliveries: M + 250,
  mail: M + 330,
  trips: M + 400,
  amount: RIGHT,
};

export type Parties = {
  driverName: string;
  billToName: string;
  forWhom: string;
  terms: string;
};

export function invoicePdf(invoice: DriverInvoice, lines: InvoiceLine[], parties: Parties): Buffer {
  const page: Draw[] = [];
  const text = (d: Omit<Extract<Draw, { kind: "text" }>, "kind">) => page.push({ kind: "text", ...d });
  const rule = (y: number, opts: { x1?: number; x2?: number; weight?: number; grey?: number } = {}) =>
    page.push({ kind: "rule", x1: opts.x1 ?? M, x2: opts.x2 ?? RIGHT, y, weight: opts.weight, grey: opts.grey });

  let y = PAGE.height - M;

  // ── Masthead ─────────────────────────────────────────────────────
  text({ x: M, y, text: "INVOICE", size: 26, bold: true });
  text({ x: RIGHT, y: y + 12, text: `No. ${invoice.invoiceNumber}`, size: 11, bold: true, align: "right" });
  text({ x: RIGHT, y, text: monthLabel(invoice.month), size: 11, align: "right", grey: 0.35 });
  y -= 12;
  text({
    x: RIGHT,
    y,
    text: `Issued ${longDate(invoice.createdAt.slice(0, 10))}`,
    size: 9,
    align: "right",
    grey: 0.45,
  });

  y -= 14;
  rule(y, { weight: 1.4 });
  y -= 26;

  // ── Who, and how much ────────────────────────────────────────────
  // The amount goes at the top as well as the bottom. An accounts department sorts by amount
  // before it reads anything, and making somebody hunt for the figure is how an invoice ends up
  // at the bottom of the pile.
  text({ x: M, y, text: "FROM", size: 8, bold: true, grey: 0.45 });
  text({ x: M + 200, y, text: "BILL TO", size: 8, bold: true, grey: 0.45 });
  text({ x: RIGHT, y, text: "AMOUNT DUE", size: 8, bold: true, grey: 0.45, align: "right" });
  y -= 15;

  text({ x: M, y, text: parties.driverName, size: 12, bold: true });
  text({ x: M + 200, y, text: parties.billToName, size: 12, bold: true });
  text({ x: RIGHT, y: y - 4, text: money(invoice.totalCents), size: 20, bold: true, align: "right" });
  y -= 14;

  text({ x: M, y, text: `Delivery driver for ${parties.forWhom}`, size: 9, grey: 0.35 });
  y -= 30;

  text({
    x: M,
    y,
    text: `Prescription deliveries and daily mail runs for ${parties.forWhom}, ${monthLabel(invoice.month)}.`,
    size: 10,
  });
  y -= 12;
  text({
    x: M,
    y,
    text: `${invoice.deliveries} deliveries and ${invoice.mailTrips} mail trips, ${invoice.deliveries + invoice.mailTrips} trips in total at ${money(invoice.rateCents)} each.`,
    size: 10,
    grey: 0.3,
  });

  y -= 28;

  // ── The working ──────────────────────────────────────────────────
  page.push({ kind: "rect", x: M, y: y - 5, w: RIGHT - M, h: 17, grey: 0.93 });
  const head = y + 2;
  text({ x: COL.date, y: head, text: "DATE", size: 8, bold: true, grey: 0.3 });
  text({ x: COL.day, y: head, text: "DAY", size: 8, bold: true, grey: 0.3 });
  text({ x: COL.deliveries, y: head, text: "DELIVERIES", size: 8, bold: true, grey: 0.3, align: "right" });
  text({ x: COL.mail, y: head, text: "MAIL", size: 8, bold: true, grey: 0.3, align: "right" });
  text({ x: COL.trips, y: head, text: "TRIPS", size: 8, bold: true, grey: 0.3, align: "right" });
  text({ x: COL.amount, y: head, text: "AMOUNT", size: 8, bold: true, grey: 0.3, align: "right" });
  y -= 20;

  for (const line of lines) {
    const zero = line.trips === 0;
    text({ x: COL.date, y, text: shortDate(line.onDate), size: 9.5, grey: zero ? 0.5 : 0 });
    text({ x: COL.day, y, text: dayName(line.onDate), size: 9.5, grey: zero ? 0.5 : 0.35 });
    text({ x: COL.deliveries, y, text: String(line.deliveries), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
    text({ x: COL.mail, y, text: String(line.mailTrips), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
    text({ x: COL.trips, y, text: String(line.trips), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
    text({ x: COL.amount, y, text: money(line.amountCents), size: 9.5, align: "right", grey: zero ? 0.5 : 0 });
    // A day with nothing on it says why, on the day it happened, rather than leaving a gap the
    // reader has to ask about.
    if (zero && line.note) {
      text({ x: COL.day + 60, y, text: line.note.slice(0, 40), size: 8.5, grey: 0.5 });
    }
    y -= 14;
  }

  y -= 4;
  rule(y, { x1: COL.deliveries - 60, weight: 1 });
  y -= 16;

  text({ x: COL.date, y, text: "Total deliveries and mail trips", size: 10, bold: true });
  text({ x: COL.deliveries, y, text: String(invoice.deliveries), size: 10, bold: true, align: "right" });
  text({ x: COL.mail, y, text: String(invoice.mailTrips), size: 10, bold: true, align: "right" });
  text({ x: COL.trips, y, text: String(invoice.deliveries + invoice.mailTrips), size: 10, bold: true, align: "right" });
  text({ x: COL.amount, y, text: money(invoice.totalCents), size: 10, bold: true, align: "right" });

  y -= 26;
  page.push({ kind: "rect", x: COL.deliveries - 60, y: y - 8, w: RIGHT - (COL.deliveries - 60), h: 26, grey: 0.93 });
  text({ x: COL.deliveries - 48, y, text: "AMOUNT DUE", size: 10, bold: true });
  text({ x: RIGHT - 12, y: y - 1, text: money(invoice.totalCents), size: 14, bold: true, align: "right" });

  // ── How to pay ───────────────────────────────────────────────────
  y -= 44;
  rule(y, { grey: 0.75 });
  y -= 16;
  text({ x: M, y, text: "PAYMENT", size: 8, bold: true, grey: 0.45 });
  y -= 14;
  text({ x: M, y, text: parties.terms, size: 10 });
  y -= 22;
  text({
    x: M,
    y,
    text: `Raised by ${parties.forWhom} on behalf of ${parties.driverName}. Questions about any day on this invoice can be answered from the pharmacy's own record.`,
    size: 8.5,
    grey: 0.45,
  });

  return drawnPdf(`Delivery invoice ${invoice.invoiceNumber} — ${monthLabel(invoice.month)}`, [page]);
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
