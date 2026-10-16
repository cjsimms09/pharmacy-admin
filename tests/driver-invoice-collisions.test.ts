import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { invoicePdf, type Parties } from "../src/lib/driver-invoice-pdf";
import { weekdaysIn, type DriverInvoice, type InvoiceLine } from "../src/lib/deliveries";

/**
 * Nothing on the invoice is printed on top of anything else, or past the edge of the paper.
 *
 * The generator draws every block at an absolute position, and a position on top of another block
 * is drawn exactly as happily as one beside it. Its own header says so — "it must never run off the
 * edge" — and it was written after a closing sentence ran off the sheet. It happened again on the
 * September 2026 draft, and this time twice over: the note saying how much of the month was in ran
 * 39 points into the right margin, and printed "The remaining 1 day is still to come…" straight
 * across "Payment by check made payable to Madison Simms", 235 points of one sentence on another.
 *
 * Neither could be seen from the code, and neither could be seen from the PDF's text either —
 * extraction returns the runs in the order they were written, so two sentences printed in one place
 * come back looking like two ordinary sentences. The only way to know is to measure the page.
 *
 * So this builds the real document and reads its own content stream back. It is the check that the
 * eye would do, done on every month, including the ones nobody will look at until they break.
 */

/* Helvetica's cap box, a little tighter than the font's true extents: what a reader sees as a line. */
const ASC = 0.7;
const DESC = 0.2;
const PAGE_W = 612;

/** The same width model the generator lays out with, so this measures what it measured. */
function widthOf(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[A-Z0-9@#%&]/.test(ch) ? 0.62 : /[ilj.,:;'!|]/.test(ch) ? 0.28 : 0.52;
  return w * size;
}

type Box = { x0: number; x1: number; y0: number; y1: number; text: string };

/** Every page's text, as boxes, one array per sheet. Sheets are separate: they share a coordinate system. */
function sheetsOf(pdf: Buffer): Box[][] {
  const raw = pdf.toString("latin1");
  const out: Box[][] = [];
  const run = /BT\s+([\d.]+)\s+g\s+\/(F\d+)\s+([\d.]+)\s+Tf\s+1 0 0 1 ([-\d.]+) ([-\d.]+) Tm \((.*?)\) Tj ET/g;
  let at = 0;
  for (;;) {
    const s = raw.indexOf("stream", at);
    if (s < 0) break;
    const e = raw.indexOf("endstream", s);
    if (e < 0) break;
    let from = s + "stream".length;
    if (raw[from] === "\r") from++;
    if (raw[from] === "\n") from++;
    const body = pdf.subarray(Buffer.byteLength(raw.slice(0, from), "latin1"), Buffer.byteLength(raw.slice(0, e), "latin1"));
    let stream: string;
    try {
      stream = inflateSync(body).toString("latin1");
    } catch {
      stream = body.toString("latin1");
    }
    const boxes: Box[] = [];
    run.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = run.exec(stream))) {
      const text = m[6].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
      if (!text.trim()) continue;
      const size = Number(m[3]);
      const x = Number(m[4]);
      const y = Number(m[5]);
      boxes.push({ x0: x, x1: x + widthOf(text, size), y0: y - DESC * size, y1: y + ASC * size, text });
    }
    if (boxes.length > 0) out.push(boxes);
    at = e + 1;
  }
  return out;
}

const PARTIES: Parties = {
  driverName: "Alex Driver",
  billToName: "Example Family Pharmacy",
  forWhom: "Example Family Pharmacy",
  terms: "Payment by check made payable to Alex Driver",
  pharmacyLines: ["1 Example Street", "Exampleville, KS 60000", "555-000-0000"],
};

function invoiceFor(month: string, entered: number, draft: boolean): { invoice: DriverInvoice; lines: InvoiceLine[] } {
  const days = weekdaysIn(month).slice(0, entered);
  const lines: InvoiceLine[] = days.map((onDate, i) => {
    /* One closed day with a reason on it, because that row is laid out differently from the rest. */
    if (i === 4) return { onDate, deliveries: 0, mailTrips: 0, trips: 0, amountCents: 0, note: "Closed" };
    const deliveries = 3 + (i % 10);
    const mailTrips = 1;
    const trips = deliveries + mailTrips;
    return { onDate, deliveries, mailTrips, trips, amountCents: trips * 900, note: null };
  });
  const deliveries = lines.reduce((n, l) => n + l.deliveries, 0);
  const mailTrips = lines.reduce((n, l) => n + l.mailTrips, 0);
  const invoice = {
    id: "test",
    month,
    invoiceNumber: draft ? "DRAFT" : "WWFP-0001",
    driverName: PARTIES.driverName,
    rateCents: 900,
    deliveries,
    mailTrips,
    totalCents: lines.reduce((n, l) => n + l.amountCents, 0),
    linesJson: JSON.stringify(lines),
    status: draft ? "draft" : "issued",
    sentTo: null,
    sentAt: null,
    sendError: null,
    documentId: null,
    issuedBy: "test",
    createdAt: `${month}-29T12:00:00.000Z`,
  } as DriverInvoice;
  return { invoice, lines };
}

