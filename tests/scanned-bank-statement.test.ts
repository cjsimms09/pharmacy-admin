import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readRaw, type ScanItem } from "../src/lib/scanned-bank-statement";
import { amountOptions, dayOptions, solveStatement } from "../src/lib/scanned-bank-solve";

/*
 * Every garbled string below is one the August 2026 Emprise scan actually printed. The statement built at the
 * bottom is invented — its account, lines and balances — laid out at the scan's measured column positions.
 */
describe("what a scanned figure could have been", () => {
  test("letters the scan puts in place of digits", () => {
    assert.deepEqual(amountOptions("t4,642.54").slice(0, 1), [1_464_254]);
    assert.deepEqual(amountOptions("22s.22").slice(0, 2), [22_522, 22_822]);
    assert.equal(amountOptions("937,00")[0], 93_700);
    assert.equal(amountOptions('3,817"32')[0], 381_732);
    assert.equal(amountOptions("305,2+48.80")[0], 30_524_880);
  });

  test("a clean figure is only itself", () => {
    assert.deepEqual(amountOptions("1,915.02"), [191_502]);
  });

  test("dates: the last two characters, loosely", () => {
    assert.deepEqual(dayOptions("8/0s"), [5, 8]);
    assert.deepEqual(dayOptions("8lL2"), [12]);
    assert.equal(dayOptions("8/xy"), null);
  });
});

/* A statement laid out as the scan lays it out: page, x, y, word. */
function statement(opts: { lines: [string, string, string][]; debits: [string, string, string][]; balances: [string, string][]; opening: string; closing: string }): ScanItem[] {
  const items: ScanItem[] = [];
  let y = 800;
  const row = (cells: [number, string][]) => {
    y -= 12;
    for (const [x, text] of cells) items.push({ page: 2, x, y, text });
  };
  row([[449, "Date:"], [542, "09/30/26"]]);
  row([[197, "Summary"], [242, "of"], [254, "Activity"]]);
  row([[162, "Beginning"], [207, "Balance"], [406, opts.opening]]);
  row([[162, "Ending"], [194, "Balance"], [406, opts.closing]]);
  row([[68, "Deposits"], [118, "and"], [142, "Other"], [176, "Credits"]]);
  row([[68, "Date"], [139, "Amount"], [197, "Activity"], [231, "Description"]]);
  for (const [d, a, desc] of opts.lines) row([[71, d], [133, a], [199, desc]]);
  row([[67, "Debits"], [105, "and"], [129, "Other"], [163, "Withdrawals"]]);
  row([[67, "Date"], [135, "Amount"], [197, "Activity"], [230, "Description"]]);
  for (const [d, a, desc] of opts.debits) row([[70, d], [132, a], [198, desc]]);
  row([[69, "Daily"], [99, "Balance"], [146, "Summary"]]);
  row([[69, "Date"], [166, "Balance"], [251, "Date"], [348, "Balance"], [432, "Date"], [530, "Balance"]]);
  for (const [d, b] of opts.balances) row([[71, d], [153, b]]);
  return items;
}

describe("a scanned statement solved against its own balances", () => {
  const base = {
    opening: "10,000.00",
    closing: "10,540.00",
    balances: [["9/01", "11,000.00"], ["9/02", "10,540.00"]] as [string, string][],
    debits: [["9/02", "460.00", "MCKESSON DRUG/AUTO ACH"]] as [string, string, string][],
  };

  test("clean lines that reach every balance are proved and nothing is decided", () => {
    const r = solveStatement(readRaw(statement({ ...base, lines: [["9/01", "600.00", "HRTLAND PMT SYS"], ["9/01", "400.00", "ACCESS HEALTH"]] })));
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.unproven.length, 0);
    assert.deepEqual(r.lines.map((l) => [l.on, l.amountCents]), [["2026-09-01", 60_000], ["2026-09-01", 40_000], ["2026-09-02", -46_000]]);
    assert.ok(r.lines.every((l) => l.decidedFrom === null));
  });

  test("a letter read as a digit is decided by the balance, and said so", () => {
    /* "s50.00" could be 550.00 or 850.00; only 550.00 with the 450.00 beside it reaches 11,000.00. */
    const r = solveStatement(readRaw(statement({ ...base, lines: [["9/01", "s50.00", "HRTLAND PMT SYS"], ["9/01", "450.00", "ACCESS HEALTH"]] })));
    assert.ok(r.ok);
    assert.equal(r.unproven.length, 0);
    assert.equal(r.lines[0].amountCents, 55_000);
    assert.match(r.lines[0].decidedFrom ?? "", /s50\.00/);
  });

  test("a digit misread as another is corrected, toward money another document already shows", () => {
    const lines: [string, string, string][] = [["9/01", "900.00", "HRTLAND PMT SYS"], ["9/01", "400.00", "ACCESS HEALTH"]];
    const r = solveStatement(readRaw(statement({ ...base, lines })), { known: [60_000] });
    assert.ok(r.ok);
    assert.equal(r.unproven.length, 0);
    assert.equal(r.lines[0].amountCents, 60_000);
    assert.match(r.lines[0].decidedFrom ?? "", /digit was misread/);
  });

  test("REGRESSION: lines that cannot be made to reach the balance are held for a person, with the difference", () => {
    const lines: [string, string, string][] = [["9/01", "123.45", "Deposit"], ["9/01", "400.00", "ACCESS HEALTH"]];
    const r = solveStatement(readRaw(statement({ ...base, lines })));
    assert.ok(r.ok);
    assert.equal(r.unproven.length > 0, true);
    assert.equal(r.unproven[0].from, "2026-09-01");
  });
});
