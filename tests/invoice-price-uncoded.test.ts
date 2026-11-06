import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/* Nothing at the top: these modules open the database on first import. See support/scratch-db.ts. */
let checkInvoicePrices: typeof import("../src/lib/invoice-price-check").checkInvoicePrices;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ checkInvoicePrices } = await import("../src/lib/invoice-price-check"));
  ({ db, schema } = await import("../src/db"));
});

after(() => cleanUpDb?.());

/**
 * A line one of the two documents recorded without an NDC.
 *
 * The comparison keyed every line by its code and dropped any line that had none, so a delivery
 * PioneerRx booked in without an NDC did not exist as far as the check was concerned — and the
 * invoice line for it, now with no counterpart, was reported as goods billed and never received.
 *
 * On 1 October 2026 the owner's dashboard carried "$39.85 billed above what was booked in". $38.62
 * of it was eight McKesson lines of that shape, on invoices whose own totals agreed with PioneerRx's
 * to the cent — $45.41 against $45.41, $107.02 against $107.02, $171.22 against $171.22 — each
 * flagged line present on both documents with the same description, the same count and the same
 * money, one side simply having no code for it. The same fault ran the other way on an IPD invoice
 * whose EpiPen line our own reader holds with no NDC: PioneerRx's booking of it was reported as a
 * delivery nobody had billed for.
 *
 * "Billed and never booked in" is a claim against a wholesaler. It has to mean the money differs.
 */
describe("a line recorded without a code on one side", () => {
  const invoice = async (
    number: string,
    totalCents: number,
    lines: { ndc11: string | null; description: string; quantity: number; extendedCents: number }[],
    booked: { ndc11?: string | null; description: string; quantity: number; extendedCents: number }[],
  ) => {
    const id = `inv-${number}`;
    await db.insert(schema.supplierInvoices).values({
      id,
      documentId: `doc-${number}`,
      supplier: "Mckesson",
      invoiceNumber: number,
      invoiceDate: "2026-09-15",
      totalCents,
    });
    for (const [i, l] of lines.entries()) {
      await db.insert(schema.invoiceLines).values({
        id: `line-${number}-${i}`,
        invoiceId: id,
        supplier: "Mckesson",
        invoiceDate: "2026-09-15",
        ndc11: l.ndc11,
        description: l.description,
        quantity: l.quantity,
        unitCostCents: Math.round(l.extendedCents / l.quantity),
        extendedCents: l.extendedCents,
      });
    }
    await db.insert(schema.pioneerPurchases).values({
      id: `pr-${number}`,
      supplier: "Mckesson",
      invoiceNumber: number,
      invoiceDate: "2026-09-15",
      totalCents: booked.reduce((n, b) => n + b.extendedCents, 0),
      lines: booked.length,
      itemsJson: JSON.stringify(booked.map((b) => ({ ...b, ndc11: b.ndc11 ?? null, unitCostCents: Math.round(b.extendedCents / b.quantity) }))),
    });
  };

  before(async () => {
    /* The Luden's: the invoice carries the code, PioneerRx booked it blind. Same count, same money. */
    await invoice("7000000004", 149, [{ ndc11: "81483201043", description: "LUDEN'S THR/D WILD CHER BAG30", quantity: 1, extendedCents: 149 }], [
      { ndc11: null, description: "Luden S Thr D Wild Cher Bag30", quantity: 1, extendedCents: 149 },
    ]);

    /* The mirror: our reader holds the line with no code and PioneerRx booked it with one. */
    await invoice("7000000005", 23999, [{ ndc11: null, description: "EPINEPHRINE AUTO-INJECT", quantity: 1, extendedCents: 23999 }], [
      { ndc11: "00115169449", description: "EPINEPHRINE 0.3 MG AUTO-INJECT", quantity: 1, extendedCents: 23999 },
    ]);

    /* Genuinely billed and not received: there is no line on the delivery at that money at all. */
    await invoice(
      "7000000006",
      1_500,
      [
        { ndc11: "81483201043", description: "SOMETHING BILLED", quantity: 1, extendedCents: 500 },
        { ndc11: "00187546606", description: "SOMETHING ELSE", quantity: 1, extendedCents: 1_000 },
      ],
      [{ ndc11: "00187546606", description: "SOMETHING ELSE", quantity: 1, extendedCents: 1_000 }],
    );

    /* Two blind lines at the same money: which is which cannot be told, so neither is guessed at. */
    await invoice(
      "7000000007",
      1_000,
      [
        { ndc11: "81483201043", description: "FIRST", quantity: 1, extendedCents: 500 },
        { ndc11: "00187546606", description: "SECOND", quantity: 1, extendedCents: 500 },
      ],
      [
        { ndc11: null, description: "One of them", quantity: 1, extendedCents: 500 },
        { ndc11: null, description: "The other", quantity: 1, extendedCents: 500 },
      ],
    );
  });

  test("a coded invoice line and a blind delivery line at the same money are one delivery", async () => {
    const r = await checkInvoicePrices();
    const mine = r.disagreements.filter((d) => d.invoiceNumber === "7000000004");
    assert.deepEqual(mine, [], `nothing should be wrong here: ${JSON.stringify(mine)}`);
  });

  test("and it is counted as compared rather than quietly skipped", async () => {
    const r = await checkInvoicePrices();
    assert.ok(
      r.codeDifferences.some((c) => c.invoiceNumber === "7000000004" && c.why === "no-ndc"),
      "the pairing is recorded, so the missing code is visible as a gap in the record",
    );
  });

  test("the mirror case is a delivery too, not one nobody billed for", async () => {
    const r = await checkInvoicePrices();
    assert.deepEqual(
      r.disagreements.filter((d) => d.invoiceNumber === "7000000005"),
      [],
    );
  });

  test("a line genuinely billed and not delivered is still reported", async () => {
    const r = await checkInvoicePrices();
    const mine = r.disagreements.filter((d) => d.invoiceNumber === "7000000006" && d.kind === "billed-not-received");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].differenceCents, 500);
  });

  /*
   * The ambiguous case, which must not be resolved by guessing. Two blind lines at $5.00 each cannot
   * say which coded line each belongs to, and putting the wrong description against the money is a
   * worse record than saying so.
   */
  test("two blind lines at the same money are not paired by guesswork", async () => {
    const r = await checkInvoicePrices();
    const paired = r.codeDifferences.filter((c) => c.invoiceNumber === "7000000007");
    assert.equal(paired.length, 0, "neither pairing is provable, so neither is made");
  });
});
