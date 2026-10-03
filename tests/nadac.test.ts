import test from "node:test";
import assert from "node:assert/strict";
import { parseNadacCsv } from "../src/lib/nadac";

/*
 * CMS's own scaffolding is not a price.
 *
 * Every weekly file carries a handful of rows described "TBD DO NOT DELETE OR RELEASE" against
 * reserved NDCs like 00000001235, at figures nobody meant — $104.7375 a unit in the file for
 * 1 September 2026. Stored as prices they inflate every count of what the benchmark covers, and a
 * catalogue row that collided with one of those NDCs would be measured against a made-up number.
 */
test("CMS placeholder rows are counted and left out, not stored as prices", () => {
  const csv =
    "NDC Description,NDC,NADAC_Per_Unit,Pricing_Unit,Effective_Date,As of Date\n" +
    "TBD DO NOT DELETE OR RELEASE,00000001235,104.73750,EA,09/01/2026,09/01/2026\n" +
    "AMLODIPINE BESYLATE 10 MG TAB,00093721698,0.02150,EA,09/01/2026,09/01/2026\n";
  const r = parseNadacCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ndc11, "00093721698");
  // Counted with a reason, because a row silently dropped is how a reader stops trusting the count.
  assert.equal(r.skipped, 1);
  assert.equal(r.reasons["CMS placeholder row, not a price"], 1);
});
