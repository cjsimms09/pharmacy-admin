import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * The compliance panel's own arithmetic.
 *
 * Every fault fixed here had correct arithmetic and passing tests. They were sentences counted over
 * one list and printed against another, and a control that could never be rendered — the class the
 * constitution calls two correct things meeting. So these cases are about what the words claim, not
 * about whether the numbers add up.
 *
 * Every number is invented. Nothing is imported at the top: the database is fixed on first import.
 */
let invoiceCompliance: typeof import("../src/lib/invoice-compliance").invoiceCompliance;
let setSetting: typeof import("../src/lib/settings").setSetting;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ invoiceCompliance } = await import("../src/lib/invoice-compliance"));
  ({ setSetting } = await import("../src/lib/settings"));
  ({ db, schema } = await import("../src/db"));
});

after(() => cleanUpDb?.());

const line = async (key: string) => (await invoiceCompliance()).find((c) => c.key === key)!;

/** An invoice on file, with or without a receipt recorded against it. */
async function fileInvoice(o: { schedule: string; receivedOn?: string | null }) {
  const id = `inv-${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(schema.documents).values({ id: `doc-${id}`, category: "invoice", title: "t", fileName: "t.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: id, storageKey: `x/${id}`, uploadedBy: "test" } as never);
  await db.insert(schema.supplierInvoices).values({
    id,
    documentId: `doc-${id}`,
    supplier: "Testco",
    invoiceNumber: id.slice(4),
    invoiceDate: "2026-09-15",
    totalCents: 1000,
    schedule: o.schedule,
    receivedOn: o.receivedOn ?? null,
  } as never);
  return id;
}

describe("the receipt line counts the invoices it is talking about", () => {
  test("REGRESSION: it never reports receipts that do not exist", async () => {
    /*
     * Ten ordinary invoices and three carrying controlled items, none of them receipted. The panel
     * printed "41 of 54 confirmed received" on exactly this shape — the shortfall counted over the
     * controlled invoices, subtracted from a total counted over all of them. Nothing on the site had
     * a receipt at all.
     */
    for (let i = 0; i < 10; i++) await fileInvoice({ schedule: "none" });
    for (let i = 0; i < 3; i++) await fileInvoice({ schedule: "schedule_2" });

    const c = await line("receipt");
    assert.match(c.how, /0 of the 3 invoices carrying controlled items/);
    assert.doesNotMatch(c.how, /\b13 of 13\b|\b10 of 13\b/, "the ordinary invoices are not receipts");
    assert.equal(c.state, "attention");
    assert.match(String(c.fix), /3 invoices have no record that the goods arrived/);
  });

  test("a receipt recorded against a controlled invoice is the only thing that moves the count", async () => {
    await fileInvoice({ schedule: "schedule_3_5", receivedOn: "2026-09-16" });
    const c = await line("receipt");
    assert.match(c.how, /1 of the 4 invoices carrying controlled items/);
  });

  test("naming the system where receipt is recorded settles it, and the control stays to undo it", async () => {
    await setSetting("receipt_record_kept_in", "Testco Connect");
    const c = await line("receipt");
    assert.equal(c.state, "ok");
    assert.match(c.how, /Testco Connect/);
    assert.equal(c.settle?.kind, "receipt_kept_in");
    assert.equal(c.settle?.kind === "receipt_kept_in" ? c.settle.current : "", "Testco Connect", "the form shows what was said, so it can be changed");
    await setSetting("receipt_record_kept_in", "");
  });
});

describe("the order-form line can be answered", () => {
  test("unanswered, it says plainly that this system does not hold them", async () => {
    const c = await line("order-forms");
    assert.equal(c.state, "attention");
    assert.match(c.how, /Not held here/);
    assert.equal(c.settle?.kind, "order_forms_kept_in", "and it offers the way to answer it");
  });

  test("REGRESSION: saying where the 222s are settles it, rather than sitting red for ever", async () => {
    await setSetting("order_forms_kept_in", "the CSOS system");
    const c = await line("order-forms");
    assert.equal(c.state, "ok");
    assert.match(c.how, /the CSOS system/);
    /* It records where they are. It must never claim they are complete — nothing here can see them. */
    assert.doesNotMatch(String(c.fix), /complete\b(?!\.)/);
    assert.match(String(c.fix), /records where they are, not that they are complete/);
    await setSetting("order_forms_kept_in", "");
  });
});

describe("the capture line counts suppliers by what the sentence claims", () => {
  test("REGRESSION: a supplier with no sending address is not 'recognised by the address they send from'", async () => {
    await db.insert(schema.suppliers).values([
      { id: "sup-a", name: "Has Address", active: true, senderEmails: "invoices@example-a.test" },
      { id: "sup-b", name: "Also Has", active: true, senderEmails: "billing@example-b.test" },
      { id: "sup-c", name: "Receipt Is Invoice", active: true, senderEmails: "", invoiceFromPioneer: true },
      { id: "sup-d", name: "No Address Yet", active: true, senderEmails: "" },
    ] as never);

    const c = await line("capture");
    assert.match(c.how, /^2 suppliers are recognised by the address they send from/, "two have one; the settled one and the addressless one are not among them");
    assert.match(String(c.fix), /No Address Yet/, "and the one with no address is named as needing a press, not counted as recognised");
    assert.equal(c.settle?.kind, "supplier_address");
  });
});
