import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

/*
 * The morning check gathered from a database, not from hand-written facts.
 *
 * The dashboard swallows any error the check raises and then shows nothing, so a broken query in the store would be a card that is not
 * there, with every pure test still green. The judge is pinned in daily-check.test.ts; this proves what feeds it: which invoices are
 * short, and which remittances are not banked and what the bank matcher says of each. Every name, number and amount is invented, and a
 * payer payment number is written EFT-999NNNNN, the shape the identifier scanner allows.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let dailyCheck: typeof import("../src/lib/daily-check-store").dailyCheck;
let remitStanding: typeof import("../src/lib/engine/remit-standing").remitStanding;
let matchContext: typeof import("../src/lib/bank-match-context").matchContext;
let storeFile: typeof import("../src/lib/files").storeFile;
let todayIso: typeof import("../src/lib/dates").todayIso;
let cleanup: () => void;
let filesDir: string;

const SHORT = "Invoices add up to what they say they come to";
const BANKED = "Money the payer says it has sent has reached the cash account";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmacy-admin-files-"));
  process.env.FILES_DIR = filesDir;
  ({ db, schema } = await import("../src/db"));
  ({ dailyCheck } = await import("../src/lib/daily-check-store"));
  ({ remitStanding } = await import("../src/lib/engine/remit-standing"));
  ({ matchContext } = await import("../src/lib/bank-match-context"));
  ({ storeFile } = await import("../src/lib/files"));
  ({ todayIso } = await import("../src/lib/dates"));
});
after(() => {
  cleanup();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

const ask = async (what: string) => {
  const result = await dailyCheck();
  const c = result.checks.find((x) => x.what === what);
  assert.ok(c, `no check named ${what}`);
  return { c, result };
};

/* The day the register was last filled from an export: 15:00Z is 10:00 on the wall in Kansas, the same day. */
const READ = "2026-10-01T15:00:00.000Z";
const remit = (n: number, payerName: string, remitOn: string | null, amountCents: number, paymentNumber: string | null, lastSeenAt = READ) =>
  db.insert(schema.remittanceRegister).values({ id: `reg-${n}`, remitNumber: `R-10000${n}`, payerName, remitOn, amountCents, paymentNumber, source: "test", lastSeenAt });

