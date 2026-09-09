import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FORMS, suggestForm, appendixReference, policies, appendixVersion } from "../src/lib/manual";

/**
 * The headings that were empty, and whether the site can now close them.
 *
 * Every title here is a real heading from this pharmacy's own manual, appendix 4.11. They sat
 * empty because the picker offered twelve formal names — the Board's names for the documents —
 * and none of them said "Medication Incident Form". The pharmacist read the list, found nothing
 * that matched, and concluded the site could not produce a form it produces every two months.
 */

const HEADINGS: [string, boolean][] = [
  ["Medication Incident Form", true],
  ["Vaccine Administration Record", true],
  ["Vaccine Protocol", true],
  ["Technician List", true],
  ["Technician Training", true],
  ["HIPAA Form", true],
  ["Policy and Procedure Acknowledgement", true],
  ["Medicare Prescription Drug Coverage and Your Rights", true],
  ["Business Associate Agreement", true],
];

describe("matching a manual heading to a form the site produces", () => {
  for (const [title, shouldMatch] of HEADINGS) {
    test(`"${title}" ${shouldMatch ? "finds its form" : "matches nothing"}`, () => {
      const f = suggestForm(title);
      if (shouldMatch) assert.ok(f, `nothing matched "${title}"`);
      else assert.equal(f, null);
    });
  }

  test("the medication incident form is the CQI one, under the name the Board uses", () => {
    assert.match(suggestForm("Medication Incident Form")!.name, /C-650/);
  });

  test("the vaccine protocol is the per-person immunization protocol, not the vaccine record", () => {
    assert.match(suggestForm("Vaccine Protocol")!.name, /Immunization protocol/i);
    assert.match(suggestForm("Vaccine Administration Record")!.name, /administration record/i);
  });

  test("a heading naming nothing the site produces does not get a confident wrong answer", () => {
    assert.equal(suggestForm("Employee Benefits"), null);
    assert.equal(suggestForm("Miscellaneous Policies"), null);
  });

  test("every suggestion resolves to a form that can actually be referenced", () => {
    for (const [title] of HEADINGS) {
      const f = suggestForm(title);
      if (!f) continue;
      const body = appendixReference(f.name);
      assert.ok(body.includes(f.name), title);
      assert.ok(body.length > 100, title);
    }
  });
});

describe("the forms themselves", () => {
  test("every form has somewhere to click, fields, and an authority", () => {
    for (const f of FORMS) {
      assert.ok(f.href.startsWith("/"), f.name);
      assert.ok(f.fields.length > 0, f.name);
      assert.ok(f.authority.length > 0, f.name);
      assert.ok(f.where.length > 0, f.name);
    }
  });

  test("no two forms share a name, or the appendix reference is ambiguous", () => {
    assert.equal(new Set(FORMS.map((f) => f.name)).size, FORMS.length);
  });

  test("the four patient-facing forms the manual promised are here", () => {
    const names = FORMS.map((f) => f.name).join(" | ");
    assert.match(names, /Vaccine screening, consent and administration record/);
    assert.match(names, /Notice of Privacy Practices/);
    assert.match(names, /CMS-10147/);
    assert.match(names, /Business associate agreement/);
  });
});

/*
 * The site's own description of itself, which the manual quotes and the audit compares against.
 *
 * `policies()` is the one place in this project where a sentence that is merely aspirational does
 * direct harm. A manual is a standard the pharmacy wrote for itself, and an inspector holds it to
 * that standard — so a procedure described here and not performed is a finding the pharmacy wrote
 * against itself. The audit also reads these as "what the site does", so an untrue sentence here
 * teaches the audit to stop reporting a real disagreement.
 */
describe("what the site says it does about money coming in", () => {
  const p = () => policies("West Wichita Family Pharmacy").find((x) => x.key === "third_party_payments")!;

  test("the payment records have a policy at all, because the site keeps them and the manual did not say so", () => {
    assert.ok(p(), "claims, remittances and payments were absent from the manual entirely");
    assert.match(p().title, /Claims, remittances/);
  });

  test("it claims only what the remittance path actually does today", () => {
    const text = p().text.join(" ");
    assert.match(text, /matched to the dispensing it settles by prescription number, fill number and date of service/);
    assert.match(text, /held and listed as unmatched/);
    assert.match(text, /never attached to a dispensing it does not belong to on a partial match/);
  });

  test("it does not claim the arithmetic gate the 835 path has not got", () => {
    /*
     * Written and then removed. The invoice reader refuses a document whose lines do not add to
     * its printed total, and so does the copay-voucher reader; the 835 path does neither, and the
     * copay reader is not yet wired to anything. Describing either as current practice would have
     * been a self-inflicted finding — and the sort that is only found when somebody checks.
     */
    const text = p().text.join(" ");
    assert.doesNotMatch(text, /Nothing is stored from a remittance that does not reconcile/);
    assert.doesNotMatch(text, /netted before anything is recorded/);
  });

  test("it states the gap between what was banked and what the claims came to, which the site does record", () => {
    assert.match(p().text.join(" "), /the difference is recorded on the receipt with the reason the payer gave/);
  });

  test("the pharmacy's name is used rather than a chain's placeholder", () => {
    // Inherited manual text describing a chain is a known kind of finding in this manual.
    assert.match(p().text[0], /West Wichita Family Pharmacy/);
  });

  test("adding it moves the appendix version, so a filed copy is demonstrably out of date", () => {
    const withIt = appendixVersion(policies("A Pharmacy"));
    const withoutIt = appendixVersion(policies("A Pharmacy").filter((x) => x.key !== "third_party_payments"));
    assert.notEqual(withIt, withoutIt);
  });
});