function faultsIn(pdf: Buffer): string[] {
  const faults: string[] = [];
  for (const [i, boxes] of sheetsOf(pdf).entries()) {
    /* Read from the page rather than assumed: the leftmost run is the margin it was laid out to. */
    const M = Math.min(...boxes.map((b) => b.x0));
    const RIGHT = PAGE_W - M;
    for (const b of boxes) {
      if (b.x1 > RIGHT + 1) faults.push(`page ${i + 1}: "${b.text}" runs ${(b.x1 - RIGHT).toFixed(1)}pt past the right margin`);
      if (b.y0 < 20) faults.push(`page ${i + 1}: "${b.text}" is off the bottom of the sheet`);
    }
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const dx = Math.min(boxes[a].x1, boxes[b].x1) - Math.max(boxes[a].x0, boxes[b].x0);
        const dy = Math.min(boxes[a].y1, boxes[b].y1) - Math.max(boxes[a].y0, boxes[b].y0);
        if (dx > 0.5 && dy > 0.5) faults.push(`page ${i + 1}: "${boxes[a].text}" and "${boxes[b].text}" overlap by ${dx.toFixed(1)}x${dy.toFixed(1)}pt`);
      }
    }
  }
  return faults;
}

describe("nothing on the invoice is printed on top of anything else", () => {
  /*
   * Every month of a year, at every stage of being filled in.
   *
   * The fault that shipped needed a month nearly complete — a short month left plenty of blank
   * paper and looked perfect — so testing one convenient case is how it got out. The empty month
   * and the one-day month are here for the opposite reason: the blocks that anchor to the foot
   * have the most room to reach the wrong way when there is nothing between them.
   */
  const MONTHS = ["2026-01", "2026-02", "2026-05", "2026-08", "2026-09", "2026-10", "2026-12"];

  test("a draft, at every stage of the month", () => {
    for (const month of MONTHS) {
      const total = weekdaysIn(month).length;
      for (const entered of [0, 1, 2, 5, total - 2, total - 1, total]) {
        if (entered < 0) continue;
        const { invoice, lines } = invoiceFor(month, entered, true);
        const faults = faultsIn(invoicePdf(invoice, lines, PARTIES));
        assert.deepEqual(faults, [], `${month} draft, ${entered} of ${total} days`);
      }
    }
  });

  test("an issued invoice, for a whole month", () => {
    for (const month of MONTHS) {
      const total = weekdaysIn(month).length;
      const { invoice, lines } = invoiceFor(month, total, false);
      assert.deepEqual(faultsIn(invoicePdf(invoice, lines, PARTIES)), [], `${month} issued`);
    }
  });

  /*
   * A full month's draft stays on one sheet.
   *
   * Reserving vertical room for the draft note is the obvious fix for the collision and it costs a
   * page: September fills the sheet exactly, so any height kept free below the total carries the
   * last rows overleaf, and the draft of a month that has just ended arrives two pages long while
   * the invoice issued from it is one. That is why the note sits beside the total instead.
   */
  test("a draft with every day but the last on it is still one sheet", () => {
    const total = weekdaysIn("2026-09").length;
    const { invoice, lines } = invoiceFor("2026-09", total - 1, true);
    assert.equal(sheetsOf(invoicePdf(invoice, lines, PARTIES)).length, 1, `${total - 1} of ${total} days`);
  });

  /* A long name is the other way text reaches where it should not. */
  test("a long driver and a long pharmacy name do not push anything into anything else", () => {
    const { invoice, lines } = invoiceFor("2026-09", 21, true);
    const faults = faultsIn(
      invoicePdf({ ...invoice, driverName: "Bartholomew Fitzwilliam-Harrington" }, lines, {
        ...PARTIES,
        driverName: "Bartholomew Fitzwilliam-Harrington",
        billToName: "Example Family Physicians and Associates, PA",
        forWhom: "Example Family Pharmacy of Greater Exampleville",
        terms: "Payment by check made payable to Bartholomew Fitzwilliam-Harrington, or by bank transfer on request to the pharmacy",
      }),
    );
    assert.deepEqual(faults, []);
  });
});
