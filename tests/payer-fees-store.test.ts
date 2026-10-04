import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * The loader reads the three records where they are kept, and what it reads is what the account counts.
 *
 * Invented numbers, each remittance a case: EFT-9000001 is read from its payment report and repeated by the 835 and the
 * adjustment report (agrees); 9000002 is read from its payment report and the adjustment report says more; 9000005 is
 * read with no fee at all and the adjustment report says one; 9000003 and TRN-70000002 are on no payment report and are
 * counted from the report and the 835; 9000004 is a credit; October's TRN-70000001 is a balance forward; a draft bill
 * and a payment received before the books are not records of anything.
 */
let loadPayerFees: typeof import("../src/lib/payer-fees-store").loadPayerFees;
let payerFeesByMonth: typeof import("../src/lib/payer-fees-store").payerFeesByMonth;
let cleanup: () => void;
let filesDir: string;

const REPORT = [
  "Location,Location Name,Adjustment Code,Adjustment Identifier,Adjustment Amount,Remittance Number,Remit Date,Posted Date,Payer Name,Document Sequence Number,Line Item Number",
  "1,Example Pharmacy,AH,,-10.00,EFT-9000001,09/10/2026,09/12/2026,Example Atlas,1,1",
  "1,Example Pharmacy,CS,,-12.00,EFT-9000002,09/11/2026,09/13/2026,Example Atlas,2,1",
  "1,Example Pharmacy,AH,,-4.00,EFT-9000005,09/12/2026,09/14/2026,Example Express,3,1",
  "1,Example Pharmacy,AH,,-4.00,EFT-9000003,09/13/2026,09/15/2026,Example Express,4,1",
  "1,Example Pharmacy,CS,,0.84,EFT-9000004,09/14/2026,09/16/2026,Example Atlas,5,1",
  "",
  ",,,,-29.16,,,,,,",
].join("\r\n");

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmacy-admin-files-"));
  process.env.FILES_DIR = filesDir;
  const { db, schema } = await import("../src/db");
  const { newId } = await import("../src/lib/crypto");
  const { storeFile } = await import("../src/lib/files");
  ({ loadPayerFees, payerFeesByMonth } = await import("../src/lib/payer-fees-store"));

  const bill = (invoiceNumber: string, amountCents: number, status: "confirmed" | "draft") => ({ id: newId(), invoiceNumber, invoiceDate: "2026-09-10", paidOn: null, amountCents, description: "Health Mart Atlas adjustment", source: "email" as const, status, createdBy: "the test" });
  await db.insert(schema.expenses).values([bill("AHADJ|EFT-9000001|AH|-", 10_00, "confirmed"), bill("AHADJ|EFT-9000002|CS|-", 10_00, "confirmed"), bill("AHADJ|EFT-9000010|AH|-", 99_00, "draft")]);
  const paid = (rxNumber: string, origin: string) => ({ id: newId(), rxNumber, source: "mtf", amountCents: 12_34, recordedBy: "the test", origin });
  await db.insert(schema.claimPayments).values([paid("900700", "accesshealth:EFT-9000005"), paid("900701", "transaction_report:other")]);
  const hold = (traceNumber: string, reasonCode: string, reference: string, amountCents: number, receivedOn: string, outOfBooks = false) => ({ id: newId(), traceNumber, payer: "Example Payer", reasonCode, reference, amountCents, receivedOn, outOfBooks });
  await db.insert(schema.remittanceHoldbacks).values([
    hold("9000001", "AH", "", 10_00, "2026-09-10"),
    hold("TRN-70000002", "AH", "", 7_00, "2026-09-15"),
    hold("TRN-70000001", "CS", "balance forward", -46_95, "2026-10-01"),
    hold("TRN-60000001", "AH", "", 5_00, "2026-08-20", true),
  ]);
  const stored = await storeFile(new File([REPORT], "adjustment_20260901_20260930.csv", { type: "text/csv" }), { allowReportTypes: true });
  await db.insert(schema.documents).values({ id: newId(), category: "adjustment_report", title: "Adjustment report, September 2026", fileName: "adjustment_20260901_20260930.csv", mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.storageKey, uploadedBy: "the test" });
});
after(() => {
  cleanup();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

describe("what the loader reads, and what it counts", () => {
  test("September: two remittances are counted, four lines are kept out, one credit is held", async () => {
    const sep = (await payerFeesByMonth()).get("2026-09")!;
    assert.equal(sep.countedCents, 11_00, "the adjustment report's EFT-9000003 ($4.00) and the 835's TRN-70000002 ($7.00)");
    assert.equal(sep.countedLines, 2);
    assert.equal(sep.keptOutLines, 4, "EFT-9000001 on the adjustment report and the 835, 9000002 and 9000005 on the adjustment report");
    assert.equal(sep.keptOutCents, 36_00);
    assert.equal(sep.heldCents, -84);
    assert.equal(sep.heldLines, 1);
    assert.match(sep.heldSays, /CS \$0\.84 added to the remittance, on EFT-9000004: a credit from the payer/);
  });
  test("a remittance whose payment report booked a different fee, or none, is said, and the report is believed", async () => {
    const sep = (await payerFeesByMonth()).get("2026-09")!;
    assert.match(sep.differ, /EFT-9000002: the Health Mart Atlas payment report says \$10\.00 and the adjustment report says \$12\.00/);
    assert.match(sep.differ, /EFT-9000005: the Health Mart Atlas payment report says \$0\.00 and the adjustment report says \$4\.00/);
    assert.doesNotMatch(sep.differ, /EFT-9000001/, "the three records of that one agree");
  });
  test("October: a balance forward is held and nothing is counted", async () => {
    const oct = (await payerFeesByMonth()).get("2026-10")!;
    assert.equal(oct.countedCents, 0);
    assert.equal(oct.keptOutLines, 0);
    assert.equal(oct.heldCents, -46_95);
    assert.match(oct.heldSays, /CS "balance forward" \$46\.95 added to the remittance, on TRN-70000001: a balance carried to a later remittance/);
  });
  test("a draft bill is not a fee, a payment received before the books is not a record, and another origin does not cover an EFT", async () => {
    const r = await loadPayerFees();
    const all = JSON.stringify(r);
    assert.doesNotMatch(all, /9000010/, "the draft AHADJ bill");
    assert.doesNotMatch(all, /TRN-60000001/, "the holdback received on 20 August, before the books");
    assert.equal((await payerFeesByMonth()).has("2026-08"), false);
    assert.equal(r.counted.some((l) => l.remittance === "EFT-9000003"), true, "it is on no payment report, so the adjustment report's line is the record");
  });
  test("every fee line is on exactly one of counted, kept out and held", async () => {
    const r = await loadPayerFees();
    const n = r.counted.length + r.keptOut.length + r.held.length;
    assert.equal(n, 8, "five adjustment-report lines and three 835 lines; the fourth 835 line was received before the books and is not loaded");
  });
});
