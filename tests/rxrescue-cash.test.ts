import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rxRescueMemoKey } from "../src/lib/rxrescue-credit";

/*
 * An Aytu / IPD credit memo is cash: IPD applies it against its own invoices ("AutoAROffset"), so no deposit reaches the
 * bank and no other feed brings it in. The memo import banks its whole credit once, keyed on the day and the amount, which
 * IPD's statement prints too. Nothing is imported at the top that reaches the database (tests/support/scratch-db.ts).
 */
let importRxRescueCredit: typeof import("../src/lib/claim-payments").importRxRescueCredit;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ importRxRescueCredit } = await import("../src/lib/claim-payments"));
  ({ db, schema } = await import("../src/db"));
});
after(() => cleanUpDb?.());

const HEAD =
  "Transaction ID,Rx Number,Processing Group Number,NDC,Product Name,Transaction Date,Pharmacy NABP,Pharmacy Name,OCC Code,Qty Dispensed,Primary Payer Reimb,Pt Out of Pocket,RxRescue Top Off Amount/Credit,Final Patient Pay/ OOP,Pt Copay Asst,Dispensing Fee,Total Credit Payment to Pharmacy,Credit Memo ID,Credit Memo Issue Date";
const MEMO = [
  HEAD,
  "tx-1,000000900000,99991001,62542002030,EXAMPLE AG,2026-09-02,0000000,EXAMPLE PHARMACY,08,60.0,926.52,60.0,49.94,0.0,60.0,0.0,109.94,C-00000001C20260915,2026-09-20",
  "tx-2,000000900003,99991001,70165030030,EXAMPLE XR,2026-09-03,0000000,EXAMPLE PHARMACY,03,30.0,0.0,538.7,0.0,50.0,511.2,22.5,511.2,C-00000001C20260915,2026-09-20",
].join("\n");

describe("an RxRescue credit memo in the cash account", () => {
  test("the whole credit is one third-party receipt on the day it issued, and the same memo again banks nothing", async () => {
    await importRxRescueCredit(Buffer.from(MEMO), "credit memo.csv", { name: "the test" });
    await importRxRescueCredit(Buffer.from(MEMO), "credit memo.csv", { name: "the test" });
    const receipts = (await db.select().from(schema.cashReceipts)).filter((r) => (r.sourceKey ?? "").startsWith("rxrescue-memo|"));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].amountCents, 10_994 + 51_120);
    assert.equal(receipts[0].kind, "third_party");
    assert.equal(receipts[0].receivedOn, "2026-09-20");
    assert.equal(receipts[0].sourceKey, rxRescueMemoKey("2026-09-20", 62_114));
  });

  test("IPD's statement names the same credit by another id, so the key is its day and amount", () => {
    assert.equal(rxRescueMemoKey("2026-09-03", -1_070_620), rxRescueMemoKey("2026-09-03", 1_070_620), "the statement prints the credit negative");
    assert.notEqual(rxRescueMemoKey("2026-09-03", 1_070_620), rxRescueMemoKey("2026-08-18", 1_070_620));
  });
});
