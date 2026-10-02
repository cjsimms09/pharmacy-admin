import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareSalesTax } from "../src/lib/engine/sales-tax";

describe("sales tax collected against sales tax remitted", () => {
  test("a month's tax is due the 25th of the next month; before that it is not yet due, after it nothing drafted is a gap", () => {
    const before = compareSalesTax("2026-09", 43_488, [], [], "2026-10-01");
    assert.equal(before.state, "not_yet_due");
    assert.equal(before.dueOn, "2026-10-25");
    assert.match(before.says, /due 2026-10-25/);
    const after = compareSalesTax("2026-09", 43_488, [], [], "2026-10-26");
    assert.equal(after.state, "due_nothing_drafted");
  });
  test("a draft in the following month within a dollar of what was collected agrees", () => {
    const m = compareSalesTax("2026-09", 43_488, [], [{ on: "2026-10-24", cents: 43_450 }], "2026-10-26");
    assert.equal(m.state, "agrees");
    assert.equal(m.remittedCents, 43_450);
    assert.deepEqual(m.remittedOn, ["2026-10-24"]);
  });
  test("a draft far from the tax collected is called another tax, not an over-payment", () => {
    const m = compareSalesTax("2026-08", 40_000, [], [{ on: "2026-09-01", cents: 3_901 }, { on: "2026-09-01", cents: 112_766 }], "2026-10-01");
    assert.equal(m.state, "differs");
    assert.equal(m.remittedCents, 116_667);
    assert.match(m.says, /another tax on the same account/);
    assert.match(m.says, /2 drafts/);
  });
  test("a draft a little off says by how much", () => {
    const m = compareSalesTax("2026-09", 43_488, [], [{ on: "2026-10-24", cents: 40_000 }], "2026-10-26");
    assert.equal(m.state, "differs");
    assert.match(m.says, /\$34\.88 less than collected/);
  });
  test("without the monthly summary the days stand in, and say they are partial", () => {
    const m = compareSalesTax("2026-09", null, [{ day: "2026-09-01", taxCents: 1_000 }, { day: "2026-09-02", taxCents: 1_500 }, { day: "2026-10-01", taxCents: 9 }], [], "2026-10-01");
    assert.equal(m.collectedCents, 2_500);
    assert.equal(m.collectedFrom, "daily reports");
    assert.equal(m.daysRead, 2);
    assert.match(m.says, /2 days of daily reports/);
  });
  test("no report at all is not measured, not zero", () => {
    const m = compareSalesTax("2026-07", null, [], [], "2026-10-01");
    assert.equal(m.state, "not_measured");
    assert.equal(m.collectedCents, null);
  });
  test("a December month is due in January of the next year", () => {
    assert.equal(compareSalesTax("2026-12", 100, [], [], "2027-01-02").dueOn, "2027-01-25");
  });
});
