import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readAccountHistory, whatMadeUpTransfer, payerFrom, looksLikeAccountHistory } from "../src/lib/providerpay-account";
import { classify } from "../src/lib/autoroute";

/** The shape ProviderPay actually exports, taken from a real August download. */
const FILE = [
  '"Date","Location","Payment number","Description","Amount"',
  '"2026-08-31","7000017 - Example Family Pharmacy","999000000000001","ARGUS HEALTH SYS  999000000000001  20260831",1250.36',
  '"2026-08-31","","","ProviderPay Transfer",-1250.36',
  '"2026-08-28","7000017 - Example Family Pharmacy","999000000000002","DOMANIRX  999000000000002  20260817",904',
  '"2026-08-28","7000017 - Example Family Pharmacy","999000000000003","EXPRESS SCRIPTS  999000000000003  20260828",8008.09',
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

  test("each transfer is checked against everything deposited since the last one", () => {
    const m = readAccountHistory(FILE);
    assert.deepEqual(
      m.sweeps.map((s) => [s.on, s.agrees]),
      [
        ["2026-08-28", true],
        ["2026-08-31", true],
      ],
    );
  });

  test("a deposit on a day with no sweep goes out with the next one", () => {
    /*
     * The case that broke the per-day check. On 20 July a $2.85 LucyRx payment landed and nothing
     * swept that day; it left on the 22nd. Per day the 22nd's transfer is wrong by $2.85. Per
     * sweep it is exact, which is what the account actually did.
     */
    const carried = [
      '"Date","Location","Payment number","Description","Amount"',
      '"2026-07-22","7000017 - Example Pharmacy","999000000000004","DOMANIRX  999000000000004  20260722",1302.02',
      '"2026-07-22","","","ProviderPay Transfer",-1304.87',
      '"2026-07-20","7000017 - Example Pharmacy","99900000000005","LUCYRX  99900000000005  20260720",2.85',
    ].join("\n");
    const m = readAccountHistory(carried);
    assert.equal(m.sweeps.length, 1);
    assert.equal(m.sweeps[0].agrees, true, "the sweep took the 20th's deposit as well as the 22nd's");
    assert.deepEqual(m.sweeps[0].deposits.map((d) => d.payer), ["LUCYRX", "DOMANIRX"]);
    assert.equal(m.awaitingTransferCents, 0);

    const r = whatMadeUpTransfer(m, { date: "2026-07-22", amountCents: -130_487 });
    assert.equal(r.agrees, true);
    assert.ok(r.says.includes("2026-07-20"), "says the sweep spans two days rather than hiding it");
  });

  test("money still in the sweep is reported, not hidden", () => {
    /*
     * Ordinary at a month end - a payment landing on the 31st is swept on the 1st - and exactly why
     * cash is dated on the transfer. This money is not in the pharmacy's bank yet.
     */
    const unswept = FILE.split("\n").filter((l) => !l.includes("-1250.36")).join("\n");
    const m = readAccountHistory(unswept);
    assert.equal(m.awaitingTransferCents, 125_036);
    // It is not folded into an earlier sweep to make the books look tidy: that sweep still balances.
    assert.deepEqual(m.sweeps.map((s) => [s.on, s.agrees]), [["2026-08-28", true]]);
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
    assert.deepEqual(r.deposits.map((d) => d.paymentNumber), ["999000000000002", "999000000000003"]);
    assert.ok(r.says.includes("DOMANIRX") && r.says.includes("EXPRESS SCRIPTS"));
  });

  test("a lump nothing explains says so rather than guessing", () => {
    const m = readAccountHistory(FILE);
    const r = whatMadeUpTransfer(m, { date: "2026-08-14", amountCents: -50_000 });
    assert.equal(r.agrees, false);
    assert.equal(r.deposits.length, 0);
    assert.ok(r.says.includes("day before"), "points at the likeliest cause rather than stopping");
  });

  test("a sweep is never explained by money that landed after it", () => {
    // Reaching back to an un-swept deposit is right; reaching forward would explain Tuesday's
    // lump with Thursday's payments, which is the fault the day-only rule was guarding against.
    const m = readAccountHistory(FILE);
    const r = whatMadeUpTransfer(m, { date: "2026-08-28", amountCents: -125_036 });
    assert.equal(r.agrees, false, "the 31st's deposit must not explain a transfer on the 28th");
    assert.ok(r.says.includes("not the same transfer"));
  });

  test("the payer is read off the description", () => {
    assert.equal(payerFrom("ARGUS HEALTH SYS  999000000000001  20260831"), "ARGUS HEALTH SYS");
    assert.equal(payerFrom("EXPRESS SCRIPTS  999000000000003  20260828"), "EXPRESS SCRIPTS");
    assert.equal(payerFrom("ProviderPay Transfer"), "ProviderPay Transfer");
    assert.equal(payerFrom("999000000000001"), null, "a bare number is not a payer name");
  });

  test("a payer name containing a comma does not shift the columns", () => {
    /*
     * Splitting on commas would put the amount in the wrong field, and a junk amount is skipped
     * rather than shouted about - so the money would vanish silently.
     */
    const tricky = [
      '"Date","Location","Payment number","Description","Amount"',
      '"2026-08-05","7000017 - Example Pharmacy","999","SMITH, JONES & CO  999  20260805",1500.25',
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

  test("the router knows it, and does not confuse it with the payment report", () => {
    /*
     * Both come out of ProviderPay and both carry a payment number, so the pair has to be told
     * apart by what else is there. Before this the account history fell through to "unrecognised"
     * and was filed as a nameless report — the sweep data was on disk and nothing knew what it was.
     */
    assert.equal(classify("download.csv", Buffer.from(FILE, "utf8")).kind, "providerpay_account");

    const paymentReport = [
      '"Payment number","Payer name","Deposit date","Payment amt","Payment type"',
      '"999000000000001","ARGUS HEALTH SYS","2026-08-31",1250.36,"EFT"',
    ].join("\n");
    assert.equal(classify("download.csv", Buffer.from(paymentReport, "utf8")).kind, "payer_payments");
  });
});
