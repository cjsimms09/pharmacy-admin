import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rank, totals, type MoneyRow } from "../src/lib/money-found";

/**
 * One list of what is worth acting on, in money.
 *
 * Three things would make it useless and each is guarded in the arithmetic: money invented, the
 * same problem counted twice, and a saving that recurs every month ranked against a one-off
 * recovery as though they were the same size.
 */
const row = (over: Partial<MoneyRow> & Pick<MoneyRow, "key" | "amountCents" | "cadence">): MoneyRow => ({
  says: "",
  todo: "",
  confidence: "certain",
  basis: "",
  href: "/",
  ...over,
});

describe("ranking what to do first", () => {
  test("a recurring saving outranks a bigger one-off once the year is counted", () => {
    // $100 a month is $1,200 a year and belongs above $900 recovered once, however much larger the
    // single number looks on the day.
    const r = rank([
      row({ key: "one-off", amountCents: 90_000, cadence: "one_off" }),
      row({ key: "monthly", amountCents: 10_000, cadence: "recurring_monthly" }),
    ]);
    assert.deepEqual(r.map((x) => x.key), ["monthly", "one-off"]);
  });

  test("confidence breaks a tie but never scales the money", () => {
    const r = rank([
      row({ key: "unsure", amountCents: 5_000, cadence: "one_off", confidence: "worth checking" }),
      row({ key: "sure", amountCents: 5_000, cadence: "one_off", confidence: "certain" }),
    ]);
    assert.deepEqual(r.map((x) => x.key), ["sure", "unsure"]);
    // Halving an uncertain figure would make it a number nobody could check against its document.
    assert.equal(r[1].amountCents, 5_000);
  });
});

describe("adding it up", () => {
  test("two symptoms of one problem are counted once", () => {
    // A drug bought dearly and dispensed at a loss is one problem. Added twice it promises money
    // that does not exist, and the first month proves the list wrong.
    const t = totals([
      row({ key: "loss", amountCents: 30_000, cadence: "recurring_monthly", overlapsWith: ["switch"] }),
      row({ key: "switch", amountCents: 20_000, cadence: "recurring_monthly" }),
    ]);
    assert.equal(t.recurringMonthlyCents, 30_000, "the larger row absorbs the one it overlaps");
    assert.equal(t.firstYearCents, 360_000);
  });

  test("one-offs and recurring are kept apart, and only the year multiplies", () => {
    const t = totals([
      row({ key: "a", amountCents: 10_000, cadence: "recurring_monthly" }),
      row({ key: "b", amountCents: 7_500, cadence: "one_off" }),
    ]);
    assert.equal(t.recurringMonthlyCents, 10_000);
    assert.equal(t.oneOffCents, 7_500);
    assert.equal(t.firstYearCents, 7_500 + 10_000 * 12);
  });

  test("nothing found is nothing claimed", () => {
    assert.deepEqual(totals([]), { firstYearCents: 0, recurringMonthlyCents: 0, oneOffCents: 0 });
  });
});
