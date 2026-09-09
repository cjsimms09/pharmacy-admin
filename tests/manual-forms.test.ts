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

/*
 * The business associate section, which promised an agreement and had none behind the heading.
 *
 * The owner, 9 September, asked whether a template already exists that a contract driver could
 * sign. It does — Forms → Business associate agreement, every clause 45 CFR 164.504(e) names, with
 * the parties left blank. So the manual now says where it is instead of promising one in the
 * abstract, which is the difference between a section an inspector can follow and one they cannot.
 */
describe("business associate agreements name the form that exists", () => {
  const b = () => policies("West Wichita Family Pharmacy").find((x) => x.key === "baa")!;

  test("the manual points at the agreement the site produces", () => {
    assert.match(b().text.join(" "), /Forms → Business associate agreement/);
    assert.match(b().text.join(" "), /every clause 45 CFR 164\.504\(e\) requires/);
  });

  test("it cites the rule that governs the agreement's contents, not only the one requiring it", () => {
    // 164.502(e) requires the agreement; 164.504(e) says what has to be in it. The section
    // describes contents, so it has to cite the rule about contents.
    assert.match(b().authority, /164\.504\(e\)/);
  });

  test("who is a business associate is stated, because the driver question turned on it", () => {
    const text = b().text.join(" ");
    assert.match(text, /a delivery driver, a courier, a billing service, an IT contractor/);
    assert.match(text, /A carrier that only moves a sealed package, such as the United States Postal Service, is not/);
  });

  test("the agreement is signed before access, not after", () => {
    assert.match(b().text.join(" "), /signed before the party is given access/);
  });
});

/*
 * The retrieval clock nobody imposed.
 *
 * The owner: "we shouldn't be restricting ourselves further than law requires." The manual said 48
 * hours in one place and 72 in another, and 1 read the regulations: 21 CFR 1300.01 defines readily
 * retrievable as separable in a reasonable time, K.A.R. 68-20-16 requires records readily
 * retrievable and kept five years at the pharmacy, and the Board glosses the phrase as separated
 * out quickly and easily during an inspection. No hours anywhere, state or federal. Both numbers
 * were the manual's own invention, and a deadline nobody imposed is one the pharmacy can miss for
 * no reason at all.
 */
describe("records are produced on request, not against a made-up clock", () => {
  const r = () => policies("West Wichita Family Pharmacy").find((x) => x.key === "records")!;

  test("no number of hours is stated", () => {
    assert.doesNotMatch(r().text.join(" "), /\b\d+\s*hours?\b/);
  });

  test("the standard is stated in the Board's own terms instead", () => {
    const text = r().text.join(" ");
    assert.match(text, /separated out from all other records quickly and easily during an inspection/);
    assert.match(text, /produced on request while the inspector is here/);
  });

  test("and it says plainly that no rule sets one, so nobody puts it back", () => {
    assert.match(r().text.join(" "), /Neither the Board nor the DEA sets a number of hours, and this manual does not state one/);
  });

  test("the five-year retention it does have is untouched, because that one is real", () => {
    assert.match(r().text.join(" "), /prescription and controlled substance records five years/);
    assert.match(r().authority, /68-20-16/);
  });
});
