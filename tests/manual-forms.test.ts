import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FORMS, suggestForm, appendixReference, policies } from "../src/lib/manual";

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
 * The temperature section, which is the clearest case of a manual promising more than is done.
 *
 * The owner, asked directly: one data logger, four readings a day, records kept. The manual said
 * "monitored continuously", which is a larger promise and a different one. Four readings a day is
 * a sound practice; continuous monitoring is a standard an inspector can test and find wanting,
 * and the pharmacy would have written that test for itself.
 */
describe("temperature monitoring says what is done, not more", () => {
  const t = () => policies("West Wichita Family Pharmacy").find((x) => x.key === "temperatures")!;

  test("the cadence is stated as a number rather than left to be interpreted", () => {
    assert.match(t().text[0], /records four readings a day/);
  });

  test("it does not claim continuous monitoring", () => {
    assert.doesNotMatch(t().text.join(" "), /continuous/i);
  });

  test("the readings are said to arrive automatically, which is the part that matters for the record", () => {
    assert.match(t().text[0], /collected automatically/);
    assert.match(t().text[0], /no reading is transcribed by hand/);
  });

  test("what happens to an excursion is unchanged, because that part was already true", () => {
    const text = t().text.join(" ");
    assert.match(text, /A month cannot be signed off while any excursion in it is unexplained/);
    assert.match(text, /retained for five years/);
  });
});
