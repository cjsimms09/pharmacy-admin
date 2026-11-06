import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { historyReachOf, sweepDepositsFrom, SWEEP_TO_BANK_DAYS, type BankLineRow } from "../src/lib/engine/remit-sweep";
import { readAccountHistory } from "../src/lib/providerpay-account";
import { readBankDescriptor } from "../src/lib/bank-descriptors";

/*
 * Which deposits ProviderPay's account history proves reached the bank, from a history and the bank lines. The history is the file as the
 * portal prints it (providerpay-account.test.ts has the real shape); every payer, payment number and amount here is invented — payment
 * numbers are 15 digits beginning 999, and no amount is one the pharmacy has been paid.
 */
const HEAD = '"Date","Location","Payment number","Description","Amount"';
const deposit = (on: string, paymentNumber: string, payer: string, amount: string) =>
  `"${on}","7000017 - Example Family Pharmacy","${paymentNumber}","${payer}  ${paymentNumber}  ${on.replace(/-/g, "")}",${amount}`;
const transfer = (on: string, amount: string) => `"${on}","","","ProviderPay Transfer",-${amount}`;
const history = (...rows: string[]) => readAccountHistory([HEAD, ...rows].join("\n"));

const PN = { a: "999000000000031", b: "999000000000032", c: "999000000000033", d: "999000000000034" };

/* Two sweeps, the newest day first as the portal prints them: one payment on the 24th, two payments on the 22nd. */
const SEPT = () =>
  history(
    deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"),
    transfer("2026-09-24", "1840"),
    deposit("2026-09-22", PN.b, "INVENTED PAYER B", "1250.36"),
    deposit("2026-09-22", PN.c, "INVENTED PAYER C", "750.5"),
    transfer("2026-09-22", "2000.86"),
  );

const DESCRIBED = "ProviderPay/EDI PYM NTS 999000000000900 Invented Pharmacy";
const line = (id: string, on: string, amountCents: number, over: Partial<BankLineRow> = {}): BankLineRow => ({ id, on, amountCents, placedAs: "banks_remits", description: DESCRIBED, ...over });
const links = (...entries: [string, string[]][]) => new Map<string, string[]>(entries);
const proved = (found: ReturnType<typeof sweepDepositsFrom>) => found.map((d) => d.paymentNumber).sort();

