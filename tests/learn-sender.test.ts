import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { learnSender, addressIn, senderLines, type SupplierSenders } from "../src/lib/learn-sender";

/**
 * The owner: "why do I have to put in the email that invoices come from for each supplier? Once we
 * get an invoice from a supplier and I tell the system it's an invoice from that supplier it should
 * automatically save that email as where invoices come from."
 */
const mckesson: SupplierSenders = { id: "mck", name: "McKesson", senderEmails: "" };
const ipc: SupplierSenders = { id: "ipc", name: "Independent Pharmacy Cooperative", senderEmails: "invoices@ipcrx.com" };

describe("reading the sender", () => {
  test("a bare address", () => assert.equal(addressIn("ar-billing@mckesson.com"), "ar-billing@mckesson.com"));
  test("a name and an address", () => assert.equal(addressIn("McKesson Billing <AR-Billing@McKesson.com>"), "ar-billing@mckesson.com"));
  test("nothing usable is null, not an empty string", () => {
    assert.equal(addressIn(""), null);
    assert.equal(addressIn(null), null);
    assert.equal(addressIn("scanned at the counter"), null);
    assert.equal(addressIn("not-an-address@"), null);
  });
  test("the field splits on lines and tidies", () => {
    assert.deepEqual(senderLines(" A@b.com \n\n C@d.com "), ["a@b.com", "c@d.com"]);
    assert.deepEqual(senderLines(null), []);
  });
});

describe("what filing an invoice teaches", () => {
  test("the first invoice from a supplier records where it came from", () => {
    const r = learnSender(mckesson, "McKesson Billing <AR-Billing@McKesson.com>");
    assert.equal(r.learn, true);
    if (r.learn) {
      assert.equal(r.address, "ar-billing@mckesson.com");
      assert.equal(r.senderEmails, "ar-billing@mckesson.com");
      assert.match(r.why, /will now file themselves as McKesson/);
    }
  });

  test("a second address from the same supplier is added beside the first", () => {
    const known: SupplierSenders = { ...mckesson, senderEmails: "ar-billing@mckesson.com" };
    const r = learnSender(known, "invoices@mckesson.com");
    assert.equal(r.learn, true);
    if (r.learn) assert.equal(r.senderEmails, "ar-billing@mckesson.com\ninvoices@mckesson.com");
  });

  /*
   * A hundred invoices from one mailbox must add one line, not a hundred. This is the case that
   * decides whether the register stays readable.
   */
  test("an address already on file is not added again", () => {
    const r = learnSender(ipc, "Invoices <invoices@ipcrx.com>");
    assert.equal(r.learn, false);
    if (!r.learn) assert.match(r.why, /already filed under invoices@ipcrx\.com/);
  });

  /*
   * A supplier set to a bare domain is meant to accept every mailbox there. Adding each one as it
   * appears would turn a deliberate rule into a list that grows for ever and hides the rule.
   */
  test("a domain rule already covers every mailbox at that domain", () => {
    const byDomain: SupplierSenders = { ...mckesson, senderEmails: "mckesson.com" };
    const r = learnSender(byDomain, "some-new-mailbox@mckesson.com");
    assert.equal(r.learn, false);
    if (!r.learn) assert.match(r.why, /already filed under mckesson\.com/);
  });

  test("an address another supplier already claims is never attached to two", () => {
    const r = learnSender(mckesson, "invoices@ipcrx.com", [ipc]);
    assert.equal(r.learn, false);
    if (!r.learn) assert.match(r.why, /Independent Pharmacy Cooperative already receives invoices from invoices@ipcrx\.com/);
  });

  test("a supplier does not block itself", () => {
    const r = learnSender(ipc, "billing@ipcrx.com", [ipc, mckesson]);
    assert.equal(r.learn, true, "its own row is not another supplier's claim");
  });

  test("an invoice filed from a scan teaches nothing, and says so rather than failing", () => {
    const r = learnSender(mckesson, "");
    assert.equal(r.learn, false);
    if (!r.learn) assert.match(r.why, /no readable sender address/);
  });
});
