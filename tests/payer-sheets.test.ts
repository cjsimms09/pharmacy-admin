import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PAYER_SHEETS, payerSheetFor, LOB_CLASS, LOB_LABEL, type LineOfBusiness } from "../src/lib/payer-sheets";
import { findPlanClass, isFinding } from "../src/lib/plan-evidence";
import { needsBasis, CLASS_INFO } from "../src/lib/plans";

/**
 * These rows were read by hand out of payer sheets and CMS files, and they are the strongest
 * evidence this site has about what a plan is. That makes them the most dangerous thing in it: a
 * fabricated quote attached to a real URL would be indistinguishable from a fact and would survive
 * every review, because it *looks* like exactly what everybody wants to see.
 *
 * So the shape is enforced. A row with no quote, no publisher or no address cannot exist, and no
 * row can quietly become a classification the Kansas floor turns on.
 */

describe("every row can be checked by somebody who doubts it", () => {
  test("each carries a publisher, an address and the words it was read from", () => {
    for (const s of PAYER_SHEETS) {
      const where = `${s.bin}/${s.pcn || "(blank)"}`;
      assert.ok(s.publisher.length > 3, `${where} has no publisher`);
      assert.match(s.url, /^https:\/\//, `${where} has no address`);
      assert.ok(s.quote.length > 30, `${where} quotes nothing worth reading`);
      assert.ok(s.name.length > 2, `${where} names no plan`);
      assert.match(s.checkedOn, /^\d{4}-\d{2}-\d{2}$/, `${where} has no date`);
    }
  });

  test("the addresses are payers, CMS or a state agency — never an aggregator", () => {
    // A BIN-lookup site with no provenance is not a source, however confidently it prints a number.
    // If one ever gets in, it will get in through this list.
    const banned = /bin-?lookup|rxbin\.|pharmacychecker|reddit|quora|scribd|coursehero/i;
    for (const s of PAYER_SHEETS) assert.doesNotMatch(s.url, banned, `${s.bin}/${s.pcn} cites an aggregator`);
  });

  test("no BIN and PCN is recorded twice with two answers", () => {
    const seen = new Map<string, LineOfBusiness>();
    for (const s of PAYER_SHEETS) {
      const k = `${s.bin}|${s.pcn}`;
      const had = seen.get(k);
      assert.ok(had === undefined || had === s.lineOfBusiness, `${k} is recorded as both ${had} and ${s.lineOfBusiness}`);
      seen.set(k, s.lineOfBusiness);
    }
  });
});

describe("THE LINE: a payer sheet says commercial and stops there", () => {
  test("commercial maps to the class that asserts no funding", async () => {
    /*
     * Still the most important assertion in the file, and the line it draws has not moved — only
     * what sits on the near side of it.
     *
     * A commercial payer sheet establishes the payer and the line of business and says nothing
     * whatever about whether the employer bought insurance or funds its own plan, which is the only
     * question the Kansas floor turns on. Mapping it to `commercial_fully_insured` would be a
     * one-click ERISA determination made from a document that does not mention ERISA, and that is
     * still forbidden — the test below asserts it, over the whole table.
     *
     * What this used to be was `null`, which also threw away the part the sheet does state. These
     * are the payer's own words about its own BIN, and Liviniti, SmithRx and RxSense all publish
     * exactly this. `commercial_unknown_funding` keeps the stated half and asserts nothing about
     * the funding, so the sheet is recorded for what it says and no more.
     */
    assert.equal(LOB_CLASS.commercial, "commercial_unknown_funding");
    // And the class it maps to must be one that cannot reach a filing. If that ever stops being
    // true, this is the line that catches it.
    const { planScopeOf } = await import("../src/lib/plans");
    assert.equal(planScopeOf("commercial_unknown_funding"), "unknown");
  });

  test("a federal employee plan maps to no class either", () => {
    // "Not ERISA, therefore in scope" is the trap. FEHB is preempted by 5 U.S.C. §8902(m)(1)
    // instead, which is a legal question about a federal statute and not a fact about a BIN.
    assert.equal(LOB_CLASS.federal_employee, null);
  });

  test("nothing this table can produce is a class that needs a document", () => {
    for (const lob of Object.keys(LOB_CLASS) as LineOfBusiness[]) {
      const cls = LOB_CLASS[lob];
      if (cls) assert.equal(needsBasis(cls), false, `${lob} would set ${cls}, which needs a documented basis`);
    }
  });

  test("every line of business has a label a person can read", () => {
    for (const lob of Object.keys(LOB_CLASS) as LineOfBusiness[]) assert.ok(LOB_LABEL[lob]?.length > 3, lob);
  });
});

describe("looking one up", () => {
  test("the exact PCN wins over a blank-PCN entry for the same BIN", () => {
    // A general entry must never overrule a document that named the PCN. BIN 610014 has both.
    assert.equal(payerSheetFor("610014", "MEDDPRIME")?.lineOfBusiness, "part_d");
    assert.equal(payerSheetFor("610014", null)?.lineOfBusiness, "commercial");
  });

  test("a blank-PCN entry still answers for a PCN nobody recorded", () => {
    assert.equal(payerSheetFor("015995", "ANYTHING")?.lineOfBusiness, "discount_card");
  });

  test("a BIN nobody recorded answers nothing", () => {
    assert.equal(payerSheetFor("999999", "X"), null);
    assert.equal(payerSheetFor(null, "X"), null);
  });
});

describe("the three routings on Blue Cross Blue Shield of Kansas, which are three different laws", () => {
  const ev = (pcn: string) => ({ bin: "610455", pcn, groupNumber: null, payerLabel: null, pbmName: null, linesOfBusiness: null });

  test("BCBSKS is commercial, and the funding is still the owner's question", () => {
    /*
     * The three PCNs on this one BIN are the whole reason the register is keyed on BIN *and* PCN:
     * BCBSKS is commercial, KSPDP is a standalone Part D plan and KSPARTD is Medicare Advantage.
     * Three different laws, one BIN.
     *
     * This routing is now classified rather than refused — Prime's own sheet names it commercial —
     * and what stays open is the funding, which is the part a Kansas filing needs. So the sentence
     * still has to cite the sheet and still has to leave the employer unanswered.
     */
    const r = findPlanClass(ev("BCBSKS"));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "commercial_unknown_funding");
    assert.equal(r.source, "payer_sheet");
    assert.match(r.from, /Prime Therapeutics/);
    assert.match(r.from, /Commercial/);
  });

  test("KSPDP is a standalone Part D plan", () => {
    const r = findPlanClass(ev("KSPDP"));
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicare");
    assert.equal(r.source, "payer_sheet");
    assert.equal(r.confidence, "stated");
    assert.match(r.detail ?? "", /PDP/);
  });

  test("KSPARTD is Medicare Advantage, which PioneerRx had wrong", () => {
    // PioneerRx's plan file calls it "Bc/bs Kansas Pdp". CMS lists it only against contract H7063,
    // and an H-prefix is a local Medicare Advantage plan. Both are federally governed, so the class
    // is unaffected — but the register should not repeat a mistake it can see.
    const r = findPlanClass({
      ...ev("KSPARTD"),
      pioneer: [{ bin: "610455", pcn: "KSPARTD", source: "plan_file", planName: "Bc/bs Kansas Pdp", processor: null, planType: "Part D", isActive: true }],
    });
    assert.ok(isFinding(r));
    assert.equal(r.source, "payer_sheet", "the payer sheet must outrank PioneerRx's plan file");
    assert.match(r.detail ?? "", /Medicare Advantage/);
  });
});