describe("which deposits the account history proves reached the bank", () => {
  test("a deposit swept to a placed bank line of the sweep's amount is proved, and the receipts that line confirmed come with it", () => {
    const found = sweepDepositsFrom([SEPT()], [line("L1", "2026-09-24", 184_000)], links(["L1", ["rec-1"]]));
    assert.deepEqual(found, [{ paymentNumber: PN.a, amountCents: 184_000, lineReceiptIds: ["rec-1"] }]);
  });

  test("every deposit in a sweep goes out with its line, each at its own amount", () => {
    const found = sweepDepositsFrom([SEPT()], [line("L2", "2026-09-22", 200_086)], links(["L2", ["rec-2", "rec-3"]]));
    assert.deepEqual(
      found.map((d) => [d.paymentNumber, d.amountCents, d.lineReceiptIds]),
      [
        [PN.b, 125_036, ["rec-2", "rec-3"]],
        [PN.c, 75_050, ["rec-2", "rec-3"]],
      ],
    );
  });

  test("a line no receipt was made for still proves the deposit reached the bank, with nothing to spend", () => {
    assert.deepEqual(sweepDepositsFrom([SEPT()], [line("L1", "2026-09-24", 184_000, { placedAs: "deposit" })], new Map()), [{ paymentNumber: PN.a, amountCents: 184_000, lineReceiptIds: [] }]);
  });

  test("a line nobody has placed is an amount and nothing else, and proves nothing", () => {
    for (const placedAs of ["unplaced", "already_counted", "before_books", "noted"]) {
      assert.deepEqual(sweepDepositsFrom([SEPT()], [line("L1", "2026-09-24", 184_000, { placedAs })], new Map()), [], placedAs);
    }
  });

  test("a line of another amount proves nothing: the history says what left the account, the bank says what arrived", () => {
    assert.deepEqual(sweepDepositsFrom([SEPT()], [line("L1", "2026-09-24", 184_001)], new Map()), []);
  });

  test("a line the bank does not name as the PSAO's own proves nothing, however well its amount fits", () => {
    for (const description of ["Deposit", "CARD SETTLEMENT 999000000000900", "MCKESSON CORP ACH CREDIT"]) {
      assert.deepEqual(sweepDepositsFrom([SEPT()], [line("L1", "2026-09-24", 184_000, { description })], new Map()), [], description);
    }
  });

  test("every placement that says a line is payer money is accepted", () => {
    for (const placedAs of ["banks_remits", "confirms_deposit", "deposit"]) {
      assert.deepEqual(proved(sweepDepositsFrom([SEPT()], [line("L1", "2026-09-24", 184_000, { placedAs })], new Map())), [PN.a], placedAs);
    }
  });

  test("a line the bank names as Access Health's, not ProviderPay's, proves nothing even where its amount and day fit a sweep exactly", () => {
    const ACCESS = "ACCESSHEALTH EDI PYM NTS 999000000000901 Invented Pharmacy";
    const meaning = readBankDescriptor(ACCESS, 184_000);
    assert.equal(meaning.kind, "psao_remittance", "it is a PSAO line, so the amount and the placement cannot be what excludes it");
    assert.doesNotMatch(meaning.counterparty, /providerpay/i);
    for (const on of ["2026-09-24", "2026-09-25"]) {
      assert.deepEqual(sweepDepositsFrom([SEPT()], [line("L1", on, 184_000, { description: ACCESS })], new Map()), [], on);
    }
    assert.deepEqual(proved(sweepDepositsFrom([SEPT()], [line("L1", "2026-09-25", 184_000)], new Map())), [PN.a], "the same line described as ProviderPay's is proof");
  });

  test(`the line follows the sweep by no days to ${SWEEP_TO_BANK_DAYS}, never before it`, () => {
    const at = (on: string) => sweepDepositsFrom([SEPT()], [line("L1", on, 184_000)], new Map()).length;
    assert.equal(at("2026-09-23"), 0, "a line the day before the sweep cannot be it");
    assert.equal(at("2026-09-24"), 1, "the same day");
    assert.equal(at("2026-09-27"), 1, "three days: a transfer sent on a Friday is posted on the Monday");
    assert.equal(at("2026-09-28"), 0, "four days is too far to be sure it is the same money");
  });

  test("a sweep whose deposits do not add up to its transfer is not used: the file's edge or a mistake cut it", () => {
    const off = history(deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"), transfer("2026-09-24", "1800"));
    assert.equal(off.sweeps[0].agrees, false);
    assert.deepEqual(sweepDepositsFrom([off], [line("L1", "2026-09-24", 180_000)], new Map()), []);
  });

  test("a payment number that appears under two deposits proves neither", () => {
    const twice = history(
      deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"),
      transfer("2026-09-24", "1840"),
      deposit("2026-09-10", PN.a, "INVENTED PAYER A", "300"),
      deposit("2026-09-10", PN.d, "INVENTED PAYER D", "100"),
      transfer("2026-09-10", "400"),
    );
    const found = sweepDepositsFrom([twice], [line("L1", "2026-09-24", 184_000), line("L2", "2026-09-10", 40_000)], new Map());
    assert.deepEqual(proved(found), [PN.d], "the payment number seen twice is dropped; the one beside it in the same sweep is not");
  });

  test("a payment number of five digits is too short to be one and proves nothing; six is enough", () => {
    const sweep = (paymentNumber: string) => history(deposit("2026-09-24", paymentNumber, "INVENTED PAYER A", "1840"), transfer("2026-09-24", "1840"));
    assert.deepEqual(sweepDepositsFrom([sweep("12345")], [line("L1", "2026-09-24", 184_000)], new Map()), []);
    assert.deepEqual(proved(sweepDepositsFrom([sweep("123456")], [line("L1", "2026-09-24", 184_000)], new Map())), ["123456"]);
  });

  test("a line under the same payment number that is not a deposit is not a second deposit", () => {
    const withReversal = history(
      deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"),
      transfer("2026-09-24", "1840"),
      `"2026-09-26","7000017 - Example Family Pharmacy","${PN.a}","INVENTED PAYER A  ${PN.a}  20260926",-75`,
    );
    assert.equal(withReversal.sweeps[0].agrees, true);
    assert.deepEqual(proved(sweepDepositsFrom([withReversal], [line("L1", "2026-09-24", 184_000)], new Map())), [PN.a]);
  });

  test("the same month filed twice is the same deposits and the same sweeps, not two of each", () => {
    /* A second line of the sweep's amount the day after: a sweep counted twice would take it and prove the deposit again. */
    const lines = [line("L1", "2026-09-24", 184_000), line("L1b", "2026-09-25", 184_000)];
    const found = sweepDepositsFrom([SEPT(), SEPT()], lines, links(["L1", ["rec-1"]], ["L1b", ["rec-9"]]));
    assert.deepEqual(found, [{ paymentNumber: PN.a, amountCents: 184_000, lineReceiptIds: ["rec-1"] }]);
  });

  test("one sweep is one bank line: a second line of its amount the day after is not the same transfer again", () => {
    const lines = [line("L1", "2026-09-24", 184_000), line("L1b", "2026-09-25", 184_000)];
    const found = sweepDepositsFrom([SEPT()], lines, links(["L1", ["rec-1"]], ["L1b", ["rec-9"]]));
    assert.deepEqual(found, [{ paymentNumber: PN.a, amountCents: 184_000, lineReceiptIds: ["rec-1"] }], "the nearer line, and once");
  });

  test("a deposit printed twice in one file is two deposits, and proves neither", () => {
    const doubled = history(deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"), deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"), transfer("2026-09-24", "3680"));
    assert.equal(doubled.sweeps[0].agrees, true);
    assert.deepEqual(sweepDepositsFrom([doubled], [line("L1", "2026-09-24", 368_000)], new Map()), []);
  });

  test("two files that overlap on a day count the shared day once", () => {
    const earlier = history(deposit("2026-09-22", PN.b, "INVENTED PAYER B", "1250.36"), deposit("2026-09-22", PN.c, "INVENTED PAYER C", "750.5"), transfer("2026-09-22", "2000.86"));
    const overlapping = SEPT();
    const found = sweepDepositsFrom([earlier, overlapping], [line("L1", "2026-09-24", 184_000), line("L2", "2026-09-22", 200_086)], new Map());
    assert.deepEqual(proved(found), [PN.a, PN.b, PN.c]);
  });

  test("one bank line is one sweep: two transfers of one amount need two lines", () => {
    const pair = history(
      deposit("2026-09-23", PN.b, "INVENTED PAYER B", "500"),
      transfer("2026-09-23", "500"),
      deposit("2026-09-22", PN.a, "INVENTED PAYER A", "500"),
      transfer("2026-09-22", "500"),
    );
    const oneLine = sweepDepositsFrom([pair], [line("L1", "2026-09-24", 50_000)], new Map());
    assert.deepEqual(proved(oneLine), [PN.b], "the line goes to the nearer sweep, and the other is not proved by it");
    const twoLines = sweepDepositsFrom([pair], [line("L1", "2026-09-24", 50_000), line("L2", "2026-09-25", 50_000)], new Map());
    assert.deepEqual(proved(twoLines), [PN.a, PN.b]);
  });

  test("nothing proved without a history, or without a line", () => {
    assert.deepEqual(sweepDepositsFrom([], [line("L1", "2026-09-24", 184_000)], new Map()), []);
    assert.deepEqual(sweepDepositsFrom([SEPT()], [], new Map()), []);
  });
});

