import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/*
 * A counter deposit decided by hand does not take register days a bank line already stands behind.
 *
 * Found 7 October 2026, reading the four places that work out "which receipts has a bank line confirmed". Three of them
 * read bank_lines.receipt_id (the first receipt a line confirmed) and bank_line_receipts (all of them). The fourth, the
 * "counter deposit of these days" decision, read only the first. A run of register days confirmed by one line has its
 * second and later days in the join table only, so a later decision over an overlapping range took them again: the sum came
 * out too large, the difference was negative, and a "Cash short" cost was booked for money the till had never been short of.
 *
 * Every date, amount and key here is invented.
 */
let decideBankLine: typeof import("../src/app/(app)/money/bank").decideBankLine;
let addCashReceipt: typeof import("../src/lib/expenses").addCashReceipt;
let engineRefresh: typeof import("../src/lib/engine/run").engineRefresh;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let sql: typeof import("drizzle-orm").sql;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ sql } = await import("drizzle-orm"));
  ({ decideBankLine } = await import("../src/app/(app)/money/bank"));
  ({ addCashReceipt } = await import("../src/lib/expenses"));
  ({ engineRefresh } = await import("../src/lib/engine/run"));
});

after(() => cleanUpDb?.());

const USER = { id: "test-user", name: "Test" };

const registerDay = async (day: string, cents: number): Promise<string> => {
  const made = await addCashReceipt({ month: day.slice(0, 7), kind: "patient", amountCents: cents, payer: "Register", sourceKey: `register|${day}`, receivedOn: day, createdBy: USER.name });
  assert.ok(made.id, `the register day ${day} was banked`);
  return made.id;
};

const bankLine = async (key: string, on: string, cents: number, placedAs: string, receiptId: string | null = null) => {
  await db.insert(schema.bankLines).values({ id: `id-${key}`, key, on, description: "COUNTER DEPOSIT", amountCents: cents, placedAs, receiptId, createdBy: USER.name });
  return `id-${key}`;
};

/* The decision starts a background engine pass; waiting for it keeps it from running over the checks or the clean-up. */
const decide = async (lineId: string, from: string, to: string) => {
  const res = await decideBankLine(lineId, { kind: "confirms_run", from, to, note: "test" }, USER);
  await engineRefresh("test");
  return res;
};

const linkedTo = async (lineId: string) =>
  ((await db.all(sql`select receipt_id r from bank_line_receipts where line_id = ${lineId} order by receipt_id`)) as { r: string }[]).map((x) => x.r);
const shortCosts = async (lineKey: string) =>
  ((await db.all(sql`select amount_cents c from expenses where invoice_number = ${`BANK|${lineKey}|short`}`)) as { c: number }[]).map((x) => x.c);

describe("a run decided by hand leaves out receipts any bank line already confirms", () => {
  test("REGRESSION: the second day of an earlier multi-day confirmation is not taken again", async () => {
    const r1 = await registerDay("2026-09-02", 41_234);
    const r2 = await registerDay("2026-09-03", 17_650);
    const r3 = await registerDay("2026-09-04", 26_500);
    const r4 = await registerDay("2026-09-05", 9_875);

    /* An earlier line confirmed days 1 and 2: the column holds the first, the join table both. */
    const earlier = await bankLine("a-1", "2026-09-04", 41_234 + 17_650, "confirms_deposit", r1);
    await db.insert(schema.bankLineReceipts).values([{ lineId: earlier, receiptId: r1 }, { lineId: earlier, receiptId: r2 }]);
    /* Another line confirmed day 4 through the column alone, as a line placed before the join table existed did. */
    await bankLine("a-2", "2026-09-06", 9_875, "deposit", r4);

    const line = await bankLine("a-3", "2026-09-07", 26_500, "unplaced");
    const res = await decide(line, "2026-09-02", "2026-09-05");

    assert.equal(res.ok, true, res.ok ? "" : res.why);
    assert.deepEqual(await linkedTo(line), [r3], "only the day nothing had confirmed");
    assert.deepEqual(await shortCosts("a-3"), [], "no shortage is booked against a deposit that matches the day it was for");
    assert.equal(((await db.all(sql`select count(*) n from cash_receipts where source_key like 'bank-overshort|%'`)) as { n: number }[])[0].n, 0, "no overage either");
    const placed = await db.query.bankLines.findFirst({ where: (t, { eq }) => eq(t.id, line) });
    assert.equal(placed?.placedAs, "confirms_deposit");
    assert.equal(placed?.receiptId, r3);
    assert.match(placed?.why ?? "", /to the cent/);
  });

  test("with nothing confirmed earlier it takes every day in the range, and a deposit short of them books the shortage", async () => {
    const r1 = await registerDay("2026-10-02", 30_000);
    const r2 = await registerDay("2026-10-03", 12_500);
    const r3 = await registerDay("2026-10-04", 7_000);

    const line = await bankLine("b-1", "2026-10-05", 30_000 + 12_500 + 7_000 - 100, "unplaced");
    const res = await decide(line, "2026-10-02", "2026-10-04");

    assert.equal(res.ok, true, res.ok ? "" : res.why);
    assert.deepEqual(await linkedTo(line), [r1, r2, r3].sort());
    assert.deepEqual(await shortCosts("b-1"), [100]);
  });
});

describe("one function says which receipts a bank line confirms", () => {
  test("the decision and the placement both read it, and neither keeps a copy of the two-source read", async () => {
    const bank = await readFile("src/app/(app)/money/bank.ts", "utf8");
    assert.equal(bank.match(/receiptsConfirmedByBank\(\)/g)?.length, 2, "the placement and the decision each call it");
    assert.doesNotMatch(bank, /db\.query\.bankLineReceipts\.findMany/, "no second copy of the read in bank.ts");
    for (const file of ["src/lib/bank-match-context.ts", "src/lib/engine/month.ts"]) {
      const text = await readFile(file, "utf8");
      assert.match(text, /receiptsConfirmedByBank\(\)/, file);
      assert.doesNotMatch(text, /db\.query\.bankLineReceipts\.findMany/, `${file} keeps no copy`);
    }
  });

  test("the one place that keeps its own SQL form of the question, the cash account's list of receipts not yet at the bank, reads both sources", async () => {
    const text = await readFile("src/lib/cash-from-bank.ts", "utf8");
    assert.match(text, /not in \(select receipt_id from bank_lines where receipt_id is not null\)/, "the first receipt of each line");
    assert.match(text, /not in \(select receipt_id from bank_line_receipts\)/, "every receipt of each line");
  });
});
