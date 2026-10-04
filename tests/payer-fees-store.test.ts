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
 * counted from the report and the 835; 9000004 is a credit; October's TRN-70000001 is a balance forward; a draft bill,
 * a payment received before the books and an adjustment-report line dated August are not records of anything.
 *
 * Then what a person says about a line, written as an audit event and read back on every load.
 */
let loadPayerFees: typeof import("../src/lib/payer-fees-store").loadPayerFees;
let payerFeesByMonth: typeof import("../src/lib/payer-fees-store").payerFeesByMonth;
let loadFeeDecisions: typeof import("../src/lib/payer-fees-store").loadFeeDecisions;
let decideFee: typeof import("../src/lib/payer-fees-store").decideFee;
let cleanup: () => void;
let filesDir: string;

const REPORT = [
  "Location,Location Name,Adjustment Code,Adjustment Identifier,Adjustment Amount,Remittance Number,Remit Date,Posted Date,Payer Name,Document Sequence Number,Line Item Number",
  "1,Example Pharmacy,AH,,-10.00,EFT-9000001,09/10/2026,09/12/2026,Example Atlas,1,1",
  "1,Example Pharmacy,CS,,-12.00,EFT-9000002,09/11/2026,09/13/2026,Example Atlas,2,1",
  "1,Example Pharmacy,AH,,-4.00,EFT-9000005,09/12/2026,09/14/2026,Example Express,3,1",
  "1,Example Pharmacy,AH,,-4.00,EFT-9000003,09/13/2026,09/15/2026,Example Express,4,1",
  "1,Example Pharmacy,CS,,0.84,EFT-9000004,09/14/2026,09/16/2026,Example Atlas,5,1",
  "1,Example Pharmacy,AH,,-5.00,EFT-8000001,08/20/2026,08/22/2026,Example Atlas,6,1",
  "",
  ",,,,-34.16,,,,,,",
].join("\r\n");

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmacy-admin-files-"));
  process.env.FILES_DIR = filesDir;
  const { db, schema } = await import("../src/db");
  const { newId } = await import("../src/lib/crypto");
  const { storeFile } = await import("../src/lib/files");
  ({ loadPayerFees, payerFeesByMonth, loadFeeDecisions, decideFee } = await import("../src/lib/payer-fees-store"));

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
  test("October: a balance forward is not a fee, so nothing is counted and nothing waits for anybody", async () => {
    const oct = (await payerFeesByMonth()).get("2026-10")!;
    assert.equal(oct.countedCents, 0);
    assert.equal(oct.keptOutLines, 0);
    assert.equal(oct.heldLines, 0, "the rule is certain, so there is nothing for a person to decide");
    assert.equal(oct.notFeesCents, -46_95);
    assert.equal(oct.notFeesLines, 1);
    assert.match(oct.notFeesSays, /CS "balance forward" \$46\.95 added to the remittance, on TRN-70000001: a balance carried to a later remittance/);
  });
  test("a draft bill is not a fee, a payment received before the books is not a record, and another origin does not cover an EFT", async () => {
    const r = await loadPayerFees();
    const all = JSON.stringify(r);
    assert.doesNotMatch(all, /9000010/, "the draft AHADJ bill");
    assert.doesNotMatch(all, /TRN-60000001/, "the holdback received on 20 August, before the books");
    assert.doesNotMatch(all, /EFT-8000001/, "the adjustment report's own line dated 20 August, before the books");
    assert.equal((await payerFeesByMonth()).has("2026-08"), false);
    assert.equal(r.counted.some((l) => l.remittance === "EFT-9000003"), true, "it is on no payment report, so the adjustment report's line is the record");
  });
  test("every line is on exactly one of counted, kept out, held, not a fee and left out", async () => {
    const r = await loadPayerFees();
    const n = r.counted.length + r.keptOut.length + r.held.length + r.notFees.length + r.leftOut.length;
    assert.equal(n, 8, "five adjustment-report lines and three 835 lines; the August line of each is before the books and is not loaded");
    assert.equal(r.leftOut.length, 0, "nobody has said anything yet");
  });
});

