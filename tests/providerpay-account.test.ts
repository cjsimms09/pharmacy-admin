import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readAccountHistory, whatMadeUpTransfer, payerFrom, looksLikeAccountHistory } from "../src/lib/providerpay-account";

/** The shape ProviderPay actually exports, taken from a real August download. */
const FILE = [
  '"Date","Location","Payment number","Description","Amount"',
  '"2026-08-31","1722734 - West Wichita Family Pharmacy","101000017856767","ARGUS HEALTH SYS  101000017856767  20260831",1250.36',
  '"2026-08-31","","","ProviderPay Transfer",-1250.36',
  '"2026-08-28","1722734 - West Wichita Family Pharmacy","101000017072227","DOMANIRX  101000017072227  20260817",904',
  '"2026-08-28","1722734 - West Wichita Family Pharmacy","242071753425157","EXPRESS SCRIPTS  242071753425157  20260828",8008.09',
  '"2026-08-28","","","ProviderPay Transfer",-8912.09',
].join("\n");

describe("the ProviderPay sweep account", () => {
  test("it is recognised by its columns, not its name", () => {
    // The portal names these by the day they were downloaded, so two months arrive named the same.
    assert.equal(looksLikeAccountHistory(FILE), true);
    assert.equal(looksLikeAccountHistory("Date,Amount\n2026-08-01,5"), false);
  });

  test("deposits and transfers are told apart, and the transfer is held positive", () => {
    const m = readAccountHistory(FILE);
    assert.equal(m.problems.length, 0);
    assert.equal(m.lines.length, 5);
    assert.deepEqual(
      m.lines.map((l) => l.kind),
      ["deposit", "transfer", "deposit", "deposit", "transfer"],
    );
    // Printed negative in the file; held positive here, because it is what arrived at the bank.
    assert.equal(m.transferredCents > 0, true);
  });

  test("the month balances: what came in went out", () => {
    const m = readAccountHistory(FILE);
    assert.equal(m.depositedCents, 125_036 + 90_400 + 800_809);
    assert.equal(m.transferredCents, 125_036 + 891_209);
    assert.equal(m.awaitingTransferCents, 0);
  });

  test("a day's transfer is checked against that day's deposits", () => {
    const m = readAccountHistory(FILE);
    assert.deepEqual(
      m.byDay.map((d) => [d.date, d.agrees]),
      [
        ["2026-08-28", true],
        ["2026-08-31", true],
      ],
    );
  });

  test("money still in the sweep is reported, not hidden", () => {
    /*
     * Ordinary at a month end - a payment landing on the 31st is swept on the 1st - and exactly why
     * cash is dated on the transfer. This money is not in the pharmacy's bank yet.
     */
    const unswept = FILE.split("\n").filter((l) => !l.includes("-1250.36")).join("\n");
    const m = readAccountHistory(unswept);
    assert.equal(m.awaitingTransferCents, 125_036);
    assert.equal(m.byDay.find((d) => d.date === "2026-08-31")!.agrees, false);
  });

  test("a bank lump resolves into the payers behind it", () => {
    /*
     * The whole point. A bank statement shows "ProviderPay Transfer $8,912.09" and nothing else -
     * no payer, no payment number. This turns it back into two payers and two payment numbers.
     */
    const m = readAccountHistory(FILE);
    const r = whatMadeUpTransfer(m, { date: "2026-08-28", amountCents: -891_209 });
    assert.equal(r.agrees, true);
    assert.equal(r.deposits.length, 2);
    assert.deepEqual(r.deposits.map((d) => d.paymentNumber), ["101000017072227", "242071753425157"]);
    assert.ok(r.says.includes("DOMANIRX") && r.says.includes("EXPRESS SCRIPTS"));
  });

  test("a lump nothing explains says so rather than guessing", () => {
    const m = readAccountHistory(FILE);
    const r = whatMadeUpTransfer(m, { date: "2026-08-14", amountCents: -50_000 });
    assert.equal(r.agrees, false);
    assert.equal(r.deposits.length, 0);
    assert.ok(r.says.includes("day before"), "points at the likeliest cause rather than stopping");
  });

  test("deposits are matched within the day, never across days", () => {
    // A looser match would happily explain Tuesday's lump with Thursday's payments.
    const m = readAccountHistory(FILE);
    const r = whatMadeUpTransfer(m, { date: "2026-08-31", amountCents: -891_209 });
    assert.equal(r.agrees, false, "the 28th's deposits must not explain the 31st's transfer");
  });

  test("the payer is read off the description", () => {
    assert.equal(payerFrom("ARGUS HEALTH SYS  101000017856767  20260831"), "ARGUS HEALTH SYS");
    assert.equal(payerFrom("EXPRESS SCRIPTS  242071753425157  20260828"), "EXPRESS SCRIPTS");
    assert.equal(payerFrom("ProviderPay Transfer"), "ProviderPay Transfer");
    assert.equal(payerFrom("101000017856767"), null, "a bare number is not a payer name");
  });

  test("a payer name containing a comma does not shift the columns", () => {
    /*
     * Splitting on commas would put the amount in the wrong field, and a junk amount is skipped
     * rather than shouted about - so the money would vanish silently.
     */
    const tricky = [
      '"Date","Location","Payment number","Description","Amount"',
      '"2026-08-05","1722734 - WWFP","999","SMITH, JONES & CO  999  20260805",1500.25',
    ].join("\n");
    const m = readAccountHistory(tricky);
    assert.equal(m.problems.length, 0);
    assert.equal(m.lines[0].amountCents, 150_025);
    assert.equal(m.lines[0].payer, "SMITH, JONES & CO");
  });

  test("a file that is not an account history is refused with its columns named", () => {
    const m = readAccountHistory('"Rx","Qty"\n"1","2"');
    assert.equal(m.lines.length, 0);
    assert.ok(m.problems[0].includes("rx"), "says what it actually found");
  });

  test("an empty file is said to be empty rather than read as zero", () => {
    const m = readAccountHistory("");
    assert.equal(m.problems[0], "The file is empty.");
  });
});
