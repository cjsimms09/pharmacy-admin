import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { useScratchDb } from "./support/scratch-db";

/*
 * A fill PioneerRx supplied first is adopted by the report's row, and takes the report's NDC.
 *
 * Rx 343320 (20-23 October 2026) was billed, reversed and billed again under another product; the row PioneerRx had supplied kept the first
 * product's NDC after the report took it over, and the nightly proof said "2 claims disagree with the reports they were read from".
 * Invented Rx numbers, NDCs and amounts.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanup: () => void;

before(async () => {
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
});
after(() => cleanup());

const HEAD = [
  "Rx Transaction Details By Submission Type (BETA)",
  "West Wichita Family Pharmacy",
  " Uses invoice cost based on cost for profit settings. Includes columns for estimated rebates and estimated dir fees.Based on claims transmitted/processed from ",
  "9/5/2026 12:00:00 AM, to ,9/6/2026 12:00:00 AM",
  "Third Party,Script",
  "Dispensing Fee,Completed Date",
  "Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Tax,QTY,Acq. Inv. Cost,PCN,NDC,GrossProfit",
  "Transmitted",
];
const FOOT = ["9/5/2026 1:51 PM,*Evoucher Paid is a portion of the third party total.,Page 1 of 1"];

describe("adoption takes the report's NDC", () => {
  test("the adopted row carries the NDC the report says, and the key it was given", async () => {
    const { newId } = await import("../src/lib/crypto");
    const importId = newId();
    await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test" });
    await db.insert(schema.claims).values({ id: "c-pioneer", importId, rxNumber: "900021", fillNumber: 0, dateFilled: "2026-09-14", ndc11: "00000000001", bin: "012833", status: "paid", remitCents: 8_944, copayCents: 7_499, source: "pioneer_sql" });
    const text = [...HEAD, "Third Party:,012833 (EXAMPLE) - 012833", "900021-0,P,$89.44,G1,,$74.99,$0.00,$74.99,9/14/2026 9:00:00 AM,09/14/26,012833,30.0000,$1.00,EXAMPLE,00093505698,$3.00", ...FOOT].join("\r\n");
    const { importRxTransactions } = await import("../src/lib/claims");
    await importRxTransactions(Buffer.from(text), "Daily test.txt", "the test");
    const rows = await db.query.claims.findMany({ where: (t, { eq }) => eq(t.rxNumber, "900021") });
    assert.equal(rows.length, 1, "one fill, one paid row");
    assert.equal(rows[0].id, "c-pioneer");
    assert.equal(rows[0].source, "transaction_report");
    assert.equal(rows[0].ndc11, "00093505698");
  });
});