/* How long ago a day was, said as the card says it, worked out here from the clock and not from the code under test. */
const ago = (iso: string) => {
  const days = Math.round((Date.parse(`${todayIso()}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};
/** The horizon the card ends its sentence with, for an export read on `read` that holds advice to `through`. */
const horizon = (read: string, through: string) => `; the last ProviderPay export was read ${read} (${ago(read)}) and holds advice to ${through}`;

const receipt = (n: number, amountCents: number, receivedOn: string, reference: string | null, sourceKey: string) =>
  db.insert(schema.cashReceipts).values({
    id: `cash-${n}`,
    month: receivedOn.slice(0, 7),
    kind: "third_party",
    amountCents,
    payer: "Invented Payer",
    sourceKey,
    receivedOn,
    reference,
    outOfBooks: false,
    createdBy: "test",
  });

describe("the morning check, gathered", () => {
  test("an empty database answers all ten checks, and the two this file is about are in order", async () => {
    const { result } = await ask(SHORT);
    assert.equal(result.checks.length, 10);
    const short = result.checks.find((x) => x.what === SHORT)!;
    assert.equal(short.ok, true);
    assert.equal(short.href, "/inventory/invoices");
    const banked = result.checks.find((x) => x.what === BANKED)!;
    assert.equal(banked.ok, true);
    assert.match(banked.observed, /no remittance has been read yet/);
  });

  test("a mailbox that has never been swept says so, and does not say NaN; a sweep two hours ago reads as hours and passes", async () => {
    const mailbox = async () => (await dailyCheck()).checks.find((x) => x.key === "mailbox-swept")!;
    const never = await mailbox();
    assert.equal(never.ok, false);
    assert.equal(never.observed, "never swept");
    assert.equal(never.fingerprint, "never|clean|-|-");
    try {
      await db.insert(schema.settings).values({ key: "mail_last_sweep", value: new Date(Date.now() - 2 * 3_600_000).toISOString() });
      const recent = await mailbox();
      assert.equal(recent.ok, true);
      assert.equal(recent.observed, "last swept 2 hours ago");
      assert.equal(recent.fingerprint, "recent|clean|0|-");
    } finally {
      await db.delete(schema.settings).where(eq(schema.settings.key, "mail_last_sweep"));
    }
  });

  test("short invoices are counted, named largest first, and the link finds the first", async () => {
    const invoice = (id: string, supplier: string, invoiceDate: string, linesShortCents: number | null) =>
      db.insert(schema.supplierInvoices).values({ id, documentId: `doc-${id}`, supplier, invoiceDate, linesShortCents });
    await invoice("inv-a", "Invented Wholesale Co", "2026-10-06", 2031);
    await invoice("inv-b", "Other Invented Supply", "2026-10-02", 500);
    await invoice("inv-c", "Third Invented Supply", "2026-10-01", null);
    const { c } = await ask(SHORT);
    assert.equal(c.ok, false);
    assert.equal(
      c.observed,
      "2 invoices short by $25.31 in total (Invented Wholesale Co, 2026-10-06, $20.31 short; Other Invented Supply, 2026-10-02, $5.00 short)",
    );
    assert.equal(c.href, "/inventory/invoices?supplier=Invented+Wholesale+Co&on=2026-10-06");
    assert.equal(c.action, "See the invoices");

    await db.delete(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, "inv-b"));
    const lone = (await ask(SHORT)).c;
    assert.equal(lone.observed, "1 invoice short by $20.31 (Invented Wholesale Co, 2026-10-06)");
    assert.equal(lone.action, "See the invoice");

    await db.delete(schema.supplierInvoices);
    assert.equal((await ask(SHORT)).c.ok, true, "nothing short, nothing said");
  });
});

const clear = async () => {
  for (const t of [schema.bankLineReceipts, schema.bankLines, schema.documents, schema.cashReceipts, schema.remittanceRegister]) await db.delete(t);
};

describe("remittances not banked, gathered", () => {
  /*
   * Two remittances of one amount from one payer eight days apart, the first with a payment number and the second without, and one deposit
   * of that amount whose key carries neither remittance number. The card judges as the bank matcher and the Remits tab do, except that an
   * amount alone does not bank a remittance that has a payment number: the first is named, with the amount that stands for it. Around them:
   * one banked by its payment number, one banked by a payment number in a receipt's reference whatever its key says (the key-matching judge
   * this replaced called that one not banked), one banked by the remittance number in a key, which is counted and said and not named, and
   * one that nothing stands for.
   */
  test("each remittance with a payment number that nothing proves is named, with what stands for it, and the others are counted or said apart", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await remit(2, "Invented Payer A", "2026-09-23", 200_800, null);
    await remit(3, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003");
    await remit(4, "Invented Payer C", "2026-09-10", 75_500, "EFT-99900004");
    await remit(5, "Invented Payer D", "2026-09-18", 120_000, "EFT-99900005");
    await remit(6, "Invented Payer E", "2026-09-12", 90_000, "EFT-99900006");
    await receipt(1, 200_800, "2026-09-24", "EFT-99900002", "999|invented payer a|eft-99900002|2026-09-24");
    await receipt(3, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    await receipt(5, 120_000, "2026-09-19", "EFT-99900005", "999|invented payer d|other|2026-09-19");
    await receipt(6, 90_000, "2026-09-13", null, "999|invented payer e|R-100006|2026-09-13");
    const { c, result } = await ask(BANKED);
    assert.equal(c.ok, false);
    assert.equal(c.href, "/remits");
    assert.equal(
      c.observed,
      "2 of the 5 remittances with a payment number, advised since the books began, are advised as paid and not banked, $2,763.00 between them (" +
        "Invented Payer A, advised 2026-09-15, $2,008.00: a receipt of exactly that amount, near the advice date, stands for it by amount alone and not by its payment number, and no ProviderPay account history is on file to look in; " +
        "Invented Payer C, advised 2026-09-10, $755.00: no receipt stands for it, by payment number, remittance number or amount, and no ProviderPay account history is on file to look in)" +
        "; 1 other is banked by a receipt keyed to the remittance number, not the payment number" +
        "; 1 other remittance carries no payment number yet: 1 has nothing standing for it yet and is waiting (Invented Payer A, advised 2026-09-23, $2,008.00)" +
        horizon("2026-10-01", "2026-09-23"),
    );
    assert.doesNotMatch(c.observed, /Invented Payer [BDE]/, "a remittance banked by a payment number or a remittance number is counted, not named");
    assert.doesNotMatch(c.observed, /no cash is owed/, "a remittance with no number is not said to be owed nothing");
    assert.doesNotMatch(JSON.stringify(result), /9990000\d/, "no payer payment number leaves the store");
  });

  test("a remittance whose receipt carries its payment number in its key is banked, and the check passes", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await remit(3, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003");
    await receipt(1, 200_800, "2026-09-16", "EFT-99900001", "999|invented payer a|eft-99900001|2026-09-16");
    await receipt(3, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    const { c } = await ask(BANKED);
    assert.equal(c.ok, true);
    assert.equal(c.observed, `all 2 remittances with a payment number, advised since the books began, have their cash${horizon("2026-10-01", "2026-09-20")}`);
  });

  /*
   * The same two remittances with the deposit's key carrying the SECOND one's remittance number, which is how the pair stood on the books.
   * The matcher stands the deposit for the second remittance, so nothing stands for the first by any evidence: not its payment number, not
   * its remittance number, not an amount that is already spent. The card says that, which tells him the deposit is not hiding under
   * another reference, and the check still fails because a payment number is the payer saying a payment was sent. With no account history
   * on file it also says there is none to look in, which is different from one that looked and found nothing.
   */
  test("when the deposit carries the other remittance's number, nothing stands for the first and the card says so", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await remit(2, "Invented Payer A", "2026-09-23", 200_800, null);
    await remit(3, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003");
    await receipt(1, 200_800, "2026-09-24", "EFT-99900002", "999|invented payer a|R-100002|2026-09-24");
    await receipt(3, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    const { c, result } = await ask(BANKED);
    assert.equal(c.ok, false);
    assert.equal(
      c.observed,
      "1 of the 2 remittances with a payment number, advised since the books began, is advised as paid and not banked, $2,008.00 " +
        "(Invented Payer A, advised 2026-09-15: no receipt stands for it, by payment number, remittance number or amount, and no ProviderPay account history is on file to look in)" +
        "; 1 other remittance carries no payment number yet: 1 has a receipt standing for it, by remittance number or amount" +
        horizon("2026-10-01", "2026-09-23"),
    );
    assert.doesNotMatch(JSON.stringify(result), /9990000\d/, "no payer payment number leaves the store");
  });

  test("the books begin on the first day of September: the day before is not counted, said or waited for, and the day itself is", async () => {
    const { SITE_STARTS_ON } = await import("../src/lib/books-start");
    const { addDays } = await import("../src/lib/dates");
    const before = addDays(SITE_STARTS_ON, -1);
    await clear();
    await remit(1, "Invented Payer A", before, 100_000, "EFT-99900001");
    await remit(2, "Invented Payer B", before, 50_000, null);
    await remit(3, "Invented Payer C", SITE_STARTS_ON, 70_000, "EFT-99900003");
    await remit(4, "Invented Payer D", "2026-09-20", 150_000, "EFT-99900004");
    await receipt(4, 150_000, "2026-09-21", "EFT-99900004", "999|invented payer d|eft-99900004|2026-09-21");
    const { c } = await ask(BANKED);
    assert.equal(SITE_STARTS_ON, "2026-09-01", "the owner's rule: nothing is tracked from before 1 September");
    assert.equal(c.ok, false);
    assert.equal(
      c.observed,
      "1 of the 2 remittances with a payment number, advised since the books began, is advised as paid and not banked, $700.00 " +
        `(Invented Payer C, advised ${SITE_STARTS_ON}: no receipt stands for it, by payment number, remittance number or amount, and no ProviderPay account history is on file to look in)` +
        horizon("2026-10-01", "2026-09-20"),
    );
    assert.doesNotMatch(c.observed, /Invented Payer [AB]|carries no payment number/, "nothing from before the books is counted, named or waited for");
  });

  /*
   * A cheque payer's remittance never carries a payment number and its money is banked at the counter, so a receipt can stand for it by its
   * remittance number or its amount; one nothing stands for has not arrived yet. The card says which, for each, and does not fail on either:
   * ProviderPay has not matched it, or it was never going to be.
   */
  test("rows with no payment number are said by what stands for them, the biggest waiting first, and the check does not fail on them", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await remit(2, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003");
    await remit(3, "Invented Cheque Payer", "2026-09-12", 30_000, null);
    await remit(4, "Invented Payer X", "2026-09-28", 50_000, null);
    await remit(5, "Invented Payer Y", "2026-09-29", 170_000, null);
    await remit(6, "Invented Payer Z", "2026-09-29", 90_000, "   ");
    await receipt(1, 200_800, "2026-09-16", "EFT-99900001", "999|invented payer a|eft-99900001|2026-09-16");
    await receipt(2, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    await receipt(3, 30_000, "2026-09-14", null, "999|invented cheque payer|R-100003|2026-09-14");
    const { c } = await ask(BANKED);
    assert.equal(c.ok, true, "a remittance with no number cannot be looked for by number, so it cannot fail the check");
    assert.equal(
      c.observed,
      "all 2 remittances with a payment number, advised since the books began, have their cash" +
        "; 4 other remittances carry no payment number yet: 1 has a receipt standing for it, by remittance number or amount, " +
        "and 3 have nothing standing for them yet and are waiting (Invented Payer Y, advised 2026-09-29, $1,700.00; Invented Payer Z, advised 2026-09-29, $900.00; Invented Payer X, advised 2026-09-28, $500.00)" +
        horizon("2026-10-01", "2026-09-29"),
    );
  });

  /*
   * An advice of $0.00 or less is not money sent, so nothing a bank could hold stands behind it. A numbered one is not "advised as paid
   * and not banked", a negative one is not a deposit missing, and one with no number is not waited for: each is counted apart and said
   * apart, and left out of the populations the sentence is built from (the "all 2" is the two advices of money).
   */
  test("an advice of nothing or less is not unbanked, not waited for and not in the count, and the card says how many it left out", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 0, "EFT-99900001");
    await remit(2, "Invented Payer A", "2026-09-16", -4_000, "EFT-99900002");
    await remit(3, "Invented Payer B", "2026-09-17", 0, null);
    await remit(4, "Invented Payer C", "2026-09-18", 150_000, "EFT-99900004");
    await remit(5, "Invented Payer D", "2026-09-14", 90_000, "EFT-99900005");
    await receipt(4, 150_000, "2026-09-19", "EFT-99900004", "999|invented payer c|eft-99900004|2026-09-19");
    await receipt(5, 90_000, "2026-09-15", "EFT-99900005", "999|invented payer d|eft-99900005|2026-09-15");
    const { c } = await ask(BANKED);
    assert.equal(c.ok, true);
    assert.equal(
      c.observed,
      "all 2 remittances with a payment number, advised since the books began, have their cash; 3 advices of nothing or less are not money sent and are not judged" + horizon("2026-10-01", "2026-09-18"),
    );
    assert.doesNotMatch(c.observed, /waiting|no payment number yet|not banked/, "none of the three is chased");
  });

  test("the day the register was last read is the newest day any row was seen, said beside the newest advice it holds", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001", "2026-09-17T15:00:00.000Z");
    await remit(2, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003", "2026-10-01T15:00:00.000Z");
    await receipt(1, 200_800, "2026-09-16", "EFT-99900001", "999|invented payer a|eft-99900001|2026-09-16");
    await receipt(2, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    const { c } = await ask(BANKED);
    assert.equal(c.observed, `all 2 remittances with a payment number, advised since the books began, have their cash${horizon("2026-10-01", "2026-09-20")}`);
    assert.match(c.observed, /was read 2026-10-01 \(/, "not the 17th, which is only when the oldest row was first seen");
  });

  /*
   * The bank matcher makes one receipt per remittance and keys it to the remittance number while the register has no payment number for
   * it. Once the register learns the number the remittance is numbered and the card must still call it banked: the receipt is its money,
   * and a card that looked only for the payment number would flag it. The card says which kind of receipt banked it.
   */
  test("a numbered remittance whose receipt is keyed to its remittance number is banked, and the card says it was the key and not the payment number", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await remit(3, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003");
    await receipt(1, 200_800, "2026-09-16", null, "999|invented payer a|R-100001|2026-09-16");
    await receipt(3, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    const { c } = await ask(BANKED);
    assert.equal(c.ok, true);
    assert.equal(
      c.observed,
      "all 2 remittances with a payment number, advised since the books began, have their cash" +
        "; 1 of them is banked by a receipt keyed to the remittance number, not the payment number" +
        horizon("2026-10-01", "2026-09-20"),
    );
  });

  /*
   * The card asks whether money reached the cash account, and a receipt the books do not count is not in it. The Remits tab and the bank
   * matcher ask which remittances a bank line was matched to, and a remittance advised in August may have been matched by a receipt that
   * is outside the books, so they keep counting it: the one remittance is banked there and not here.
   */
  test("a receipt outside the books does not bank a remittance on the card, though the Remits tab still counts it", async () => {
    await clear();
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await remit(3, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003");
    await receipt(1, 200_800, "2026-09-16", "EFT-99900001", "999|invented payer a|eft-99900001|2026-09-16");
    await receipt(3, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    await db.update(schema.cashReceipts).set({ outOfBooks: true }).where(eq(schema.cashReceipts.id, "cash-1"));
    const { c } = await ask(BANKED);
    assert.equal(c.ok, false);
    assert.equal(
      c.observed,
      "1 of the 2 remittances with a payment number, advised since the books began, is advised as paid and not banked, $2,008.00 " +
        "(Invented Payer A, advised 2026-09-15: no receipt stands for it, by payment number, remittance number or amount, and no ProviderPay account history is on file to look in)" +
        horizon("2026-10-01", "2026-09-20"),
    );
    const standing = async (booksOnly: boolean) => new Map((await remitStanding({ booksOnly })).map((s) => [s.row.remitNumber, s.banked]));
    assert.equal((await standing(false)).get("R-100001"), "payment number", "the Remits tab and the matcher count it");
    assert.equal((await standing(true)).get("R-100001"), null, "the card does not");
  });
});

describe("remittances banked by ProviderPay's account history, gathered", () => {
  /*
   * The 15 September pair, as it stood: two remittances of one amount from one payer, the first with a payment number and the second not
   * yet, and the one deposit of that amount on the books keyed to the SECOND one's remittance number. ProviderPay's account history shows
   * the deposit under the FIRST one's payment number, swept the same day for the same amount, and the bank line that sweep became is a
   * placed bank line of that amount. A third remittance, banked by its own key, keeps the count above one. Every number is invented.
   */
  const PN = "999000000000041";
  const PSAO = "ProviderPay/EDI PYM NTS 999000000000900 Invented Pharmacy";
  const csv = (rows: [date: string, paymentNumber: string, description: string, amount: number][]) =>
    [`"Date","Location","Payment number","Description","Amount"`, ...rows.map(([d, p, text, a]) => `"${d}","${p ? "7000017 - Example Family Pharmacy" : ""}","${p}","${text}",${a}`)].join("\n");
  const SWEPT = csv([
    ["2026-09-24", PN, `INVENTED PAYER A  ${PN}  20260924`, 2008],
    ["2026-09-24", "", "ProviderPay Transfer", -2008],
  ]);
  /*
   * A history that holds somebody else's deposits and nothing under the first remittance's number, whose newest day is `on`. It is written
   * newest day first, as the portal prints it, with an older day after, so the day it reaches is the newest and not the first or the last
   * line of the file.
   */
  const ELSEWHERE = (on: string) =>
    csv([
      [on, "999000000000077", "INVENTED PAYER Q  999000000000077", 50],
      [on, "", "ProviderPay Transfer", -50],
      ["2026-09-20", "999000000000066", "INVENTED PAYER R  999000000000066", 20],
      ["2026-09-20", "", "ProviderPay Transfer", -20],
    ]);

  const scene = async (o: { amount?: number; placedAs?: string; description?: string; history?: string | false; firstOn?: string | null; link?: "both" | "line" | "rows" } = {}) => {
    await clear();
    await remit(1, "Invented Payer A", o.firstOn === undefined ? "2026-09-15" : o.firstOn, 200_800, PN);
    await remit(2, "Invented Payer A", "2026-09-23", 200_800, null);
    await remit(3, "Invented Payer B", "2026-09-20", 150_000, "EFT-99900003");
    await receipt(1, 200_800, "2026-09-24", "R-100002", "835|invented payer a|R-100002|2026-09-23");
    await receipt(3, 150_000, "2026-09-21", "EFT-99900003", "999|invented payer b|eft-99900003|2026-09-21");
    const history = o.history === undefined ? SWEPT : o.history;
    if (history !== false) {
      const stored = await storeFile(new File([history], "account_history_2026_09.csv", { type: "text/csv" }), { allowReportTypes: true });
      await db.insert(schema.documents).values({ id: "doc-history", category: "report", title: "Account history, September 2026", fileName: "account_history_2026_09.csv", mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.storageKey, uploadedBy: "the test" });
    }
    await db.insert(schema.bankLines).values({ id: "line-1", key: "k-line-1", on: "2026-09-24", description: o.description ?? PSAO, amountCents: o.amount ?? 200_800, placedAs: o.placedAs ?? "banks_remits", receiptId: o.link === "rows" ? null : "cash-1", createdBy: "test" });
    if (o.link !== "line") await db.insert(schema.bankLineReceipts).values({ lineId: "line-1", receiptId: "cash-1" });
  };

  /** What the card says of the first remittance when nothing proves its deposit, with what the history can say of it. */
  const unbanked = (history: string, advised = "advised 2026-09-15") =>
    "1 of the 2 remittances with a payment number, advised since the books began, is advised as paid and not banked, $2,008.00 " +
    `(Invented Payer A, ${advised}: no receipt stands for it, by payment number, remittance number or amount, and ${history})` +
    "; 1 other remittance carries no payment number yet: 1 has a receipt standing for it, by remittance number or amount" +
    horizon("2026-10-01", "2026-09-23");
  const HOLDS = "ProviderPay's account history holds a deposit under its payment number, dated 2026-09-24, that is not shown reaching a bank line already placed";

  test("the deposit the history shows swept to a placed bank line is banked, the card says it was the history, and the receipt cannot also stand for the second", async () => {
    await scene();
    const { c, result } = await ask(BANKED);
    assert.equal(c.ok, true);
    assert.equal(
      c.observed,
      "all 2 remittances with a payment number, advised since the books began, have their cash" +
        "; 1 of them is shown banked by ProviderPay's account history, not by a receipt carrying the payment number" +
        "; 1 other remittance carries no payment number yet: 1 has nothing standing for it yet and is waiting (Invented Payer A, advised 2026-09-23, $2,008.00)" +
        horizon("2026-10-01", "2026-09-23"),
    );
    const stood = new Map((await remitStanding()).map((s) => [s.row.remitNumber, s.banked]));
    assert.equal(stood.get("R-100001"), "sweep deposit");
    assert.equal(stood.get("R-100002"), null, "the one receipt is spent on the first, so it does not also stand for the second, whose money has not arrived");
    assert.doesNotMatch(JSON.stringify(result), /9990000\d/, "no payment number leaves the store");
  });

  /*
   * The bank matcher is offered a remittance only where nothing stands for it, and never one whose own receipt key is already held. In
   * this scene the first remittance is banked by the history, the second's own key is held by the receipt the first spent, and the third
   * is banked by its payment number, so the matcher is offered none of them: offering a deposit one that is already banked is how one
   * deposit comes to be counted twice.
   */
  test("the bank matcher is offered none of the three: one banked by the history, one whose own receipt is held, one banked by its number", async () => {
    await scene();
    const { remits } = await matchContext();
    assert.deepEqual(remits, []);
  });

  test("the receipt the line confirmed is found whether the line carries it itself or only a link row says so, and is spent on the first remittance either way", async () => {
    for (const link of ["both", "line", "rows"] as const) {
      await scene({ link });
      const stood = new Map((await remitStanding()).map((s) => [s.row.remitNumber, s.banked]));
      assert.equal(stood.get("R-100001"), "sweep deposit", link);
      assert.equal(stood.get("R-100002"), null, link);
    }
  });

  /*
   * Where the history cannot prove the bank line, the remittance stays on the list, and the card says what the history does hold: here it
   * holds the deposit, so it says so, and does not say that the history ends too soon to show it or that it holds nothing.
   */
  test("a bank line nobody has placed proves nothing, and the card says the history holds the deposit and not where it went", async () => {
    await scene({ placedAs: "unplaced" });
    const { c } = await ask(BANKED);
    assert.equal(c.ok, false);
    assert.equal(c.observed, unbanked(HOLDS));
  });

  test("a bank line of another amount proves nothing", async () => {
    await scene({ amount: 200_801 });
    assert.equal((await ask(BANKED)).c.observed, unbanked(HOLDS));
  });

  test("a bank line the bank does not name as the payer's own proves nothing", async () => {
    await scene({ description: "Deposit" });
    assert.equal((await ask(BANKED)).c.observed, unbanked(HOLDS));
  });

  test("a history that holds the deposit is never said to end too soon, however soon after the advice it ends", async () => {
    await scene({ placedAs: "unplaced", firstOn: "2026-09-23" });
    assert.equal((await ask(BANKED)).c.observed, unbanked(HOLDS, "advised 2026-09-23"));
  });

  test("with no account history on file the card says there is none to look in", async () => {
    await scene({ history: false });
    const { c } = await ask(BANKED);
    assert.equal(c.ok, false);
    assert.equal(c.observed, unbanked("no ProviderPay account history is on file to look in"));
  });

  /*
   * A history that holds nothing under the number says one of two different things. If it ends less than a fortnight after the advice,
   * the money may simply not have landed in it yet; if it reaches past, the payer said it paid and the account shows nothing.
   */
  test("a history that ends before the matcher's fortnight is up says it ends too soon to tell, and the fortnight's last day is past it", async () => {
    await scene({ history: ELSEWHERE("2026-09-28") });
    assert.equal(
      (await ask(BANKED)).c.observed,
      unbanked("the newest ProviderPay account history on file ends 2026-09-28, too soon after it was advised to show its deposit either way"),
    );
    await scene({ history: ELSEWHERE("2026-09-29") });
    assert.equal(
      (await ask(BANKED)).c.observed,
      unbanked("ProviderPay's account history on file (to 2026-09-29) holds no deposit under its payment number"),
    );
  });

  /*
   * `through` is the newest day any file reaches and says nothing of the months below it: a September file and an October file with no
   * August file reach past an August advice and still cannot show its deposit. The card names the month no file covers, because that is
   * the file to go and fetch, where "holds no deposit" would say the account had been looked in.
   */
  test("a history that reaches past the fortnight but covers no month the deposit could be in says there is a gap, and names the month", async () => {
    const lines = (days: string[]) =>
      csv(days.flatMap((d, i): [string, string, string, number][] => [[d, `99900000000009${i}`, `INVENTED PAYER Q  99900000000009${i}`, 50], [d, "", "ProviderPay Transfer", -50]]));
    const gap = (month: string) =>
      `advised 2026-09-25: no receipt stands for it, by payment number, remittance number or amount, and no ProviderPay account history on file covers ${month}, so it cannot show its deposit either way)`;
    const says = (observed: string, month: string, why: string) => assert.ok(observed.includes(gap(month)), `${why}: ${observed}`);
    await scene({ history: lines(["2026-10-20", "2026-10-19"]), firstOn: "2026-09-25" });
    says((await ask(BANKED)).c.observed, "2026-09", "the advice's own month has no file");
    await scene({ history: lines(["2026-09-26", "2026-11-02"]), firstOn: "2026-09-25" });
    says((await ask(BANKED)).c.observed, "2026-10", "the month the fortnight runs into has none");
    await scene({ history: lines(["2026-09-26", "2026-10-20"]), firstOn: "2026-09-25" });
    const covered = (await ask(BANKED)).c.observed;
    assert.ok(covered.includes("and ProviderPay's account history on file (to 2026-10-20) holds no deposit under its payment number)"), `both months are covered: ${covered}`);
    assert.ok(!covered.includes("covers 2026"), covered);
  });

  test("a remittance with no advice date is counted, named as not captured, and never said to end too soon", async () => {
    await scene({ history: ELSEWHERE("2026-09-24"), firstOn: null });
    const { c } = await ask(BANKED);
    assert.equal(c.ok, false);
    assert.equal(c.observed, unbanked("ProviderPay's account history on file (to 2026-09-24) holds no deposit under its payment number", "advised date not captured"));
  });
});
