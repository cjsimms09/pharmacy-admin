import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  supplierForSender,
  normaliseAddresses,
  normaliseAliases,
  addressesOf,
  aliasesOf,
  supplierRecordFor,
  type Supplier,
} from "../src/lib/suppliers-registry";

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

/**
 * The bug this replaced, kept as tests because it cost real money quietly.
 *
 * earningSoFar reached a supplier from an invoice line by asking whether either name contained
 * the other. On this pharmacy's own register that is wrong in both directions at once, and the
 * second direction is the dangerous one: a rebate claimed on another wholesaler's spend is a
 * number that looks entirely right.
 */
describe("names an invoice prints that the register does not use", () => {
  const row = (name: string, catalogName: string | null, aliases = "") =>
    ({ id: name.toLowerCase(), name, catalogName, aliases, senderEmails: "", active: true } as unknown as Supplier);

  // The register as it actually stands: short codes, and no catalogue name on any of them.
  const bare = [row("IPC", null), row("IPD", null), row("Mckesson", null)];

  test("the eight lines that went missing: no alias, no match, and no guess either", () => {
    // "IPC" neither contains nor is contained by the name on its own invoices. Before aliases
    // existed the honest answer was null, and null is what the caller must be given so it can
    // say the line is unplaced instead of dropping it.
    assert.equal(supplierRecordFor(bare, "Independent Pharmacy Cooperative"), null);
  });

  test("no register row claims a line that names none of them", () => {
    // The gap is the honest outcome. What must never happen is one of these three rows taking the
    // line on a partial resemblance and putting another wholesaler's spend on its own ladder.
    for (const r of bare) {
      assert.notEqual(
        supplierRecordFor(bare, "Independent Pharmacy Cooperative")?.id,
        r.id,
        `${r.name} must not claim a line it was never named on`,
      );
    }
  });

  test("a short printed name is not handed to whichever row happens to be listed first", () => {
    // The other direction of the old containment test, and the dangerous one: "IP" is contained in
    // both "IPC" and "IPD", it took the first hit, and it had no tie-break — so the answer was
    // decided by the order of the register rather than by anything on the invoice. Equality gives
    // no answer at all, which is what an ambiguous abbreviation deserves.
    assert.equal(supplierRecordFor(bare, "IP"), null);
    assert.equal(supplierRecordFor([...bare].reverse(), "IP"), null);
  });

  test("with the alias typed, the line lands on IPC and on nobody else", () => {
    const fixed = [row("IPC", null, "Independent Pharmacy Cooperative"), row("IPD", null), row("Mckesson", null)];
    assert.equal(supplierRecordFor(fixed, "Independent Pharmacy Cooperative")?.id, "ipc");
    // And the short code still works, because an alias adds a spelling rather than replacing one.
    assert.equal(supplierRecordFor(fixed, "IPC")?.id, "ipc");
  });

  test("an alias is matched case- and punctuation-blind, like every other name here", () => {
    const fixed = [row("IPC", null, "Independent Pharmacy Cooperative, Inc.")];
    assert.equal(supplierRecordFor(fixed, "INDEPENDENT PHARMACY COOPERATIVE INC")?.id, "ipc");
    assert.equal(supplierRecordFor(fixed, "independent-pharmacy-cooperative-inc.")?.id, "ipc");
  });

  test("an alias never outranks another supplier's own name or catalogue name", () => {
    // Somebody types a name into the wrong row. The row that is actually called that still wins,
    // so a typo cannot quietly move a wholesaler's purchases onto another's rebate ladder.
    const clash = [row("IPC", null, "McKesson"), row("Mckesson", "McKesson")];
    assert.equal(supplierRecordFor(clash, "McKesson")?.id, "mckesson");
  });

  test("a supplier with no aliases behaves exactly as before", () => {
    assert.deepEqual(aliasesOf(row("IPC", null)), []);
    assert.deepEqual(aliasesOf(row("IPC", null, "")), []);
    assert.equal(supplierRecordFor(bare, "Anda"), null);
  });
});

describe("tidying the aliases somebody typed", () => {
  test("one per line, and commas or semicolons mean another one", () => {
    assert.equal(
      normaliseAliases("Independent Pharmacy Cooperative, IPC Rx; Cooperative"),
      "Independent Pharmacy Cooperative\nIPC Rx\nCooperative",
    );
  });

  test("spelling is kept exactly as typed, because it is what the invoice says", () => {
    // The matcher squashes both sides before comparing, so nothing is gained by lowercasing it
    // here — and the pharmacy should read back the name it actually sees on the page.
    assert.equal(normaliseAliases("  Independent Pharmacy Cooperative  "), "Independent Pharmacy Cooperative");
  });

  test("the same name twice, however punctuated, is stored once", () => {
    assert.equal(normaliseAliases("IPC Rx\nipc-rx\nI.P.C. RX"), "IPC Rx");
  });

  test("blank lines never become an alias that matches everything", () => {
    // An empty alias would squash to "" and, compared with equality, still match nothing — but it
    // would show on the screen as a supplier with a nameless alias. Kept out at the door.
    assert.equal(normaliseAliases("\n\n  \n"), "");
    assert.equal(normaliseAliases(",,;"), "");
  });
});
