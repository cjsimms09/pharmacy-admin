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

  test("REGRESSION: with the primary's claim beside the programme's, the memo settles the programme's", async () => {
    /*
     * Measured 15 September 2026: on 23 of September's 26 RxRescue fills the site holds both claims. Without the
     * programme's BIN the matcher has two candidates and an amount (assistance plus top-off) equal to neither claim's
     * remit, so it refuses — and the credit attaches to no claim, the fill stays on the loss list, and it goes on saying
     * a top-off is expected after it has been paid.
     */
    const { newId } = await import("../src/lib/crypto");
    const importId = newId();
    await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test" });
    const claim = (bin: string, remitCents: number) => ({
      id: newId(), importId, rxNumber: "900500", fillNumber: 0, dateFilled: "2026-09-05", ndc11: "62542002030",
      bin, status: "paid" as const, remitCents, copayCents: 0, source: "transaction_report",
    });
    const acr = claim("024284", 1_000);
    await db.insert(schema.claims).values([claim("610097", 20_000), acr]);
    const memo = [HEAD, "tx-9,000000900500,99991001,62542002030,EXAMPLE AG,2026-09-05,0000000,EXAMPLE PHARMACY,08,30.0,200.0,10.0,25.0,0.0,10.0,0.0,35.0,C-00000002C20260915,2026-09-21"].join("\n");
    await importRxRescueCredit(Buffer.from(memo), "credit memo.csv", { name: "the test" });
    const payment = (await db.select().from(schema.claimPayments)).find((p) => p.reference === "tx-9");
    assert.equal(payment?.claimId, acr.id, "the programme's claim, not the primary's and not nothing");
    assert.equal(payment?.amountCents, 3_500, "the whole credit");
    assert.equal(payment?.revenueCents, 2_500, "of which the top-off is what the claim never carried");
  });

  test("IPD's statement names the same credit by another id, so the key is its day and amount", () => {
    assert.equal(rxRescueMemoKey("2026-09-03", -1_070_620), rxRescueMemoKey("2026-09-03", 1_070_620), "the statement prints the credit negative");
    assert.notEqual(rxRescueMemoKey("2026-09-03", 1_070_620), rxRescueMemoKey("2026-08-18", 1_070_620));
  });
});
