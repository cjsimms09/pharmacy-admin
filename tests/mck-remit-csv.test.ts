import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeRemitSummary, looksLikeRemitDetail } from "../src/lib/mck-remit-csv";
import { classify } from "../src/lib/autoroute";
import { gateFile } from "../src/lib/phi-gate";

/** The two shapes ProviderPay's remittance table exports, with every identifier invented. */
const SUMMARY = [
  '"NCPDP","Remit number","Payer name","Remit date","Posted date","Remit amt","Payment match","Remit type","Claim match","No claim match","Adjust","Exclude effective date"',
  '"7000017","900001","EXAMPLE SCRIPTS","09/04/2026","09/03/2026",1044.98,"999000000000001","ERA",1044.98,0.00,0.00,""',
].join("\n");

const DETAIL = [
  '"Location","Remit number","Rx number or ADJ description","Dispense date","Patient name","Remit amt","Remit date","Check/ACH number","Check/ACH date","Match to claim"',
  '"7000017","900001","999001","09/01/2026","EXAMPLE PATIENT",41.62,"09/04/2026","999000000000001","09/04/2026","Y"',
].join("\n");

describe("the ProviderPay remittance exports", () => {
  test("the summary is known by the payment number beside the remit number", () => {
    assert.equal(looksLikeRemitSummary(SUMMARY), true);
    assert.equal(looksLikeRemitDetail(SUMMARY), false);
  });

  test("the detail is known by its one column doing two jobs", () => {
    assert.equal(looksLikeRemitDetail(DETAIL), true);
    assert.equal(looksLikeRemitSummary(DETAIL), false);
  });

  test("neither is mistaken for the sweep account history, which also carries a payment number", () => {
    const history = [
      '"Date","Location","Payment number","Description","Amount"',
      '"2026-08-31","7000017 - Example Pharmacy","999000000000001","ARGUS HEALTH SYS  999000000000001  20260831",1250.36',
    ].join("\n");
    assert.equal(looksLikeRemitSummary(history), false);
    assert.equal(looksLikeRemitDetail(history), false);
    assert.equal(classify("x.csv", Buffer.from(history, "utf8")).kind, "providerpay_account");
  });

  test("the router names both, so a refusal can say which one arrived", () => {
    assert.equal(classify("Remittance_20260901_20260918.csv", Buffer.from(SUMMARY, "utf8")).kind, "mck_remit_summary");
    assert.equal(classify("Remit_20260918103703.csv", Buffer.from(DETAIL, "utf8")).kind, "mck_remit_detail");
  });

  test("the detail is refused by the patient-information gate and the summary is not", () => {
    /*
     * The whole reason these two are told apart. The detail export downloaded from the portal on
     * 18 September carried 9,107 rows with a "Patient name" column, and the folder it was put in
     * was the one route into the site that did not gate what it was given.
     */
    const detail = gateFile("Remit_20260918103703.csv", Buffer.from(DETAIL, "utf8"));
    assert.equal(detail.ok, false);
    if (!detail.ok) assert.match(detail.reason, /patient name/i);

    assert.equal(gateFile("Remittance_20260901_20260918.csv", Buffer.from(SUMMARY, "utf8")).ok, true);
  });
});
