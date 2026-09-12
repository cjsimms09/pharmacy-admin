import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkReport, CLAIM_NEEDS, SUPPLIER_NEEDS } from "../src/lib/report-check";

const csv = (lines: string[]) => Buffer.from(lines.join("\n") + "\n", "utf8");

/**
 * The whole point of this is the distinction a written spec cannot make: a column that is absent
 * needs "please add this", a column that is present and empty needs "this comes through blank".
 * Those go to different people and get different answers, so they must never read the same.
 */
describe("present-but-empty is not the same as absent", () => {
  const check = checkReport("r.csv", csv([
    "Rx Number,Date Filled,Dispensed Item NDC,Primary Third Party Bin,Primary Third Party PCN,Dispensed Quantity,Primary Remit Amount",
    "312450,2026-08-28,83980001110,610097,9999,,7.18",
    "312451,2026-08-28,00093721410,610097,9999,,4.10",
  ]));

  test("a column present on every row but never filled reads as empty", () => {
    const q = check.results.find((r) => r.name === "Quantity dispensed")!;
    assert.equal(q.state, "empty");
    assert.equal(q.present, true);
    assert.equal(q.column, "Dispensed Quantity");
  });

  test("a column that is not there at all reads as absent", () => {
    assert.equal(check.results.find((r) => r.name === "Days supply")!.state, "absent");
  });

  test("the two are worded differently in the message sent back", () => {
    assert.ok(check.askBack.includes("come through blank"), "an empty column needs its own wording");
    assert.ok(check.askBack.includes("Please add"), "an absent column needs its own wording");
    const blankPos = check.askBack.indexOf("come through blank");
    const addPos = check.askBack.indexOf("Please add");
    assert.ok(blankPos < addPos, "the configuration issue is the cheaper fix and should lead");
  });

  test("a populated column is not mentioned at all", () => {
    assert.ok(!check.askBack.includes("Rx Number"));
    assert.ok(!check.askBack.includes("Primary Remit Amount"));
  });
});

describe("partial fill", () => {
  const check = checkReport("r.csv", csv([
    "Rx Number,Date Filled,Primary Third Party Bin,Primary Group Number,Primary Remit Amount",
    "1,2026-08-28,610097,GRP1,7.18",
    "2,2026-08-28,610097,,4.10",
    "3,2026-08-28,610097,GRP2,1.00",
    "4,2026-08-28,610097,GRP3,1.00",
  ]));

  test("three of four rows filled is reported as partial, not as populated", () => {
    const g = check.results.find((r) => r.name === "Group number")!;
    assert.equal(g.state, "partial");
    assert.equal(g.filled, 3);
    assert.equal(g.rows, 4);
  });

  test("the percentage is stated so the size of the gap is visible", () => {
    assert.ok(/75%/.test(check.askBack), check.askBack);
  });
});

describe("a report with everything", () => {
  test("says so rather than inventing something to complain about", () => {
    const needs = CLAIM_NEEDS.map((n) => n.name);
    assert.ok(needs.length > 15);
    const check = checkReport("r.csv", csv([
      [
        "Rx Number", "Refill Number", "Date Filled", "Dispensed Item NDC", "Dispensed Quantity",
        "Quantity Unit Of Measure", "Days Supply", "Primary Third Party Bin", "Primary Third Party PCN",
        "Primary Group Number", "Primary Network Reimbursement", "Plan ID", "Primary Plan Type",
        "Pharmacy Service Type", "Primary Basis of Reimbursement", "Basis Of Cost Determination",
        "Primary Remit Amount", "Primary Copay Amount", "Ingredient Cost Paid", "Dispensing Fee Paid",
        "Acquisition Cost", "Dispensed AWP", "Gross Profit", "DAW",
      ].join(","),
      "1,0,2026-08-28,83980001110,90,EA,30,610097,9999,GRP,MRRETM,PLAN,Standard,01,MAC,07,7.18,0.00,5.18,2.00,4.97,20.00,2.21,0",
    ]));
    assert.equal(check.results.filter((r) => r.state !== "populated").length, 0, JSON.stringify(check.results.filter((r) => r.state !== "populated").map((r) => r.name)));
    assert.match(check.askBack, /Everything needed is present/);
  });
});

describe("supplier catalogues are checked against their own requirements", () => {
  const check = checkReport("cat.csv", csv([
    "NDC,Item Description,Net Cost",
    "83980001110,METOCLOPRAMIDE 10MG TAB 100,24.10",
  ]));

  test("recognised as a catalogue", () => assert.equal(check.kind, "supplier_catalog"));

  test("units per pack is blocking, because a pack cost alone is not a unit cost", () => {
    const u = check.results.find((r) => r.name === "Units per pack")!;
    assert.equal(u.state, "absent");
    assert.equal(u.critical, true);
    assert.ok(check.askBack.includes("Units per pack"));
  });

  test("unit cost itself is not blocking, since it is derived when absent", () => {
    assert.equal(check.results.find((r) => r.name === "Unit cost")!.critical, false);
  });
});

describe("every requirement explains itself", () => {
  test("in terms of what breaks without it", () => {
    for (const n of [...CLAIM_NEEDS, ...SUPPLIER_NEEDS]) {
      assert.ok(n.blocks.length > 20, `${n.name} does not say what it blocks`);
    }
  });
});