describe("the two big ones this settled", () => {
  test("BIN 019158 PCN CNRX is a manufacturer copay card, not the pharmacy's best payer", () => {
    /*
     * $35,476 across 28 claims, and the largest single unclassified item on the register. Ranked as
     * a payer it looked like the best in the pharmacy — it covers a hundred percent of whatever is
     * put to it — while the brand plan underneath it, which may be paying badly, was flattered by
     * it. It is not a payer at all: it pays down what a plan left the patient owing.
     */
    const r = findPlanClass({ bin: "019158", pcn: "CNRX", groupNumber: null, payerLabel: null, pbmName: null, linesOfBusiness: null });
    assert.ok(isFinding(r));
    assert.equal(r.classification, "copay_card");
    assert.equal(CLASS_INFO.copay_card.inScope, false);
  });

  test("BIN 028918 is CMS's own GLP-1 Bridge, run outside the Part D benefit", () => {
    // PioneerRx calls it Part D and the PCN reads MEDDGLP1BR; CMS says the drugs are "provided
    // outside of the Part D benefit payment flow and coverage". Federal Medicare either way, so out
    // of the Kansas floor's reach — but it is worth being right about at $752 a claim.
    const r = findPlanClass({ bin: "028918", pcn: "MEDDGLP1BR", groupNumber: null, payerLabel: null, pbmName: null, linesOfBusiness: null });
    assert.ok(isFinding(r));
    assert.equal(r.classification, "medicare");
    assert.match(r.from, /outside of the Part D benefit/);
  });

  test("two of these BINs are Kansas Medicaid, and the group number is what proves it", () => {
    for (const [bin, pcn] of [["003858", "MA"], ["610494", "9999"]] as const) {
      const r = findPlanClass({ bin, pcn, groupNumber: null, payerLabel: null, pbmName: null, linesOfBusiness: null });
      assert.ok(isFinding(r), `${bin}/${pcn}`);
      assert.equal(r.classification, "medicaid");
      // KDHE: "The claim requires the BIN, PCN, and Group number for each specific MCO."
      assert.match(r.from, /RXGROUP|RxGroup/, `${bin}/${pcn} must carry the group caveat`);
    }
  });
});
