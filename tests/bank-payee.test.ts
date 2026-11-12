import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { payeeStem, groupByPayee, parseRules, ruleFor, withRule, suggestFor, type PayeeRule } from "../src/lib/bank-payee";

/*
 * Bank lines named by payee. The descriptions are the shapes the bank and the accounting register print (invented amounts).
 */
describe("the payee of a bank line", () => {
  test("the register's code, a cheque number and a trace are taken off", () => {
    assert.equal(payeeStem("IPC0100 Independent Pharmacy Cooperative"), "independent pharmacy cooperative");
    assert.equal(payeeStem("1869 LL Medico"), "ll medico");
    assert.equal(payeeStem("1871 State of Kansas - Medicaid"), "state of kansas medicaid");
    assert.equal(payeeStem("ACH CREDIT ACCESS HEALTH/ACCESS HEA 9990001 West Wichita Family Ph"), "ach credit access health/access hea");
    assert.equal(payeeStem("McKesson Debit"), "mckesson debit");
  });
});

describe("grouping the lines nobody has named", () => {
  const lines = [
    { id: "a", on: "2026-10-01", description: "IPC0100 Independent Pharmacy Cooperative", amountCents: -121_929 },
    { id: "b", on: "2026-10-07", description: "IPC0100 Independent Pharmacy Cooperative", amountCents: -418_019 },
    { id: "c", on: "2026-10-13", description: "SPW100 South Pointe Wholesale, Inc.", amountCents: -23_547 },
    { id: "d", on: "2026-11-03", description: "SPW100 South Pointe Wholesale, Inc.", amountCents: 23_347 },
  ];
  test("one group per payee and direction, the biggest money first, with its dates and total", () => {
    const g = groupByPayee(lines);
    assert.equal(g.length, 3);
    assert.equal(g[0].stem, "independent pharmacy cooperative");
    assert.deepEqual({ n: g[0].lines.length, total: g[0].totalCents, from: g[0].from, to: g[0].to }, { n: 2, total: -539_948, from: "2026-10-01", to: "2026-10-07" });
    assert.ok(g.some((x) => x.direction === "in" && x.lines[0].id === "d"), "a refund is not grouped with the payments");
  });
});

describe("a rule is the owner's answer for a payee and direction", () => {
  const rule: PayeeRule = { stem: "independent pharmacy cooperative", direction: "out", what: "noted", category: "Drug purchases", by: "Cory, 2026-11-12" };
  test("it names a later line from the same payee, and not a refund from it", () => {
    assert.equal(ruleFor([rule], "IPC0100 Independent Pharmacy Cooperative", -5000)?.what, "noted");
    assert.equal(ruleFor([rule], "IPC0100 Independent Pharmacy Cooperative", 5000), null);
    assert.equal(ruleFor([rule], "McKesson Debit", -5000), null);
  });
  test("a later answer replaces the earlier one for the same payee and direction", () => {
    const r2 = withRule([rule], { ...rule, what: "cost", category: "Other", vendor: "IPC" });
    assert.equal(r2.length, 1);
    assert.equal(r2[0].what, "cost");
  });
  test("stored rules that are not rules are ignored", () => {
    assert.deepEqual(parseRules("not json"), []);
    assert.deepEqual(parseRules(JSON.stringify([{ stem: 1 }, rule])), [rule]);
    assert.deepEqual(parseRules(""), []);
  });
});

describe("what a group probably is", () => {
  const ctx = {
    suppliers: [{ name: "Mckesson", aliases: null }],
    vendors: [{ name: "Stamps.com", categoryName: "Postage and shipping" }],
    standing: [{ name: "Rent" }],
  };
  test("a wholesaler he buys from is drug purchases; a vendor on file takes its category; money in is never guessed", () => {
    assert.equal(suggestFor({ stem: "mckesson debit", direction: "out" }, ctx)?.category, "Drug purchases");
    assert.equal(suggestFor({ stem: "sta100 stamps com", direction: "out" }, ctx)?.vendor, "Stamps.com");
    assert.equal(suggestFor({ stem: "mckesson debit", direction: "in" }, ctx), null);
    assert.equal(suggestFor({ stem: "wichita key lock and safe", direction: "out" }, ctx), null);
  });
});
