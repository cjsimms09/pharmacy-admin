import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { learnCadence, datesDrawnOn, type SettledDraw } from "../src/lib/draw-cadence";

/**
 * IPC's two settled draws, as they actually were.
 *
 * The draw of 9 September was the invoices of 2 September; the draw of the 10th was those of the
 * 3rd. Seven days, one day of billing at a time. Both were proved by exact sums before any cadence
 * existed, which is what makes them evidence rather than assumption.
 */
const IPC: SettledDraw[] = [
  { on: "2026-09-09", invoiceDates: ["2026-09-02", "2026-09-02"] },
  { on: "2026-09-10", invoiceDates: ["2026-09-03", "2026-09-03"] },
];

describe("learning how a supplier collects", () => {
  test("IPC's real draws come out at seven days, one day of billing at a time", () => {
    const c = learnCadence(IPC);
    assert.ok(c);
    assert.equal(c.lagDays, 7);
    assert.equal(c.spanDays, 1);
    assert.equal(c.from, 2);
    assert.match(c.says, /Draws 7 days after billing, covering a single day/);
    assert.match(c.says, /not assumed/);
  });

  test("a weekly biller drawing a week at a time is read as span seven", () => {
    const c = learnCadence([
      { on: "2026-09-08", invoiceDates: ["2026-09-01", "2026-09-04", "2026-09-07"] },
      { on: "2026-09-15", invoiceDates: ["2026-09-08", "2026-09-11", "2026-09-14"] },
    ]);
    assert.ok(c);
    assert.equal(c.lagDays, 1);
    assert.equal(c.spanDays, 7);
  });

  test("the lag is measured from the LAST invoice, because a period is collected once it has closed", () => {
    const c = learnCadence([
      { on: "2026-09-20", invoiceDates: ["2026-09-01", "2026-09-15"] },
      { on: "2026-10-20", invoiceDates: ["2026-10-01", "2026-10-15"] },
    ]);
    assert.ok(c);
    assert.equal(c.lagDays, 5);
  });

  test("the commonest lag wins where a draw ran late", () => {
    const c = learnCadence([
      { on: "2026-09-09", invoiceDates: ["2026-09-02"] },
      { on: "2026-09-10", invoiceDates: ["2026-09-03"] },
      { on: "2026-09-18", invoiceDates: ["2026-09-04"] },
    ]);
    assert.ok(c);
    assert.equal(c.lagDays, 7);
    assert.equal(c.from, 2);
  });
});

describe("what it refuses to claim", () => {
  /*
   * One confirmation is a coincidence. A single seven-day gap between one debit and one day's
   * billing is exactly what a fortnightly biller looks like on its first payment.
   */
  test("one settled draw teaches nothing", () => {
    assert.equal(learnCadence([IPC[0]]), null);
  });

  test("two draws that disagree teach nothing", () => {
    assert.equal(
      learnCadence([
        { on: "2026-09-09", invoiceDates: ["2026-09-02"] },
        { on: "2026-09-20", invoiceDates: ["2026-09-03"] },
      ]),
      null,
    );
  });

  test("a draw with no invoices behind it is not evidence", () => {
    assert.equal(learnCadence([{ on: "2026-09-09", invoiceDates: [] }, IPC[1]]), null);
  });

  test("nothing settled teaches nothing", () => {
    assert.equal(learnCadence([]), null);
  });
});

describe("using the cadence instead of searching", () => {
  test("it names the days a draw should be settling", () => {
    const c = learnCadence(IPC)!;
    assert.deepEqual(datesDrawnOn(c, "2026-09-11"), ["2026-09-04"]);
  });

  test("a weekly span names the whole week, oldest first", () => {
    const c = learnCadence([
      { on: "2026-09-08", invoiceDates: ["2026-09-01", "2026-09-07"] },
      { on: "2026-09-15", invoiceDates: ["2026-09-08", "2026-09-14"] },
    ])!;
    assert.equal(c.spanDays, 7);
    assert.deepEqual(datesDrawnOn(c, "2026-09-22"), [
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
      "2026-09-21",
    ]);
  });
});
