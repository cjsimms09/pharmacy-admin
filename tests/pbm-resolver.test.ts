import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPbmResolver, normalizePbm, squashPbm, tightPbm } from "../src/lib/reference";

/**
 * The HMA sources name the same payer four different ways. If resolution drifts, a BIN lookup
 * returns a payer with no rates and no appeal route — which looks like missing data and is
 * actually a naming bug. Every real variant seen in the exports is pinned here.
 */

const listing = [
  { pbmName: "OptumRx", aliases: "CastiaRx; Catamaran; PerformRx; ScriptNet; ServeYou; TrueScripts; RxAdvance; Optum; UnitedHealthcare; ProAct; MedalistRx; FlexScripts; Ascella Health" },
  { pbmName: "CVS Caremark", aliases: "" },
  { pbmName: "Prime Therapeutics", aliases: "" },
  { pbmName: "MedImpact", aliases: "Elixir; MedTrak; SavRx" },
  { pbmName: "DST Pharmacy Solutions", aliases: "Argus" },
  { pbmName: "ScriptGuideRx", aliases: "" },
  { pbmName: "ScryptSense", aliases: "" },
  { pbmName: "Script Care & Tredium Solutions", aliases: "" },
  { pbmName: "MC-Rx & ProCare", aliases: "MaxCare" },
  { pbmName: "PDMI", aliases: "" },
  { pbmName: "VytlOne", aliases: "MaxorPlus" },
  { pbmName: "Judi Rx (Capital Rx)", aliases: "Capital Rx" },
  { pbmName: "IQVIA", aliases: "" },
  { pbmName: "Abarca Health", aliases: "" },
  { pbmName: "SRPS (unnamed row on source table)", aliases: "SRPS" },
];

const r = buildPbmResolver(listing, null);
const to = (label: string, expected: string) =>
  test(`${label} -> ${expected}`, () => assert.equal(r.resolve(label).name, expected));

describe("normalisation keys", () => {
  test("drops footnotes, parentheticals and Rx", () => {
    assert.equal(normalizePbm("Optum Rx (PerformRx, RxAdvance) ***841 stores are excluded"), "optum");
    assert.equal(normalizePbm("VytlOne (previously MaxorPlus)"), "vytlone");
    assert.equal(normalizePbm("CVS Caremark* & Aetna Commercial"), "cvs caremark aetna commercial");
  });
  test("squash ignores spacing and a trailing Rx", () => {
    assert.equal(squashPbm("ScriptGuide Rx"), squashPbm("ScriptGuideRx"));
    assert.equal(squashPbm("Scrypt Sense"), squashPbm("ScryptSense"));
  });
  test("tight keeps the words the noise list would drop", () => {
    assert.equal(tightPbm("Prime Therapeutics"), tightPbm("PrimeTherapeutics"));
    assert.equal(tightPbm("Abarca Health"), tightPbm("AbarcaHealth"));
  });
});

describe("the OptumRx family, which is where most of the drift is", () => {
  to("Optum Rx", "OptumRx");
  to("OptumRx (CastiaRx, Catamaran, ScriptNet & StoneRiver)", "OptumRx");
  to("Optum Rx (PerformRx, RxAdvance) ***841 stores are excluded", "OptumRx");
  to("Optum Rx (PerformRx, RxAdvance, Serve You)", "OptumRx");
  to("PerformRx (Ascella Health)", "OptumRx");
  to("AscellaHealth (processing under PerformRx)", "OptumRx");
  to("Serve You", "OptumRx");
  to("RxAdvance", "OptumRx");
});

describe("spacing and suffix variants", () => {
  to("ScriptGuide Rx", "ScriptGuideRx");
  to("Scrypt Sense", "ScryptSense");
  to("PrimeTherapeutics", "Prime Therapeutics");
  to("AbarcaHealth", "Abarca Health");
  to("Abarca", "Abarca Health");
  to("ScriptCareTrediumSolutions", "Script Care & Tredium Solutions");
});

describe("brand and parent names", () => {
  to("MedImpact (Elixir, MedTrak, SavRx)", "MedImpact");
  to("Elixir Rx Options", "MedImpact");
  to("MedtrakRx (Elixir)", "MedImpact");
  to("MedImpactElixir", "MedImpact");
  to("SSCHealthDST", "DST Pharmacy Solutions");
  to("DST Pharmacy Solutions (formerly Argus)", "DST Pharmacy Solutions");
  to("IQVIAOpus", "IQVIA");
  to("IQVIA (Opus Health)", "IQVIA");
  to("VytlOne (previously MaxorPlus)", "VytlOne");
  to("Capital Rx", "Judi Rx (Capital Rx)");
  to("PDMI- Pharmacy Data Management, Inc. (Universal Rx)", "PDMI");
});

describe("combined rows resolve on the first named brand", () => {
  to("CVS Caremark & Aetna Commercial", "CVS Caremark");
  to("CVS Caremark* & Aetna Commercial", "CVS Caremark");
  to("CVS Caremark & Aetna Commericial", "CVS Caremark"); // the source's own typo
  to("MC-Rx, ProCare & MaxCare", "MC-Rx & ProCare");
  to("Prime Therapeutics & Magellan", "Prime Therapeutics");
});

describe("entities that are deliberately not folded into a PBM", () => {
  const gap = (label: string, expected: string) =>
    test(`${label} stays separate`, () => {
      const res = r.resolve(label);
      assert.equal(res.name, expected);
      assert.equal(res.via, "known-gap");
      assert.ok(res.why && res.why.length > 20, "a known gap must explain itself");
    });

  gap("Express Scripts (Cigna, Centene, Benecard, Prime Commercial)", "Express Scripts");
  gap("Express Scripts (Benecard)", "Express Scripts");
  gap("ESI", "Express Scripts");
  gap("Health Mart Atlas (PSAO route - applies to all MSM-covered PBMs)", "Health Mart Atlas (PSAO)");
  gap("MTF / Medicare Transaction Facilitator (MFP refunds)", "Medicare Transaction Facilitator (MTF)");
  gap("CoverMyMeds (eVoucher)", "CoverMyMeds");
  gap("GA Medicaid", "Georgia Medicaid");
});

describe("nothing is invented", () => {
  test("an unknown payer keeps its own label and is reported", () => {
    const res = r.resolve("Go Mango Meds");
    assert.equal(res.name, "Go Mango Meds");
    assert.equal(res.via, "unresolved");
    assert.ok(r.unresolved().includes("Go Mango Meds"));
  });

  test('a literal "null" is absent, not a payer named null', () => {
    assert.equal(r.resolve("null").via, "unresolved");
    assert.equal(r.resolve("null").name, "(unlabelled)");
    assert.ok(!r.unresolved().includes("null"), "an absent value is not a name to go and fix");
  });

  test("the crosswalk file wins over mechanical matching when it disagrees", () => {
    const withCrosswalk = buildPbmResolver(listing, "phase2_label,phase1_pbm_name,matches_phase1\nOptum Rx,CVS Caremark,y\n");
    assert.equal(withCrosswalk.resolve("Optum Rx").name, "CVS Caremark");
    assert.equal(withCrosswalk.resolve("Optum Rx").via, "crosswalk");
  });

  test("a crosswalk row that says the names do not match is not treated as a mapping", () => {
    const withCrosswalk = buildPbmResolver(
      listing,
      "phase2_label,phase1_pbm_name,matches_phase1\nMagellan Rx,(in the HMA CMS but not rendered on the listing),n\n",
    );
    const res = withCrosswalk.resolve("Magellan Rx");
    assert.notEqual(res.name, "(in the HMA CMS but not rendered on the listing)");
  });
});
