import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { returnsDue, stepAt, daysFrom, worthOf, actNow } from "../src/lib/returns-due";
import type { ReturnTermsT } from "../src/lib/supplier-terms";

/**
 * "Only ten days left to return this bottle to IPC."
 *
 * The clock runs from the invoice date. McKesson's real policy: a standard customer return raised
 * within 0-30 days of the invoice is credited 100%, and 31 days or more, 75%.
 */
const mckesson: ReturnTermsT = {
  windowMonthsBeforeExpiry: 6,
  windowMonthsAfterExpiry: null,
  creditSteps: [],
  creditStepsFromInvoice: [
    { withinDays: 30, creditPercent: 100 },
    { withinDays: null, creditPercent: 75 },
  ],
  returnableWithinDaysOfInvoice: null,
  restockingFeePercent: null,
  nonReturnable: ["partial bottles"],
  reverseDistributor: null,
  notes: null,
};

const ipc: ReturnTermsT = {
  ...mckesson,
  creditStepsFromInvoice: [{ withinDays: 60, creditPercent: 100 }],
  returnableWithinDaysOfInvoice: 90,
  restockingFeePercent: 5,
};

const line = (over: Partial<Parameters<typeof returnsDue>[0]["lines"][number]> = {}) => ({
  ndc11: "00093721698",
  description: "AMLODIPINE 5MG TAB 90",
  supplier: "McKesson",
  supplierId: "mck",
  invoiceId: "inv1",
  invoiceNumber: "7656147106",
  invoiceDate: "2026-08-20",
  quantity: 2,
  extendedCents: 4400,
  ...over,
});

const terms = new Map<string, ReturnTermsT>([["mck", mckesson], ["ipc", ipc]]);

