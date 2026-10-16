import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { velocity, daysOfStock, toOrderThousandths, daysBetween, addDays, byNdc, type DispenseEvent } from "../src/lib/usage";

const fill = (o: Partial<DispenseEvent> & { dateFilled: string; ndc11: string }): DispenseEvent => ({
  itemName: "Lisinopril 10mg", quantityThousandths: 30_000, daysSupply: 30, rxNumber: null, status: "paid", ...o,
});

describe("velocity", () => {
  test("divides by the window held, not by the drug's own first fill", () => {
    /*
     * A drug first dispensed on the last day of a thirty-day window has moved thirty units in
     * thirty days, not thirty units in one day. Getting this wrong turns every new item into an
     * emergency reorder.
     */
    const events = [fill({ ndc11: "00093105601", dateFilled: "2026-09-30" })];
    const [v] = velocity(events, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(v.windowDays, 30);
    assert.equal(v.perDayThousandths, 1000);
  });

  test("a single day of claims is one day of demand, not zero", () => {
    const [v] = velocity([fill({ ndc11: "A", dateFilled: "2026-09-06" })], { from: "2026-09-06", to: "2026-09-06" });
    assert.equal(v.windowDays, 1);
    assert.equal(v.perDayThousandths, 30_000);
  });

  test("reversed fills never left the shelf", () => {
    const events = [
      fill({ ndc11: "A", dateFilled: "2026-09-04", quantityThousandths: 60_000, status: "reversed" }),
      fill({ ndc11: "A", dateFilled: "2026-09-04", quantityThousandths: 15_000 }),
    ];
    const [v] = velocity(events, { from: "2026-09-01", to: "2026-09-10" });
    assert.equal(v.unitsThousandths, 15_000);
    assert.equal(v.fills, 1);
  });

  test("one big fill is reported as concentrated and never steady", () => {
    const events = [
      fill({ ndc11: "A", dateFilled: "2026-09-02", quantityThousandths: 90_000, rxNumber: "300001", daysSupply: 90 }),
      fill({ ndc11: "A", dateFilled: "2026-09-09", quantityThousandths: 5_000, rxNumber: "300002", daysSupply: 5 }),
    ];
    const [v] = velocity(events, { from: "2026-09-01", to: "2026-09-30" });
    assert.ok(v.concentration > 0.9, `concentration ${v.concentration}`);
    assert.equal(v.steady, false, "two fills on two days is not a rate");
  });

  test("spread across days and prescriptions is steady", () => {
    const events = [
      fill({ ndc11: "A", dateFilled: "2026-09-02", rxNumber: "1" }),
      fill({ ndc11: "A", dateFilled: "2026-09-08", rxNumber: "2" }),
      fill({ ndc11: "A", dateFilled: "2026-09-15", rxNumber: "3" }),
      fill({ ndc11: "A", dateFilled: "2026-09-22", rxNumber: "4" }),
    ];
    const [v] = velocity(events, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(v.steady, true);
    assert.equal(v.prescriptions, 4);
    assert.equal(v.activeDays, 4);
    assert.equal(v.perDayThousandths, 120_000 / 30);
  });

  test("the refill horizon is the furthest a days supply runs to", () => {
    const events = [
      fill({ ndc11: "A", dateFilled: "2026-09-02", daysSupply: 30 }),
      fill({ ndc11: "A", dateFilled: "2026-09-04", daysSupply: 90 }),
    ];
    const [v] = velocity(events, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(v.refillHorizon, "2026-12-03");
  });

  test("no days supply anywhere leaves the horizon unknown rather than today", () => {
    const [v] = velocity([fill({ ndc11: "A", dateFilled: "2026-09-02", daysSupply: null })], { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(v.refillHorizon, null);
  });

  test("rows with no NDC, no quantity or a zero quantity are not demand", () => {
    const events = [
      fill({ ndc11: "A", dateFilled: "2026-09-02" }),
      { ...fill({ ndc11: "A", dateFilled: "2026-09-03" }), ndc11: null },
      fill({ ndc11: "A", dateFilled: "2026-09-04", quantityThousandths: 0 }),
      fill({ ndc11: "A", dateFilled: "2026-09-05", quantityThousandths: null }),
    ];
    const [v] = velocity(events, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(v.fills, 1);
  });

  test("empty in, empty out", () => {
    assert.deepEqual(velocity([]), []);
    assert.deepEqual(velocity([{ ...fill({ ndc11: "A", dateFilled: "2026-09-02" }), ndc11: null }]), []);
  });

  test("ordered by what moves fastest", () => {
    const events = [
      fill({ ndc11: "SLOW", dateFilled: "2026-09-02", quantityThousandths: 1_000 }),
      fill({ ndc11: "FAST", dateFilled: "2026-09-02", quantityThousandths: 500_000 }),
    ];
    const rows = velocity(events, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(rows[0].ndc11, "FAST");
    assert.equal(byNdc(rows).get("SLOW")?.unitsThousandths, 1_000);
  });
});

describe("days of stock", () => {
  test("what is on the shelf over what leaves it", () => {
    assert.equal(daysOfStock(60_000, 30_000), 2);
  });

  test("stock that does not move is not well supplied, it is forever", () => {
    assert.equal(daysOfStock(100_000, 0), Infinity);
  });
});

describe("what to order", () => {
  test("covers the target plus the days in transit", () => {
    // Two a day, two-day target, one day in transit: three days of cover, six units, none held.
    assert.equal(toOrderThousandths({ onHandThousandths: 0, perDayThousandths: 2_000, targetDays: 2, leadTimeDays: 1 }), 6_000);
  });

  test("what is already on the shelf and already on order both count", () => {
    assert.equal(
      toOrderThousandths({ onHandThousandths: 2_000, onOrderThousandths: 2_000, perDayThousandths: 2_000, targetDays: 2, leadTimeDays: 1 }),
      2_000,
    );
  });

  test("enough on hand orders nothing, never a negative", () => {
    assert.equal(toOrderThousandths({ onHandThousandths: 500_000, perDayThousandths: 2_000, targetDays: 2 }), 0);
  });

  test("rounds up to a whole unit, because nobody ships a third of a tablet", () => {
    assert.equal(toOrderThousandths({ onHandThousandths: 0, perDayThousandths: 1_500, targetDays: 1 }), 2_000);
  });
});

describe("dates", () => {
  test("whole days across a month boundary", () => {
    assert.equal(daysBetween("2026-08-30", "2026-09-02"), 3);
    assert.equal(daysBetween("2026-09-02", "2026-08-30"), -3);
  });

  test("adding days crosses the year", () => {
    assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  });
});
