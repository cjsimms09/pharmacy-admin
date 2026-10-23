import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { wholesalerHolidays, weekdaysWithoutInvoices, judgePurchases, listDays } from "../src/lib/wholesaler-purchases";

/*
 * McKesson's own September 2026 net purchases were $594,870.80 and the site held $452,478.24 of its invoices, because the invoices for
 * 1 to 8 September and the 14th were never captured and nothing compared the two. Every amount below is invented.
 */
describe("the days a wholesaler does not deliver", () => {
  test("holidays are found and the observed day is used where one falls on a weekend", () => {
    const h = wholesalerHolidays(2026);
    assert.ok(h.has("2026-09-07"), "Labor Day, the first Monday of September");
    assert.ok(h.has("2026-11-26"), "Thanksgiving, the fourth Thursday");
    assert.ok(h.has("2026-05-25"), "Memorial Day, the last Monday of May");
    assert.ok(h.has("2026-12-25"), "Christmas on a Friday");
    assert.ok(h.has("2026-07-03"), "4 July is a Saturday, so Friday the 3rd is observed");
    assert.ok(!h.has("2026-07-04"));
  });
});

describe("weekdays with no invoice", () => {
  const all = (month: string) => {
    const out: string[] = [];
    for (let d = 1; d <= 30; d++) out.push(`${month}-${String(d).padStart(2, "0")}`);
    return out;
  };

  test("a month with an invoice on every weekday has none missing", () => {
    assert.deepEqual(weekdaysWithoutInvoices("2026-09", all("2026-09")), []);
  });

  test("the missing weekdays are named, weekends and holidays are not", () => {
    const have = all("2026-09").filter((d) => !["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08", "2026-09-14"].includes(d));
    assert.deepEqual(weekdaysWithoutInvoices("2026-09", have), ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08", "2026-09-14"]);
  });

  test("Labor Day with no invoice is not missing", () => {
    const have = all("2026-09").filter((d) => d !== "2026-09-07");
    assert.deepEqual(weekdaysWithoutInvoices("2026-09", have), []);
  });

  test("a month still running is only judged up to the day given", () => {
    assert.deepEqual(weekdaysWithoutInvoices("2026-10", [], "2026-10-02"), ["2026-10-01", "2026-10-02"]);
  });

  test("days read aloud", () => {
    assert.equal(listDays(["2026-09-01", "2026-09-02", "2026-09-08"]), "1, 2 and 8");
    assert.equal(listDays(["2026-09-14"]), "14");
  });
});

describe("the wholesaler's figure against PioneerRx's receiving record", () => {
  const base = { month: "2026-09", wholesaler: "McKesson", missingDays: [] as string[], returnsCents: 0 };

  test("September's real shape agrees: receipts less returns come within 2 percent of McKesson's net purchases", () => {
    /* $623,894.42 received, $17,745.41 returned, against a statement of $594,870.80: the difference is 1.9 percent. */
    const j = judgePurchases({ ...base, statementCents: 59_487_080, receivedCents: 62_389_442, returnsCents: 1_774_541 });
    assert.equal(j.agrees, true);
    assert.equal(j.gapCents, -1_127_821);
    assert.ok(j.says.includes("PioneerRx recorded receiving $623,894.42 from McKesson in 2026-09, less $17,745.41 returned, $606,149.01"), j.says);
  });

  test("a large shortfall in the receiving record is a disagreement, and names the days with no delivery recorded", () => {
    const j = judgePurchases({ ...base, missingDays: ["2026-09-01", "2026-09-02", "2026-09-14"], statementCents: 59_487_080, receivedCents: 45_247_824 });
    assert.equal(j.agrees, false);
    assert.equal(j.gapCents, 14_239_256);
    assert.ok(j.says.includes("(24%) short"), j.says);
    assert.match(j.says, /PioneerRx has no McKesson receipt on 1, 2 and 14 Sep/);
    assert.match(j.says, /receive those deliveries into PioneerRx/);
  });

  test("rounding and timing are not a disagreement", () => {
    assert.equal(judgePurchases({ ...base, statementCents: 59_487_080, receivedCents: 59_000_000 }).agrees, true);
    assert.equal(judgePurchases({ ...base, statementCents: 59_487_080, receivedCents: 59_487_000 }).agrees, true);
  });

  test("a shortfall with a receipt on every weekday is said differently, and more received than bought is a double receipt", () => {
    assert.match(judgePurchases({ ...base, statementCents: 50_000_000, receivedCents: 40_000_000 }).says, /for every weekday/);
    const over = judgePurchases({ ...base, statementCents: 50_000_000, receivedCents: 60_000_000 });
    assert.equal(over.agrees, false);
    assert.match(over.says, /received twice/);
  });
});