describe("what a person says about a line", () => {
  const me = { id: "owner-1", name: "The Owner" };
  const CREDIT = "EFT-9000004|CS|-84";
  const SEVEN = "TRN-70000002|AH|700";
  type Result = Awaited<ReturnType<typeof decideFee>>;
  const said = (r: Result) => {
    assert.equal(r.ok, true, r.ok ? "" : r.why);
    return r.ok ? r.said : "";
  };
  const refused = (r: Result) => {
    assert.equal(r.ok, false, "a refusal was expected");
    return r.ok ? "" : r.why;
  };
  const written = async () => {
    const { db, schema } = await import("../src/db");
    const { eq } = await import("drizzle-orm");
    return db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entity, "payer_fee"));
  };
  const sept = async () => (await payerFeesByMonth()).get("2026-09")!;

  test("nothing has been said, so the rule alone decides", async () => {
    assert.deepEqual(await loadFeeDecisions(), []);
  });
  test("the latest word under a key stands, and a reopen is a word that beats the one before it", async () => {
    const { audit } = await import("../src/lib/audit");
    const say = (key: string, action: string) => audit({ action, userId: me.id, userName: me.name, entity: "payer_fee", entityId: key, details: "a test" });
    await say("EFT-0000091|AH|500", "payer_fee.counted");
    await say("EFT-0000091|AH|500", "payer_fee.left_out");
    await say("EFT-0000092|AH|500", "payer_fee.left_out");
    await say("EFT-0000092|AH|500", "payer_fee.reopened");
    const word = new Map((await loadFeeDecisions()).map((d) => [d.key, d.decision]));
    assert.equal(word.get("EFT-0000091|AH|500"), "leave_out");
    assert.equal(word.get("EFT-0000092|AH|500"), "reopen", "an undo has to be seen to beat what it undoes");
    assert.equal(word.size, 2);
    assert.equal((await sept()).countedCents, 11_00, "those two keys are on no line, so they change nothing");
  });
  test("counting the held credit puts it into September's fees, says so in words, and writes one event", async () => {
    const r = await decideFee(me, CREDIT, "count");
    assert.equal(r.ok && r.changed, true);
    assert.equal(said(r), "Counted against the fees: Example Atlas CS $0.84 added to the remittance, on EFT-9000004. It lowers September 2026's payer fees, and stays counted when the next import arrives.");
    const sep = await sept();
    assert.equal(sep.heldLines, 0);
    assert.equal(sep.countedLines, 3);
    assert.equal(sep.countedCents, 11_00 - 84);
    assert.equal(sep.decidedSays, "1 line counted that the rule would not have (-$0.84)");
    const events = (await written()).filter((e) => e.entityId === CREDIT);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "payer_fee.counted");
    assert.equal(events[0].userName, me.name);
    assert.match(events[0].details ?? "", /September 2026/);
  });
  test("the same press again changes nothing, and says it changed nothing", async () => {
    const before = (await written()).length;
    const again = await decideFee(me, CREDIT, "count");
    assert.equal(said(again), "Already counted against the fees: Example Atlas CS $0.84 added to the remittance, on EFT-9000004. Nothing was changed.");
    assert.equal(again.ok && again.changed, false, "a press that changed nothing says so, so that nothing downstream is asked to move");
    assert.equal((await written()).length, before);
  });
  test("the other word moves it again: left out, it is on no account, and the rule's figure is not moved", async () => {
    assert.equal(said(await decideFee(me, CREDIT, "leave_out")), "Left out: Example Atlas CS $0.84 added to the remittance, on EFT-9000004. It is not in September 2026's payer fees, and stays out when the next import arrives.");
    const sep = await sept();
    assert.equal(sep.countedCents, 11_00);
    assert.equal(sep.leftOutLines, 1);
    assert.equal(sep.leftOutCents, -84);
    assert.equal(sep.decidedSays, "", "the rule would not have counted it either, so his word moved nothing");
    assert.match((await loadPayerFees()).leftOut[0].ruleSaid, /a credit from the payer/);
  });
  test("a reopen gives the line back to the rule, which holds it again; a second reopen is refused", async () => {
    assert.match(said(await decideFee(me, CREDIT, "reopen")), /^Back to the rule: Example Atlas CS \$0\.84 added to the remittance, on EFT-9000004\. The rule cannot count it \(a credit from the payer rather than a recoupment, and what it reverses is not on the report\), so it waits for your decision again\.$/);
    const sep = await sept();
    assert.equal(sep.heldLines, 1);
    assert.equal(sep.heldCents, -84);
    assert.equal(sep.leftOutLines, 0);
    const before = (await written()).length;
    assert.match(refused(await decideFee(me, CREDIT, "reopen")), /has no decision of yours to undo/);
    assert.equal((await written()).length, before);
  });
  test("a line the rule counts can be left out, the month says its figure moved, and a reopen gives it back", async () => {
    assert.equal(said(await decideFee(me, SEVEN, "leave_out")), "Left out: Example Payer AH $7.00 taken from the remittance, on TRN-70000002. It is not in September 2026's payer fees, and stays out when the next import arrives.");
    let sep = await sept();
    assert.equal(sep.countedCents, 4_00);
    assert.equal(sep.leftOutCents, 7_00);
    assert.equal(sep.decidedSays, "1 line the rule would have counted left out ($7.00)");
    assert.match(said(await decideFee(me, SEVEN, "reopen")), /The rule counts it as a fee\.$/);
    sep = await sept();
    assert.equal(sep.countedCents, 11_00);
    assert.equal(sep.decidedSays, "");
  });
  test("a line nobody can decide is refused in words, and nothing is written", async () => {
    const before = (await written()).length;
    assert.equal(refused(await decideFee(me, "not a key", "count")), "That is not a line of a remittance. Nothing was changed.");
    assert.equal(refused(await decideFee(me, "EFT-0000000|AH|500", "count")), "That line is not on file any more. Nothing was changed.");
    assert.equal(
      refused(await decideFee(me, "EFT-9000001|AH|1000", "leave_out")),
      "That line is counted once already, from the Health Mart Atlas payment report, so a decision on this copy of it would change nothing: Example Atlas AH $10.00 taken from the remittance, on EFT-9000001. Nothing was changed.",
    );
    assert.match(refused(await decideFee(me, "TRN-70000001|CS|-4695", "count")), /^That line is not a fee, so there is nothing to decide\. Example Payer CS "balance forward" \$46\.95 added to the remittance, on TRN-70000001: a balance carried to a later remittance/);
    assert.equal((await written()).length, before);
  });
  test("his word survives a better record of the same line arriving under another spelling of the remittance", async () => {
    const { db, schema } = await import("../src/db");
    const { eq } = await import("drizzle-orm");
    const { newId } = await import("../src/lib/crypto");
    const THREE = "EFT-9000003|AH|400";
    assert.match(said(await decideFee(me, THREE, "leave_out")), /^Left out: Example Express AH \$4\.00 taken from the remittance, on EFT-9000003\./);
    assert.equal((await sept()).countedCents, 7_00);
    const arrived = newId();
    await db.insert(schema.remittanceHoldbacks).values({ id: arrived, traceNumber: "9000003", payer: "Example Payer", reasonCode: "AH", reference: "", amountCents: 4_00, receivedOn: "2026-09-13", outOfBooks: false });
    try {
      const r = await loadPayerFees();
      assert.deepEqual(r.leftOut.map((l) => [l.remittance, l.from]), [["9000003", "the 835"]], "the 835 is the better record now, and it is left out as he said");
      assert.equal(r.counted.some((l) => l.remittance.includes("9000003")), false);
      assert.equal(r.held.length, 1, "only the credit still waits; he is not asked about this line again");
      assert.equal((await sept()).countedCents, 7_00);
      assert.equal((await sept()).differ.includes("9000003"), false, "the two records of it agree");
    } finally {
      await db.delete(schema.remittanceHoldbacks).where(eq(schema.remittanceHoldbacks.id, arrived));
      assert.match(said(await decideFee(me, THREE, "reopen")), /The rule counts it as a fee\.$/);
    }
    assert.equal((await sept()).countedCents, 11_00);
  });
  test("a line that carries no date can be decided, and the answer says that no month's figure moves", async () => {
    const { db, schema } = await import("../src/db");
    const { eq } = await import("drizzle-orm");
    const { newId } = await import("../src/lib/crypto");
    const KEY = "TRN-70000009|ZZ|300";
    const id = newId();
    await db.insert(schema.remittanceHoldbacks).values({ id, traceNumber: "TRN-70000009", payer: "Example Payer", reasonCode: "ZZ", reference: "", amountCents: 3_00, receivedOn: null, outOfBooks: false });
    try {
      assert.equal(said(await decideFee(me, KEY, "count")), "Counted as a fee: Example Payer ZZ $3.00 taken from the remittance, on TRN-70000009. The line carries no date, so no month's payer fees change; your word is kept for when a dated record of it arrives.");
      assert.equal((await sept()).countedCents, 11_00);
      assert.match((await written()).filter((e) => e.entityId === KEY)[0].details ?? "", /, no date\.$/);
    } finally {
      await decideFee(me, KEY, "reopen");
      await db.delete(schema.remittanceHoldbacks).where(eq(schema.remittanceHoldbacks.id, id));
    }
  });
  test("every press the card offers is one decideFee acts on, and every line it offers none on is one decideFee refuses", async () => {
    const { feesView } = await import("../src/lib/payer-fees-view");
    const v = feesView(await loadPayerFees(), ["2026-09", "2026-10"], "September and October 2026");
    const all = [...v.waiting, ...v.counted, ...v.leftOut, ...v.notFees, ...v.keptOut];
    const offered = all.filter((r) => r.presses.length);
    const none = all.filter((r) => !r.presses.length);
    assert.ok(offered.length >= 3 && none.length >= 5, "the fixture has lines of every kind, or this proves nothing");
    for (const r of none) assert.equal((await decideFee(me, r.key, "count")).ok, false, `${r.says} offers no press, so a press on it must be refused`);
    const before = (await written()).length;
    let presses = 0;
    for (const r of offered) {
      for (const p of r.presses) {
        const res = await decideFee(me, r.key, p.to);
        assert.equal(res.ok && res.changed, true, `${r.says}: "${p.label}" is offered, so it must do something`);
        presses++;
      }
    }
    assert.equal((await written()).length, before + presses);
    for (const r of offered) await decideFee(me, r.key, "reopen");
  });
});
