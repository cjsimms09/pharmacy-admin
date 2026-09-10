import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { invoicesOwed, stillToChase, fromBeforeWeWatched, type PurchaseRow, type FiledRow, type SupplierRow } from "../src/lib/invoices-owed";

/**
 * The owner: "are we using pioneers receipts to make sure we are getting invoices from suppliers? If
 * it was received by pioneer than we should be receiving the invoice." And the caveat in the same
 * breath: "I should have an option on a supplier to use pioneers receipts as invoice for that
 * supplier (ie Xymogen supplier)."
 *
 * And, on the deliveries from before any of this existed: "We are going to ignore those alerts for
 * invoices from beginning of this month.. that was just to get them in from before this site was
 * setup." Which is the difference between the two counts here.
 */
const buy = (supplier: string, invoiceNumber: string | null, totalCents: number, invoiceDate = "2026-09-20"): PurchaseRow => ({
  supplier,
  supplierId: null,
  invoiceNumber,
  invoiceDate,
  totalCents,
});

const filed = (supplier: string, invoiceNumber: string | null, invoiceDate: string, totalCents: number | null = null): FiledRow => ({
  supplier,
  supplierId: null,
  invoiceNumber,
  invoiceDate,
  totalCents,
});

const mck: SupplierRow = { id: "mck", name: "McKesson", invoiceFromPioneer: false };
const xy: SupplierRow = { id: "xy", name: "Xymogen", invoiceFromPioneer: true };
const ipd: SupplierRow = { id: "ipd", name: "IPD", invoiceFromPioneer: false };

describe("what the pharmacy is still waiting on", () => {
  test("a delivery with no invoice is waiting; one with an invoice is not", () => {
    const l = invoicesOwed(
      [buy("McKesson", "111", 10_000), buy("McKesson", "222", 20_000)],
      [filed("McKesson", "111", "2026-09-01")],
      [mck],
    );
    assert.equal(l.length, 1);
    assert.equal(l[0].received, 2);
    assert.equal(l[0].waiting, 1);
    assert.equal(l[0].waitingCents, 20_000);
    assert.match(l[0].says, /1 of 2 deliveries have no invoice/);
  });

  test("every invoice on file reads as settled, not as silence", () => {
    const l = invoicesOwed([buy("McKesson", "111", 10_000)], [filed("McKesson", "111", "2026-09-01")], [mck]);
    assert.equal(l[0].waiting, 0);
    assert.match(l[0].says, /an invoice on file for every one/);
  });

  /*
   * The two systems spell the same wholesaler three ways. Keying on the name as well as the number
   * is how the last matching bug hid, so the number alone decides whether a delivery is covered.
   */
  test("the invoice number matches whatever the two systems call the supplier", () => {
    const l = invoicesOwed([buy("MCKESSON", " 111 ", 10_000)], [filed("McKesson", "111", "2026-09-01")], [mck]);
    assert.equal(l[0].waiting, 0);
  });

  /*
   * A purchase with no number of its own can never be matched, so it can never be proved missing.
   * "We have no way to tell" is not the same news as "they have not sent it".
   */
  test("a purchase with no number is received but never called missing", () => {
    const l = invoicesOwed([buy("IPD", null, 325_570)], [], [ipd]);
    assert.equal(l[0].received, 1);
    assert.equal(l[0].waiting, 0);
    assert.equal(l[0].waitingCents, 0);
  });
});

/**
 * The owner, once the first run put $142,036.21 of McKesson on the list: "We are going to ignore
 * those alerts for invoices from beginning of this month.. that was just to get them in from before
 * this site was setup."
 *
 * Every McKesson invoice on file was dated the 9th or later and every uninvoiced delivery the 1st to
 * the 9th. They were not a wholesaler failing to send. They were the days before anything was
 * catching what the wholesaler sent.
 */
describe("before this was catching invoices at all", () => {
  test("a delivery from before their first invoice is not something they owe", () => {
    const l = invoicesOwed(
      [buy("McKesson", "111", 142_000, "2026-09-02")],
      [filed("McKesson", "999", "2026-09-09")],
      [mck],
    );
    assert.equal(l[0].waiting, 0, "nobody is going to ring them about it");
    assert.equal(l[0].before, 1);
    assert.equal(l[0].beforeCents, 142_000);
    assert.match(l[0].says, /predate 9 September/);
  });

  test("a delivery after their first invoice is one they owe", () => {
    const l = invoicesOwed(
      [buy("McKesson", "111", 10_000, "2026-09-12")],
      [filed("McKesson", "999", "2026-09-09")],
      [mck],
    );
    assert.equal(l[0].waiting, 1);
    assert.equal(l[0].before, 0);
  });

  test("the two counts are kept apart, and only one of them is chased", () => {
    const l = invoicesOwed(
      [buy("McKesson", "111", 142_000, "2026-09-02"), buy("McKesson", "222", 10_000, "2026-09-12")],
      [filed("McKesson", "999", "2026-09-09")],
      [mck],
    );
    assert.deepEqual(stillToChase(l), { suppliers: 1, invoices: 1, cents: 10_000 });
    assert.deepEqual(fromBeforeWeWatched(l), { suppliers: 1, invoices: 1, cents: 142_000 });
  });

  /*
   * A supplier who has never sent an invoice here has no date of their own to be judged against.
   * Judging them against nothing makes every delivery they have ever made look missing, including
   * the ones from before anything was watching — so they are judged against the day the mailbox
   * started catching anybody's.
   */
  test("a supplier who has never sent one is judged against the day this started", () => {
    const l = invoicesOwed(
      [buy("ANDA", "111", 15_110, "2026-09-02")],
      [filed("McKesson", "999", "2026-09-09")],
      [{ id: "anda", name: "ANDA", invoiceFromPioneer: false }],
      "2026-09-04",
    );
    assert.equal(l[0].neverFiled, true);
    assert.equal(l[0].waiting, 0, "before anything was being caught from anyone");
    assert.equal(l[0].before, 1);
  });

  test("and still owes for a delivery made after it", () => {
    const l = invoicesOwed(
      [buy("ANDA", "111", 15_110, "2026-09-20")],
      [filed("McKesson", "999", "2026-09-09")],
      [{ id: "anda", name: "ANDA", invoiceFromPioneer: false }],
      "2026-09-04",
    );
    assert.equal(l[0].waiting, 1);
    assert.match(l[0].says, /no invoice from them has ever been filed here/);
  });
});

