import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { retentionOf, kindOfCategory, RETENTION } from "../src/lib/engine/retention";

const TODAY = "2026-10-01";

describe("the retention clock", () => {
  test("every rule carries its citation and a reason", () => {
    for (const r of RETENTION) {
      assert.ok(r.cite.length > 5, r.kind);
      assert.ok(r.because.length > 10, r.kind);
    }
  });
  test("a controlled-substance record is kept Kansas's five years, not the federal two", () => {
    const v = retentionOf("cs_inventory_count", "2024-09-30", TODAY);
    assert.equal(v.state, "keep");
    if (v.state === "keep") {
      assert.equal(v.until, "2029-09-30");
      assert.match(v.rule.cite, /68-7-11/);
    }
  });
  test("a bank statement from eight years ago may go; one from six must stay", () => {
    const old = retentionOf("bank_statement", "2018-08-31", TODAY);
    assert.equal(old.state, "may_destroy");
    if (old.state === "may_destroy") assert.equal(old.since, "2025-08-31");
    assert.equal(retentionOf("bank_statement", "2020-08-31", TODAY).state, "keep");
  });
  test("a remittance is a Part D record and lives ten years, the longest rule that touches it", () => {
    const v = retentionOf("remittance_835", "2026-09-29", TODAY);
    assert.equal(v.state, "keep");
    if (v.state === "keep") assert.equal(v.until, "2036-09-29");
  });
  test("an exposure record is never destroyed", () => {
    assert.equal(retentionOf("osha_exposure_report", "1999-01-01", TODAY).state, "never");
  });
  test("a CQI record is five years, as the register's own duty cites; an invoice six, for the DSCSA record on it", () => {
    const c = retentionOf("cqi_summary", "2026-09-30", TODAY);
    assert.equal(c.state, "keep");
    if (c.state === "keep") assert.equal(c.until, "2031-09-30");
    const i = retentionOf("invoice", "2026-09-04", TODAY);
    assert.equal(i.state, "keep");
    if (i.state === "keep") {
      assert.equal(i.until, "2032-09-04");
      assert.match(i.rule.cite, /360eee/);
    }
  });
  test("a kind the rule is not sure of is a question, never a period", () => {
    const v = retentionOf("self_inspection_report", "2026-09-30", TODAY);
    assert.equal(v.state, "awaiting_decision");
    if (v.state === "awaiting_decision") {
      assert.equal(v.kind, "self_inspection");
      assert.match(v.question, /not sure/);
    }
    const u = retentionOf("something_new", "2026-09-30", TODAY);
    assert.equal(u.state, "awaiting_decision");
    if (u.state === "awaiting_decision") assert.equal(u.kind, null);
  });
  test("a record with no date of its own cannot start its clock, and says so", () => {
    const v = retentionOf("supplier_invoice", null, TODAY);
    assert.equal(v.state, "awaiting_decision");
    if (v.state === "awaiting_decision") assert.match(v.question, /no date of its own/);
  });
  test("the categories the documents table uses land on a kind", () => {
    assert.equal(kindOfCategory("supplier_statement"), "supplier_paper");
    assert.equal(kindOfCategory("credit_memo"), "purchase_invoice");
    assert.equal(kindOfCategory("bank_statement"), "books");
    assert.equal(kindOfCategory("training_record"), "training", "HIPAA's six years binds any training record");
    assert.equal(kindOfCategory("report"), "medicare_part_d", "PioneerRx exports: the longest rule that touches them");
    assert.equal(kindOfCategory("driver_invoice"), "supplier_paper");
    assert.equal(kindOfCategory("controlled_substance_poa"), "controlled_substance");
    assert.equal(kindOfCategory("dea_registration"), "controlled_substance");
    assert.equal(kindOfCategory("cpr_card"), "staff_file");
    assert.equal(kindOfCategory("policy"), "hipaa");
    assert.equal(kindOfCategory("other"), null);
    assert.equal(kindOfCategory("temperature_log"), "temperature_log");
    assert.equal(kindOfCategory(""), null);
  });
});
