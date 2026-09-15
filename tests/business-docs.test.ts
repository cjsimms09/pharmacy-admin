import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeX12Remittance, matchParty, duplicateBill, describeBusinessDoc } from "../src/lib/business-docs";

describe("what the intake can tell without a model", () => {
  test("an 835 is an X12 interchange with a remittance transaction set", () => {
    const x12 = Buffer.from("ISA*00*          *00*          *ZZ*PAYER          *ZZ*PHARMACY       *260905*1200*^*00501*000000001*0*P*:~GS*HP*PAYER*PHARMACY*20260905*1200*1*X*005010X221A1~ST*835*0001~BPR*I*1234.56*C*ACH*CCP*01*999*DA*123*1*~");
    assert.equal(looksLikeX12Remittance(x12, "remit.835"), true);
    assert.equal(looksLikeX12Remittance(Buffer.from("%PDF-1.4 ..."), "invoice.pdf"), false);
    assert.equal(looksLikeX12Remittance(Buffer.from("ISA*00*...~ST*837*0001~"), "claims.edi"), false, "an 837 is a claim file, not a remittance");
  });
  test("a printed name finds its register row exactly, then by containment, never by a near miss", () => {
    const rows = [
      { id: "mck", name: "McKesson", alsoKnownAs: "McKesson OneStop" },
      { id: "ipc", name: "IPC" },
      { id: "ipd", name: "IPD" },
    ];
    assert.equal(matchParty("mckesson", rows)?.id, "mck");
    assert.equal(matchParty("McKesson Corporation", rows)?.id, "mck");
    assert.equal(matchParty("IPD", rows)?.id, "ipd");
    assert.equal(matchParty("IPC Inc", rows), null, "three letters inside a longer name is not a match");
    assert.equal(matchParty("Independent Pharmacy Cooperative", rows), null);
    assert.equal(matchParty("", rows), null);
  });
  test("a bill already on Spending is found by its number, else by its amount and date", () => {
    const held = [
      { vendorId: "v1", invoiceNumber: "A-100", amountCents: 12_000, invoiceDate: "2026-09-01" },
      { vendorId: "v1", invoiceNumber: null, amountCents: 5_000, invoiceDate: "2026-09-03" },
    ];
    assert.ok(duplicateBill(held, "v1", "a-100", 99, "2026-01-01"));
    assert.ok(duplicateBill(held, "v1", null, 5_000, "2026-09-03"));
    assert.equal(duplicateBill(held, "v2", "A-100", 12_000, "2026-09-01"), null, "a different vendor's bill is a different bill");
    assert.equal(duplicateBill(held, "v1", "A-101", 5_000, "2026-09-04"), null);
  });
  test("the queue's one line names the party, the number, the date and the money", () => {
    assert.equal(
      describeBusinessDoc({ kind: "bill", party: "Scratch Electric", documentNumber: "77", documentDate: "2026-09-03", totalCents: 24_650, lines: [], summary: "x", confidence: 1 }),
      "Scratch Electric · #77 · 2026-09-03 · $246.50",
    );
  });
});
