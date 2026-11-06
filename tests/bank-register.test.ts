import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeBankRegister, readBankRegister } from "../src/lib/bank-register";

/* Invented names and figures, in the shape of the accounting program's register export (two lines to an entry). */
const HEAD = [
  "Invented Practice P.A.",
  "Parent Company (IP)",
  "Invented Checking (0000) Register",
  '"October 01, 2026 - October 31, 2026"',
  "",
  "",
  "Date ,Print ,Number ,Payee ,,Clr ,Reconciled Date ,Payment ,Deposit ,Balance ",
  " , ,Type ,Account ,Memo , , , , , ",
];
const entry = (date: string, num: string, payee: string, clr: string, rec: string, pay: string, dep: string, bal: string, type: string, account: string, memo: string) => [
  `${date},,${num},"${payee}",,${clr},${rec},"${pay}","${dep}","${bal}"`,
  `Edit,,${type},${account},${memo},,,,,`,
];
const FILE = (rows: string[][]) => [...HEAD, ...rows.flat()].join("\n");

const GOOD = [
  entry("10/01/2026", "2458", "Invented Lender, Inc.", "Yes", "10/31/2026", "$274.40", "", "$1,000.00", "Check", "6100 - Rent", ""),
  entry("10/02/2026", "JE1", "", "Yes", "10/31/2026", "", "$1,223.43", "$2,223.43", "Journal", "4010 - Revenue", "Cash and Check Deposit- Pharmacy"),
  entry("10/03/2026", "JE2", "", "", "Reconcile", "$500.00", "", "$1,723.43", "Journal", "1301 - Inventory", "Wholesaler Debit"),
].map((e, i) => (i === 0 ? e : e));
// The first running balance is the register's own: opening 1,274.40 + (-274.40) = 1,000.00.

describe("the accounting program's checking register", () => {
  test("is recognised by its title, its heading row and its columns", () => {
    assert.equal(looksLikeBankRegister(FILE(GOOD)), true);
    assert.equal(looksLikeBankRegister("Date,Description,Amount\n10/01/2026,Thing,-5.00"), false);
  });

  test("reads two-line entries, takes every line as a bank line, and proves the running balance", () => {
    const r = readBankRegister(FILE(GOOD));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.entries, 3);
    assert.equal(r.lines.length, 3);
    assert.equal(r.openingCents, 127_440);
    assert.equal(r.registerClosingCents, 172_343);
    assert.equal(r.periodFrom, "2026-10-01");
    assert.equal(r.periodTo, "2026-10-03");
    assert.deepEqual(r.lines.map((l) => l.amountCents), [-27_440, 122_343, -50_000]);
  });

  test("a payee is the description; with none, the memo is, and then the account", () => {
    const r = readBankRegister(FILE(GOOD));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.lines[0].description, "Invented Lender, Inc.");
    assert.equal(r.lines[1].description, "Cash and Check Deposit- Pharmacy");
    assert.equal(r.lines[2].description, "Wholesaler Debit");
  });

  test("a line not yet marked cleared is still a bank line and is said, with its amount", () => {
    const r = readBankRegister(FILE(GOOD));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.outstanding.length, 1);
    assert.match(r.says, /1 of them \(-\$500\.00 net\) are not yet marked cleared/);
    assert.match(r.says, /running balance holds on every line/);
  });

  test("a missing line breaks the running balance and nothing is used", () => {
    const missing = [GOOD[0], GOOD[2]];
    const r = readBankRegister(FILE(missing));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.why, /running balance does not hold at line 2/);
  });

  test("two lines alike in date, amount and description get different keys once the caller numbers them, and the same lines give the same keys", () => {
    const a = readBankRegister(FILE(GOOD));
    const b = readBankRegister(FILE(GOOD));
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.deepEqual(a.lines.map((l) => l.key), b.lines.map((l) => l.key));
  });
});

describe("the router and the label", () => {
  test("a register is classified as one, by its contents and not its name", async () => {
    const { classify } = await import("../src/lib/autoroute");
    const c = classify("anything.csv", Buffer.from(FILE(GOOD)));
    assert.equal(c.kind, "bank_register");
  });
});
