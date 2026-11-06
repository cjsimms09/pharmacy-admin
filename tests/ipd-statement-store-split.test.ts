import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support/fixtures";

/*
 * Filing a statement whose credit memo is applied in two parts, on a scratch database, and a credit already banked from the
 * RxRescue report within a week of the memo. Every value is invented; the text is fixtures/ipd-statement-split-credit.txt.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let fileIpdStatement: typeof import("../src/lib/ipd-statement-store").fileIpdStatement;
let cleanup: () => void;
const text = fixture("fixtures/ipd-statement-split-credit.txt");
const by = { name: "the test" };

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ fileIpdStatement } = await import("../src/lib/ipd-statement-store"));
});
after(() => cleanup());

const receipts = async () => (await db.select().from(schema.cashReceipts)).filter((r) => /^rxrescue-memo\|/.test(r.sourceKey ?? ""));

describe("a credit memo applied in two parts is banked once, at the whole of it", () => {
  test("nothing near it on the books: the memo banks once at its total, and each part is its own payment", async () => {
    const r = await fileIpdStatement({ text, documentId: null, fileName: "statement.pdf" }, by);
    assert.equal(r.refused, false, r.says);
    assert.equal(r.payments, 3, "three settlements, so three payments");
    assert.equal(r.banked, 2, "two memos, banked once each though one of them is applied in two parts");
    const banked = (await receipts()).map((x) => [x.receivedOn, x.amountCents]).sort();
    assert.deepEqual(banked, [["2026-11-03", 110_000], ["2026-11-18", 420_000]]);
  });

  test("filing the same statement again changes nothing", async () => {
    const r = await fileIpdStatement({ text, documentId: null, fileName: "statement.pdf" }, by);
    assert.equal(r.payments, 0);
    assert.equal(r.banked, 0);
    assert.equal((await receipts()).length, 2);
  });
});

describe("a credit the RxRescue report already banked a few days away is not banked a second time", () => {
  test("a receipt two days later with a different amount stops the memo and says why", async () => {
    await db.delete(schema.cashReceipts);
    await db.delete(schema.supplierPayments);
    const { addCashReceipt } = await import("../src/lib/expenses");
    await addCashReceipt({ month: "2026-11", kind: "third_party", amountCents: 105_000, payer: "Aytu / IPD (RxRescue)", receivedOn: "2026-11-05", reference: "C-TEST", sourceKey: "rxrescue-memo|2026-11-05|105000", createdBy: "the test" });
    const r = await fileIpdStatement({ text, documentId: null, fileName: "statement.pdf" }, by);
    assert.match(r.says, /A credit of \$1,050\.00 is already banked for 2026-11-05 and this memo, dated 2026-11-03, is \$1,100\.00\. Nothing was banked/);
    const banked = (await receipts()).map((x) => x.receivedOn).sort();
    assert.deepEqual(banked, ["2026-11-05", "2026-11-18"], "the 18 November memo is far enough away to bank; the 3 November one is not banked");
  });
});
