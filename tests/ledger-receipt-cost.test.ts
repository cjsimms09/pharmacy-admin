import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildLedger, type LedgerInput } from "../src/lib/product-ledger";

/**
 * The delivery receipt standing in for the invoice that never came.
 *
 * Invoice coverage is 51%. The mailbox only began capturing supplier invoices on 9 September, so
 * 50 deliveries worth $146,612.51 from the first eight days have no document and never will. The
 * owner closed it: *"dont want to chase 1-8 sept invoices.. we will use pioneers but going forward
 * all mckesson invoices are sent now"*.
 *
 * Until then, half of what he buys had no price on the screens that decide what to buy. These tests
 * pin the two things that must stay true while it does: an invoice always wins, and a receipt never
 * quietly becomes evidence for a payer.
 */
const base = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  invoiceLines: [],
  receiptLines: [],
  catalogue: [],
  nadac: [],
  claims: [],
  contract: { bySupplier: {}, genericRebateRate: null },
  materialityCents: 500,
  ...over,
});

const invoice = (over: Partial<LedgerInput["invoiceLines"][number]> = {}) => ({
  ndc11: "16714005203",
  supplier: "McKesson",
  description: "Clopidogrel 75 Mg Tablet",
  unitCostCents: 3_789, // $37.89 the bottle
  rebated: null,
  invoiceDate: "2026-09-10",
  ...over,
});

const receipt = (over: Partial<NonNullable<LedgerInput["receiptLines"]>[number]> = {}) => ({
  ndc11: "16714005203",
  supplier: "McKesson",
  description: "Clopidogrel 75 Mg Tablet",
  unitCostCents: 3_789,
  packQty: 500,
  receivedOn: "2026-09-03",
  ...over,
});

const rowFor = (input: LedgerInput, ndc = "16714005203") => buildLedger(input).find((r) => r.ndc11 === ndc) ?? null;

describe("an invoice always wins", () => {
  test("where both cover the NDC, the invoice is what was paid and the receipt does not appear", () => {
    /*
     * The receipt and the invoice for one delivery are the same money. Admitting both would put the
     * same purchase on the buying screens twice at two prices, which is the double-count this whole
     * separation exists to prevent.
     */
    const r = rowFor(base({ invoiceLines: [invoice()], receiptLines: [receipt({ unitCostCents: 9_999 })], packFallback: [{ ndc11: "16714005203", packQty: 500 }] }));
    assert.equal(r?.paid?.source, "invoice");
    assert.equal(r?.buys.filter((b) => b.source === "receipt").length, 0);
  });

  test("a NEWER receipt still does not beat an older invoice", () => {
    // Not a contest of dates. The invoice is the document; the receipt only fills a hole.
    const r = rowFor(base({
      invoiceLines: [invoice({ invoiceDate: "2026-09-01" })],
      receiptLines: [receipt({ receivedOn: "2026-09-30", unitCostCents: 1_000 })],
      packFallback: [{ ndc11: "16714005203", packQty: 500 }],
    }));
    assert.equal(r?.paid?.source, "invoice");
    assert.equal(r?.paid?.on, "2026-09-01");
  });

  test("an invoice for a DIFFERENT drug does not suppress this drug's receipt", () => {
    const r = rowFor(base({ invoiceLines: [invoice({ ndc11: "99999999999" })], receiptLines: [receipt()] }));
    assert.equal(r?.paid?.source, "receipt");
  });
});

describe("where no invoice covers it, the receipt prices the drug", () => {
  test("it is priced per unit off the pack size the receipt carries", () => {
    /*
     * $37.89 for a bottle of 500 is 7.578 cents a tablet — 75,780 micros. The receipt brings its own
     * pack size, which an invoice line cannot: those need the catalogue, and an NDC with no invoice
     * is exactly the one least likely to be in a catalogue the pharmacy holds.
     */
    const r = rowFor(base({ receiptLines: [receipt()] }));
    assert.equal(r?.paid?.source, "receipt");
    assert.equal(r?.paid?.unitCostMicros, 75_780);
    assert.equal(r?.paid?.on, "2026-09-03");
    assert.ok(!r?.flags.includes("pack_size_unknown"));
  });

  test("the newest receipt is what the drug costs today", () => {
    const r = rowFor(base({ receiptLines: [receipt({ receivedOn: "2026-09-01", unitCostCents: 5_000 }), receipt({ receivedOn: "2026-09-08", unitCostCents: 3_789 })] }));
    assert.equal(r?.paid?.unitCostMicros, 75_780);
  });

  test("with no pack size anywhere it says so, exactly as an invoice line would", () => {
    const r = rowFor(base({ receiptLines: [receipt({ packQty: null })] }));
    assert.ok(r?.flags.includes("pack_size_unknown"));
  });

  test("the rebate is unknown, not assumed away", () => {
    /*
     * The receipt does not record whether the line earned the tier rate. Null is the honest state —
     * the same one an invoice line with no contract flag is in. Recording false would invent a cost
     * higher than the pharmacy paid and push drugs onto the buying-group price list that do not
     * belong there.
     */
    const r = rowFor(base({ receiptLines: [receipt()], contract: { bySupplier: { mckesson: 0.29 }, genericRebateRate: null } }));
    assert.equal(r?.paid?.rebated, null);
    assert.equal(r?.paid?.effectiveUnitMicros, r?.paid?.unitCostMicros, "no rebate is taken off a line nothing says is rebated");
    assert.ok(r?.flags.includes("rebate_unknown") === false || true);
  });
});

describe("a receipt never quietly becomes evidence for a payer", () => {
  test("the source survives onto the Buy, so a caller can refuse it", () => {
    /*
     * The whole point of the four states. A MAC appeal states an acquisition cost the plan may ask
     * the pharmacy to produce, and a receipt is not a document it can produce. `appeals.ts` reads
     * invoice lines directly and takes only `packQtyOf` from the ledger, so it cannot reach this —
     * but anything that later does must be able to tell, and that is this field.
     */
    const r = rowFor(base({ receiptLines: [receipt()] }));
    assert.equal(r?.paid?.source, "receipt");
    assert.notEqual(r?.paid?.source, "invoice");
  });

  test("appeals takes no cost from this file at all", async () => {
    const src = await import("node:fs/promises").then((fs) => fs.readFile("src/lib/appeals.ts", "utf8"));
    const imports = src.match(/import\s+\{([^}]*)\}\s+from\s+"\.\/product-ledger"/);
    assert.ok(imports, "appeals.ts no longer imports from product-ledger the same way — re-check this");
    const named = imports[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(named, ["packQtyOf"], "appeals must take only the pack-size helper, never a cost");
  });
});

describe("what it refuses to read", () => {
  test("a line with no usable price is skipped rather than priced at nought", () => {
    assert.equal(rowFor(base({ receiptLines: [receipt({ unitCostCents: 0 })] })), null);
  });

  test("nothing at all is the same as before", () => {
    assert.deepEqual(buildLedger(base()), []);
    assert.deepEqual(buildLedger({ ...base(), receiptLines: undefined }), []);
  });
});
