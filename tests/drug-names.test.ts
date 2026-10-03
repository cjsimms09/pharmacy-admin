import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bestName } from "../src/lib/drug-names";

describe("naming a drug from whatever the site holds", () => {
  test("the pharmacy's own daily count wins, because it reads like English", () => {
    assert.equal(
      bestName({ onHand: "Cyclobenzaprine 10 Mg Tablet", catalogue: "CYCLOBENZ HCL TB 10MGNSTR1000@", nadac: "CYCLOBENZAPRINE HCL 10 MG TAB" }),
      "Cyclobenzaprine 10 Mg Tablet",
    );
  });

  test("each source stands in for the one above it", () => {
    assert.equal(bestName({ claim: "Wegovy 4 Mg", catalogue: "WEGOVY TB 4MG 30" }), "Wegovy 4 Mg");
    assert.equal(bestName({ catalogue: "AMLODIPINE BES TB 5MG UNI1000@" }), "AMLODIPINE BES TB 5MG UNI1000@");
    assert.equal(bestName({ nadac: "AMLODIPINE BESYLATE 5 MG TAB" }), "AMLODIPINE BESYLATE 5 MG TAB");
  });

  test("nothing held is null, so the screen falls back to the NDC rather than to a lie", () => {
    assert.equal(bestName({}), null);
    assert.equal(bestName({ onHand: "", catalogue: "   " }), null);
  });

  test("a placeholder is not a name — McKesson's catalogue really carries these", () => {
    // Shown in place of a drug, "TBD DO NOT DELETE OR RELEASE" reads as an instruction.
    assert.equal(bestName({ catalogue: "TBD DO NOT DELETE OR RELEASE", nadac: "BORTEZOMIB 3.5 MG VIAL" }), "BORTEZOMIB 3.5 MG VIAL");
    assert.equal(bestName({ onHand: "N/A", claim: "Unknown", catalogue: "Lisinopril 10 Mg Tablet" }), "Lisinopril 10 Mg Tablet");
  });

  test("a name is trimmed, not reformatted — the pharmacy's spelling is the pharmacy's", () => {
    assert.equal(bestName({ onHand: "  Otezla 30 Mg Tablet  " }), "Otezla 30 Mg Tablet");
  });
});