describe("when a bottle has to go back", () => {
  test("counts from the invoice, and says how long the full credit lasts", () => {
    const [r] = returnsDue({ lines: [line()], termsBySupplierId: terms, claims: [], today: "2026-09-05" });
    assert.equal(r.daysSinceInvoice, 16);
    assert.equal(r.creditPercentNow, 100);
    assert.equal(r.creditNowCents, 4400);
    assert.equal(r.dropsInDays, 15, "day 31 is the first day at the lower rate");
    assert.equal(r.dropsToPercent, 75);
    assert.match(r.says, /15 days left before the credit drops to 75%/);
  });

  test("the ten-days-left case reads as one sentence", () => {
    const [r] = returnsDue({ lines: [line({ supplier: "IPC", supplierId: "ipc", invoiceDate: "2026-07-27" })], termsBySupplierId: terms, claims: [], today: "2026-09-05" });
    // 40 days in on a 60-day full-credit window, with the whole thing shutting at 90 days.
    assert.equal(r.daysSinceInvoice, 40);
    assert.equal(r.creditPercentNow, 95, "IPC charges a 5% restocking fee, so 100% credit is 95% back");
    assert.equal(r.dropsInDays, null, "no lower step — after 60 days it simply cannot go back");
    assert.equal(r.closesInDays, 50);
    assert.match(r.says, /50 days left before it cannot go back at all/);
  });

  test("past the first window, the lower rate is what it is worth", () => {
    const [r] = returnsDue({ lines: [line({ invoiceDate: "2026-06-01" })], termsBySupplierId: terms, claims: [], today: "2026-09-05" });
    assert.equal(r.creditPercentNow, 75);
    assert.equal(r.creditNowCents, 3300);
    assert.equal(r.dropsInDays, null);
    assert.equal(r.urgency, "later");
  });

  test("a window that has shut is not offered at all", () => {
    const rows = returnsDue({ lines: [line({ supplier: "IPC", supplierId: "ipc", invoiceDate: "2026-05-01" })], termsBySupplierId: terms, claims: [], today: "2026-09-05" });
    assert.deepEqual(rows, [], "127 days on a 90-day deadline: there is nothing to say");
  });

  test("no policy on file means nothing is said — never a guessed window", () => {
    // The failure this prevents: a return raised outside a window the site invented is a return
    // refused, with the pharmacy holding stock it was told to send back.
    const rows = returnsDue({ lines: [line({ supplierId: "unknown-supplier" })], termsBySupplierId: terms, claims: [], today: "2026-09-05" });
    assert.deepEqual(rows, []);
  });

  test("it knows whether the drug has moved since it arrived", () => {
    const claims = [
      { ndc11: "00093721698", quantityThousandths: 90_000, dateFilled: "2026-08-01", status: "paid" },
      { ndc11: "00093721698", quantityThousandths: 30_000, dateFilled: "2026-08-25", status: "paid" },
    ];
    const [r] = returnsDue({ lines: [line()], termsBySupplierId: terms, claims, today: "2026-09-05" });
    assert.equal(r.dispensedSince, 30, "only the fill after the invoice counts — the earlier one came off another bottle");
    assert.match(r.says, /30 units dispensed since it arrived/);
  });

  test("a reversal does not count as a dispensing", () => {
    const claims = [{ ndc11: "00093721698", quantityThousandths: 30_000, dateFilled: "2026-08-25", status: "reversed" }];
    const [r] = returnsDue({ lines: [line()], termsBySupplierId: terms, claims, today: "2026-09-05" });
    assert.equal(r.dispensedSince, 0);
    assert.match(r.says, /Nothing has been dispensed/);
  });

  test("the soonest deadline comes first, not the biggest number", () => {
    const rows = returnsDue({
      lines: [
        line({ ndc11: "1", description: "big, three weeks left", extendedCents: 50_000, invoiceDate: "2026-08-15" }),
        line({ ndc11: "2", description: "small, drops tomorrow", extendedCents: 1_200, invoiceDate: "2026-08-06" }),
      ],
      termsBySupplierId: terms,
      claims: [],
      today: "2026-09-05",
    });
    assert.equal(rows[0].ndc11, "2");
    assert.equal(rows[0].dropsInDays, 1);
    assert.equal(rows[1].dropsInDays, 10);
  });

  test("what the whole list is worth, at today's rates rather than at full price", () => {
    const rows = returnsDue({
      lines: [line({ ndc11: "1", invoiceDate: "2026-08-27" }), line({ ndc11: "2", invoiceDate: "2026-08-01" })],
      termsBySupplierId: terms,
      claims: [],
      today: "2026-09-05",
    });
    // Nine days in, so still 100%; thirty-five days in, so already down to 75%.
    assert.equal(worthOf(rows), 4400 + 3300);
  });

  test("what to act on is what is about to change and has not moved", () => {
    const rows = returnsDue({
      lines: [
        line({ ndc11: "1", invoiceDate: "2026-08-10" }), // 26 days in: full credit ends in 5
        line({ ndc11: "2", invoiceDate: "2026-08-09" }), // 27 days in, but it has been dispensed
      ],
      termsBySupplierId: terms,
      claims: [{ ndc11: "2", quantityThousandths: 5_000, dateFilled: "2026-08-30", status: "paid" }],
      today: "2026-09-05",
    });
    const now = actNow(rows);
    assert.deepEqual(now.map((r) => r.ndc11), ["1"], "the one that has moved is not put up as a return");
    assert.equal(now[0].dropsInDays, 5);
  });
});

describe("the arithmetic underneath", () => {
  test("days between two dates", () => {
    assert.equal(daysFrom("2026-08-20", "2026-09-05"), 16);
    assert.equal(daysFrom("2026-09-05", "2026-09-05"), 0);
  });

  test("a policy with no invoice-date steps settles nothing", () => {
    assert.equal(stepAt({ ...mckesson, creditStepsFromInvoice: [] }, 5), null);
  });

  test("the open-ended final step applies once every window is passed", () => {
    assert.deepEqual(stepAt(mckesson, 200), { now: 75, next: null });
  });
});