describe("how far the account histories on file can see", () => {
  const OTHER = (on: string, paymentNumber: string, amount: string) => `"${on}","7000017 - Example Family Pharmacy","${paymentNumber}","INVENTED PAYER E  ${paymentNumber}  ${on.replace(/-/g, "")}",${amount}`;

  test("with nothing on file it reaches nowhere and holds no deposit", () => {
    assert.deepEqual(historyReachOf([]), { through: null, months: new Set(), depositDays: new Map() });
  });

  test("it reaches the newest day on any line of any file, however the files and their lines are ordered", () => {
    const earlier = history(deposit("2026-08-30", PN.d, "INVENTED PAYER D", "100"));
    assert.equal(historyReachOf([SEPT()]).through, "2026-09-24", "the portal prints the newest day first, so the last line is the oldest");
    assert.equal(historyReachOf([earlier, SEPT()]).through, "2026-09-24");
    assert.equal(historyReachOf([SEPT(), earlier]).through, "2026-09-24");
  });

  /*
   * The newest day is a high-water mark: it says nothing of the months below it. A September file and an October file reach past an
   * August advice with no August file at all, which is why the months are held as well.
   */
  test("it holds each month in which any file has a dated line, so a month with no file can be told from one with nothing in it", () => {
    const august = history(deposit("2026-08-30", PN.d, "INVENTED PAYER D", "100"));
    const october = history(deposit("2026-10-20", PN.a, "INVENTED PAYER A", "1840"), transfer("2026-10-20", "1840"));
    const reach = historyReachOf([august, october]);
    assert.equal(reach.through, "2026-10-20");
    assert.deepEqual([...reach.months].sort(), ["2026-08", "2026-10"], "September is in neither file, though the newest day is past it");
    assert.deepEqual([...historyReachOf([SEPT()]).months], ["2026-09"], "many days in one month are one month");
    assert.deepEqual([...historyReachOf([SEPT(), august]).months].sort(), ["2026-08", "2026-09"]);
  });

  test("a line that is not a deposit shows how far the file reaches and holds no deposit", () => {
    const h = history(deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"), OTHER("2026-09-27", PN.d, "-75"));
    const reach = historyReachOf([h]);
    assert.equal(reach.through, "2026-09-27");
    assert.deepEqual([...reach.depositDays], [[PN.a, "2026-09-24"]]);
  });

  test("a transfer is the newest line a file can end on, and is not a deposit either", () => {
    const h = history(deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"), transfer("2026-09-26", "1840"));
    const reach = historyReachOf([h]);
    assert.equal(reach.through, "2026-09-26");
    assert.deepEqual([...reach.depositDays.keys()], [PN.a]);
  });

  test("each payment number is held at the latest day it is a deposit, whichever way round the file prints the days", () => {
    const h = history(
      deposit("2026-09-24", PN.a, "INVENTED PAYER A", "1840"),
      deposit("2026-09-10", PN.a, "INVENTED PAYER A", "300"),
      deposit("2026-09-05", PN.d, "INVENTED PAYER D", "100"),
      deposit("2026-09-18", PN.d, "INVENTED PAYER D", "100"),
    );
    const { depositDays } = historyReachOf([h]);
    assert.equal(depositDays.get(PN.a), "2026-09-24");
    assert.equal(depositDays.get(PN.d), "2026-09-18");
  });

  test("a payment number is six digits or more: a shorter one is a line's reference, not a payment to look for", () => {
    const h = history(deposit("2026-09-12", "123456", "INVENTED PAYER F", "50"), deposit("2026-09-12", "12345", "INVENTED PAYER G", "60"));
    assert.deepEqual([...historyReachOf([h]).depositDays.keys()], ["123456"]);
  });
});
