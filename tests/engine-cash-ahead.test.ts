import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { monthlyDays, projectStanding, projectFixed, projectSuppliers, projectClaims, projectTakings, projectFutureFills, buildDays, weekday } from "../src/lib/engine/cash-ahead";

describe("cash ahead, the pure parts", () => {
  test("a monthly day falls once a month inside the window, clamped to short months", () => {
    assert.deepEqual(monthlyDays(30, "2026-02-10", "2026-04-05"), ["2026-02-28", "2026-03-30"]);
    assert.deepEqual(monthlyDays(4, "2026-10-01", "2026-10-29"), ["2026-10-04"]);
  });

  test("standing costs land on their paid day, and not before their first month or after their last", () => {
    const flows = projectStanding([{ name: "Rent", amountCents: 262_500, paidDay: 4, fromMonth: "2026-09", toMonth: null }, { name: "Old lease", amountCents: 100_00, paidDay: 4, fromMonth: "2026-01", toMonth: "2026-09" }], "2026-10-01", "2026-10-29");
    assert.deepEqual(flows.map((f) => [f.day, f.label, f.cents]), [["2026-10-04", "Rent", 262_500]]);
  });

  test("last month's fixed debits repeat on the same day of the month", () => {
    const flows = projectFixed([{ on: "2026-09-15", amountCents: -794_932, label: "the loan" }], "2026-10-01", "2026-10-29");
    assert.deepEqual(flows.map((f) => [f.day, f.cents, f.kind]), [["2026-10-15", 794_932, "out"]]);
  });

  test("a wholesaler's weekday average is per occurrence of the weekday in the window: one draw in a month is a quarter of a draw a week", () => {
    /* Three Tuesdays of draws in a September window that holds five Tuesdays: the Tuesday average is a fifth of the sum. */
    const history = [
      { on: "2026-09-08", amountCents: -300_00, counterparty: "IPC" },
      { on: "2026-09-15", amountCents: -600_00, counterparty: "IPC" },
      { on: "2026-09-22", amountCents: -600_00, counterparty: "IPC" },
      { on: "2026-09-11", amountCents: -1_191_362, counterparty: "Anda" },
    ];
    const flows = projectSuppliers(history, { from: "2026-09-01", to: "2026-09-30" }, "2026-10-05", "2026-10-11");
    assert.deepEqual(flows.map((f) => [f.day, f.label, f.cents]).sort(), [
      ["2026-10-06", "IPC (average)", 300_00],
      ["2026-10-09", "Anda (average)", 297_841],
    ]);
    assert.equal(weekday("2026-10-06"), 2);
  });

  test("an unpaid claim arrives on its payer's typical day; one already past it arrives tomorrow; a programme on its own cycle", () => {
    const cycles = new Map([["OptumRx", { p50: 13, p90: 20, n: 549 }], ["Tiny", { p50: 5, p90: 9, n: 2 }]]);
    const flows = projectClaims(
      [
        { payer: "OptumRx", cents: 100_00, filled: "2026-09-25" },
        { payer: "OptumRx", cents: 50_00, filled: "2026-09-01" },
        { payer: "OptumRx", cents: 25_00, filled: "2026-09-16" },
        { payer: "Tiny", cents: 10_00, filled: "2026-09-28" },
        { payer: "DST Pharmacy Solutions", cents: 988_00, filled: "2026-09-10", programmeCycleDays: 60 },
      ],
      cycles,
      "2026-10-02",
      "2026-11-30",
    );
    assert.deepEqual(flows.map((f) => [f.day, f.label, f.cents, f.basis]).sort(), [
      ["2026-10-02", "OptumRx", 50_00, "claims"],
      ["2026-10-06", "OptumRx", 25_00, "claims"],
      ["2026-10-08", "OptumRx", 100_00, "claims"],
      ["2026-11-09", "DST Pharmacy Solutions", 988_00, "programme"],
    ]);
  });

  test("fills still to be dispensed pay their average the typical number of days later, on open days, inside the horizon", () => {
    const flows = projectFutureFills(2_300_000, 13, "2026-10-02", "2026-10-20");
    /* 2 Oct (Fri), 3 Oct (Sat), 5-7 Oct… each pays 13 days on; only those paid by the 20th are kept. */
    assert.deepEqual(flows.map((f) => f.day), ["2026-10-15", "2026-10-16", "2026-10-18", "2026-10-19", "2026-10-20"]);
    assert.equal(flows[0].cents, 2_300_000);
    assert.deepEqual(projectFutureFills(0, 13, "2026-10-02", "2026-10-20"), []);
  });

  test("takings land on open days only, and the balance runs from the opening", () => {
    const takings = projectTakings([{ label: "card takings", cents: 3_000_00 }], "2026-10-03", "2026-10-05");
    assert.deepEqual(takings.map((t) => t.day), ["2026-10-03", "2026-10-05"]);
    const days = buildDays(100_000_00, [...takings, { day: "2026-10-05", cents: 120_000_00, kind: "out", label: "McKesson draw", basis: "statement" }], "2026-10-03", "2026-10-05", null);
    assert.deepEqual(days.map((d) => [d.day, d.balanceCents]), [["2026-10-03", 103_000_00], ["2026-10-04", 103_000_00], ["2026-10-05", -14_000_00]]);
    assert.equal(days[2].items[0].label, "McKesson draw");
  });
});
