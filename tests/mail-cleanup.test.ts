import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { safeToDelete, type HandledRow } from "../src/lib/mail-cleanup";

const row = (over: Partial<HandledRow> = {}): HandledRow => ({
  status: "stored",
  routedAs: "invoice",
  routeResult: "Supplier invoice, filed under No controlled substances, kept apart from every other record.",
  documentId: "doc-1",
  ...over,
});

/**
 * The owner asked for emails to be deleted once the site has what it needs. Everything else in the
 * mail path can be done again; a deleted email cannot, and on the day something has gone wrong it is
 * the only remaining evidence of what a supplier actually sent. So the test is not "did we finish
 * with it" but "can we prove we have it".
 */
describe("what may be deleted", () => {
  test("a message whose every attachment was stored and read", () => {
    const r = safeToDelete([row(), row({ routedAs: "report_summary", routeResult: "A totals sheet." })]);
    assert.equal(r.ok, true);
  });

  test("one recognised body-read message with no attachment at all", () => {
    /* The Health Mart EFT notice: four lines of text, no attachment, fully banked. */
    const r = safeToDelete([row({ routedAs: "payer_payments", documentId: null, routeResult: "Health Mart Atlas transferred $9,428.58 on 2026-09-15 in 1 payment. 1 deposit banked." })]);
    assert.equal(r.ok, true, "a document is not the only way to have taken something");
  });
});

describe("what is kept, and why keeping it is the cheap mistake", () => {
  test("nothing recorded means it was never processed", () => {
    assert.equal(safeToDelete([]).ok, false);
  });

  test("one attachment refused keeps the whole message", () => {
    /* Veridikal's reports were refused on 15 September; the email was the only copy. */
    const r = safeToDelete([row(), row({ status: "ignored", routedAs: "not_for_filing", routeResult: "Nothing on it was a type this reads." })]);
    assert.equal(r.ok, false);
    assert.match(r.why, /not stored/);
  });

  test("a document nobody could identify keeps its envelope", () => {
    const r = safeToDelete([row({ routedAs: "unrecognised", routeResult: "A PDF this does not recognise. Filed as a document." })]);
    assert.equal(r.ok, false);
    assert.match(r.why, /could not say what it was/);
  });

  test("a reader that stopped short keeps the original, however well it was filed", () => {
    /*
     * The status is "stored" for every one of these: the document was filed and the reading failed,
     * which is precisely when somebody goes back to the original.
     */
    for (const said of [
      "A supplies invoice this could not read: no invoice number. Enter it by hand on the Expenses page.",
      "The remittance does not balance: nothing from it was stored.",
      "1 invoice with no item lines kept.",
      "Held by the monthly ceiling.",
    ]) {
      assert.equal(safeToDelete([row({ routeResult: said })]).ok, false, said);
    }
  });

  test("a message that is half taken is not half deleted", () => {
    const r = safeToDelete([row(), row({ routeResult: "A supplies invoice this could not read: no total." })]);
    assert.equal(r.ok, false);
  });
});
