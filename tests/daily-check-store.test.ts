import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
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
let cleanup: () => void;

const SHORT = "Invoices add up to what they say they come to";
const BANKED = "Money the payer says it has sent has reached the cash account";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ dailyCheck } = await import("../src/lib/daily-check-store"));
});
after(() => cleanup());

const ask = async (what: string) => {
  const result = await dailyCheck();
  const c = result.checks.find((x) => x.what === what);
  assert.ok(c, `no check named ${what}`);
  return { c, result };
};

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

describe("remittances not banked, gathered", () => {
  const remit = (n: number, payerName: string, remitOn: string, amountCents: number, paymentNumber: string | null) =>
    db.insert(schema.remittanceRegister).values({ id: `reg-${n}`, remitNumber: `R-10000${n}`, payerName, remitOn, amountCents, paymentNumber, source: "test" });
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

  /*
   * Two remittances of one amount from one payer eight days apart, the first with a payment number and the second without, and one deposit
   * of that amount whose key carries neither remittance number. The check ties only by payment number; the bank matcher ties the first to
   * that deposit by amount alone. Around them, one remittance that is banked, and one for each of the other things the matcher can say, so
   * the wording is proved against what the matcher actually returns and not against a value typed into a test.
   */
  test("each remittance with a payment number and no receipt carrying it is named, with what the matcher says", async () => {
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
    assert.match(c.observed, /^4 remittances advised as paid and not banked, \$4,863\.00 between them \(/);
    assert.match(c.observed, /Invented Payer A, advised 2026-09-15, \$2,008\.00: a receipt of exactly that amount, near the advice date, stands for it by amount alone and not by its payment number; /);
    assert.match(c.observed, /Invented Payer D, advised 2026-09-18, \$1,200\.00: a receipt carries its payment number, written in a way this check does not match; /);
    assert.match(c.observed, /Invented Payer E, advised 2026-09-12, \$900\.00: a receipt carries its remittance number, not its payment number; and 1 more\)/);
    assert.match(c.observed, /reading to 2026-09-23 \(\d+ days ago\) — the last ProviderPay export$/);
    assert.doesNotMatch(c.observed, /Invented Payer B/, "a remittance whose receipt carries its payment number is banked");
    assert.doesNotMatch(c.observed, /advised 2026-09-23/, "one with no payment number is not owed yet, and is not counted");
    assert.doesNotMatch(c.observed, /Invented Payer C/, "the fourth is counted, not named");
    assert.doesNotMatch(JSON.stringify(result), /9990000\d/, "no payer payment number leaves the store");
  });

  test("a remittance whose receipt carries its payment number in its key is banked, and the check passes", async () => {
    await db.delete(schema.cashReceipts);
    await db.delete(schema.remittanceRegister);
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await receipt(1, 200_800, "2026-09-16", "EFT-99900001", "999|invented payer a|eft-99900001|2026-09-16");
    const { c } = await ask(BANKED);
    assert.equal(c.ok, true);
    assert.match(c.observed, /with a payment number have their cash/);
  });

  /*
   * The same two remittances with the deposit's key carrying the SECOND one's remittance number, which is how the pair stood on the books.
   * The matcher stands the deposit for the second remittance, so nothing stands for the first by any evidence: not its payment number, not
   * its remittance number, not an amount that is already spent. The card says that, which tells him the deposit is not hiding under
   * another reference, and the check still fails because a payment number is the payer saying a payment was sent.
   */
  test("when the deposit carries the other remittance's number, nothing stands for the first and the card says so", async () => {
    await db.delete(schema.cashReceipts);
    await db.delete(schema.remittanceRegister);
    await remit(1, "Invented Payer A", "2026-09-15", 200_800, "EFT-99900001");
    await remit(2, "Invented Payer A", "2026-09-23", 200_800, null);
    await receipt(1, 200_800, "2026-09-24", "EFT-99900002", "999|invented payer a|R-100002|2026-09-24");
    const { c, result } = await ask(BANKED);
    assert.equal(c.ok, false);
    assert.match(
      c.observed,
      /^1 remittance advised as paid and not banked, \$2,008\.00 \(Invented Payer A, advised 2026-09-15: no receipt stands for it, by payment number, remittance number or amount\), reading to 2026-09-23 \(\d+ days ago\) — the last ProviderPay export$/,
    );
    assert.doesNotMatch(JSON.stringify(result), /9990000\d/, "no payer payment number leaves the store");
  });
});