/**
 * IPD's invoices carry no number this reader can find. Both on file were read, dated and totalled,
 * and matching on the number alone called a $3,255.70 invoice missing while it sat in the file —
 * which would have sent him to ring a wholesaler about a document the pharmacy already holds.
 */
describe("an invoice on file that carries no number", () => {
  test("covers a delivery for exactly its amount", () => {
    const l = invoicesOwed(
      [buy("IPD", "1008931", 325_570)],
      [filed("IPD", null, "2026-09-08", 325_570)],
      [ipd],
    );
    assert.equal(l[0].waiting, 0, "the invoice is in the file");
    assert.equal(l[0].matchedByAmount, 1);
  });

  test("and is spent once, not once per delivery", () => {
    const l = invoicesOwed(
      [buy("IPD", "1008931", 325_570), buy("IPD", "1008932", 325_570)],
      [filed("IPD", null, "2026-09-08", 325_570)],
      [ipd],
    );
    assert.equal(l[0].matchedByAmount, 1);
    assert.equal(l[0].waiting, 1, "one invoice cannot cover two deliveries");
  });

  test("a near amount is not a match", () => {
    const l = invoicesOwed(
      [buy("IPD", "1008931", 325_570)],
      [filed("IPD", null, "2026-09-08", 325_569)],
      [ipd],
    );
    assert.equal(l[0].matchedByAmount, 0);
    assert.equal(l[0].waiting, 1);
  });

  test("and it has to be their invoice, not somebody else's for the same money", () => {
    const l = invoicesOwed(
      [buy("IPD", "1008931", 325_570)],
      [filed("McKesson", null, "2026-09-08", 325_570)],
      [ipd, mck],
      "2026-09-01",
    );
    assert.equal(l[0].matchedByAmount, 0);
    assert.equal(l[0].waiting, 1);
  });

  test("what was matched that way is said out loud, because he audits", () => {
    const l = invoicesOwed(
      [buy("IPD", "1008931", 325_570), buy("IPD", "1008932", 10_000)],
      [filed("IPD", null, "2026-09-08", 325_570)],
      [ipd],
    );
    assert.match(l[0].says, /covered by an invoice of theirs carrying no number/);
  });
});

describe("the suppliers he is not waiting on", () => {
  test("their receipt is the invoice, so nothing of theirs is chased", () => {
    const l = invoicesOwed([buy("Xymogen", "999", 125_262)], [], [xy]);
    assert.equal(l[0].receiptIsTheInvoice, true);
    assert.equal(l[0].waiting, 0, "counted and listed, never chased");
    assert.equal(l[0].before, 0);
    assert.equal(l[0].received, 1);
    assert.match(l[0].says, /You have said their receipt is the invoice/);
  });

  test("the money is still theirs and still counted", () => {
    const l = invoicesOwed([buy("Xymogen", "999", 125_262)], [], [xy]);
    assert.equal(l[0].receivedCents, 125_262, "the switch is about chasing, never about the arithmetic");
  });

  test("a settled supplier never competes for attention with one that is not", () => {
    const l = invoicesOwed(
      [buy("Xymogen", "999", 900_000), buy("McKesson", "111", 1_000)],
      [filed("McKesson", "888", "2026-09-01")],
      [xy, mck],
    );
    assert.equal(l[0].supplier, "McKesson", "the small one he is waiting on comes first");
    assert.equal(l[1].supplier, "Xymogen");
  });

  test("turning it on takes them off the chase list without hiding them", () => {
    const purchases = [buy("Xymogen", "999", 125_262)];
    const invoices = [filed("Xymogen", "888", "2026-09-01")];
    const chasing = stillToChase(invoicesOwed(purchases, invoices, [{ ...xy, invoiceFromPioneer: false }]));
    const settled = stillToChase(invoicesOwed(purchases, invoices, [xy]));
    assert.equal(chasing.invoices, 1);
    assert.equal(chasing.cents, 125_262);
    assert.equal(settled.invoices, 0);
    assert.equal(settled.cents, 0);
  });
});

describe("the one line above the list", () => {
  test("counts only what is genuinely still to chase", () => {
    const l = invoicesOwed(
      [buy("McKesson", "111", 10_000), buy("McKesson", "222", 20_000), buy("Xymogen", "999", 125_262), buy("IPC", "333", 5_000)],
      [filed("McKesson", "000", "2026-09-01"), filed("IPC", "333", "2026-09-01")],
      [mck, xy, { id: "ipc", name: "IPC", invoiceFromPioneer: false }],
    );
    const c = stillToChase(l);
    assert.equal(c.suppliers, 1, "IPC is settled and Xymogen is not being waited on");
    assert.equal(c.invoices, 2);
    assert.equal(c.cents, 30_000);
  });

  test("nothing outstanding is nought, not an empty flourish", () => {
    assert.deepEqual(
      stillToChase(invoicesOwed([buy("McKesson", "111", 10_000)], [filed("McKesson", "111", "2026-09-01")], [mck])),
      { suppliers: 0, invoices: 0, cents: 0 },
    );
  });
});
