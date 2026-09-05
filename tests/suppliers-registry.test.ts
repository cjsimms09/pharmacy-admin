import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { supplierForSender, normaliseAddresses, addressesOf, supplierRecordFor, type Supplier } from "../src/lib/suppliers-registry";

/**
 * Recognising who sent an invoice.
 *
 * This is the load-bearing step of the whole archive. An invoice files itself only if the sender
 * is recognised; anything unrecognised goes into the general document vault instead, where it is
 * commingled with every other record — which is the one outcome 21 CFR 1304.04(h)(1) does not
 * allow, and nothing about a tidy archive reveals that it is missing.
 */
const supplier = (name: string, senderEmails: string) =>
  ({ id: name.toLowerCase(), name, senderEmails, active: true }) as Parameters<typeof supplierForSender>[0][number];

describe("which supplier a message came from", () => {
  const register = [
    supplier("McKesson", "invoices@mckesson.com\nmckesson.com"),
    supplier("IPC", "ipcrx.com"),
    supplier("IPD", "billing@ipdrx.com"),
  ];

  test("a full address matches", () => {
    assert.equal(supplierForSender(register, "invoices@mckesson.com")?.name, "McKesson");
  });

  test("a bare domain matches any mailbox at that company", () => {
    // Wholesalers send from a different mailbox most months. Matching the domain is what keeps
    // the archive complete when billing@ becomes ar-noreply@.
    assert.equal(supplierForSender(register, "ar-noreply@mckesson.com")?.name, "McKesson");
    assert.equal(supplierForSender(register, "orders@ipcrx.com")?.name, "IPC");
  });

  test("case does not decide anything", () => {
    assert.equal(supplierForSender(register, "Invoices@McKesson.COM")?.name, "McKesson");
  });

  test("an unknown sender is nobody, rather than the first supplier on the list", () => {
    // Guessing here would file somebody else's PDF as a controlled substance record.
    assert.equal(supplierForSender(register, "newsletter@example.com"), null);
    assert.equal(supplierForSender(register, ""), null);
  });

  test("the longest match wins, so a full address beats a shared domain", () => {
    const shared = [supplier("Big Group", "grouprx.com"), supplier("Local Depot", "invoices@grouprx.com")];
    assert.equal(supplierForSender(shared, "invoices@grouprx.com")?.name, "Local Depot");
    assert.equal(supplierForSender(shared, "other@grouprx.com")?.name, "Big Group");
  });
});

describe("tidying the addresses somebody typed", () => {
  test("commas, semicolons and newlines all mean 'another one'", () => {
    assert.equal(normaliseAddresses("a@x.com, b@x.com; c@x.com"), "a@x.com\nb@x.com\nc@x.com");
  });

  test("what a mail client pastes in is accepted", () => {
    // Copying an address out of Outlook gives you <mailto: wrappers and stray case.
    assert.equal(normaliseAddresses("  MAILTO:Invoices@McKesson.com  "), "invoices@mckesson.com");
    assert.equal(normaliseAddresses("<billing@ipdrx.com>"), "billing@ipdrx.com");
  });

  test("the same address twice is stored once", () => {
    assert.equal(normaliseAddresses("a@x.com\nA@X.com"), "a@x.com");
  });

  test("empty stays empty rather than becoming a blank line that matches everything", () => {
    // A blank entry would make every sender match, filing the whole inbox as invoices.
    assert.equal(normaliseAddresses("\n\n  \n"), "");
    assert.deepEqual(addressesOf(supplier("X", "")), []);
  });
});

describe("which register row a catalogue or invoice name belongs to", () => {
  const row = (name: string, catalogName: string | null = null) =>
    ({ id: name.toLowerCase(), name, catalogName, senderEmails: "", active: true } as unknown as Supplier);
  const register = [row("McKesson Corporation", "McKesson"), row("Independent Pharmacy Distributor", "IPD"), row("Cardinal Health (ParMed)", "ParMed")];

  test("the catalogue name wins, however it is cased or spaced", () => {
    assert.equal(supplierRecordFor(register, "McKesson")?.id, "mckesson corporation");
    assert.equal(supplierRecordFor(register, "MCKESSON")?.id, "mckesson corporation");
    assert.equal(supplierRecordFor(register, "ipd")?.id, "independent pharmacy distributor");
  });

  test("the register name matches too, and so does the catalogue's canonical spelling", () => {
    assert.equal(supplierRecordFor(register, "Cardinal Health (ParMed)")?.id, "cardinal health (parmed)");
    // "parmed" is what the pharmacy abbreviates it to in a filename; the reader canonicalises it to ParMed.
    assert.equal(supplierRecordFor(register, "parmed")?.id, "cardinal health (parmed)");
    assert.equal(supplierRecordFor(register, "Mck")?.id, "mckesson corporation");
  });

  test("a name nobody has recorded is null, not the nearest thing", () => {
    assert.equal(supplierRecordFor(register, "Anda"), null);
    assert.equal(supplierRecordFor(register, ""), null);
    assert.equal(supplierRecordFor(register, null), null);
  });
});
