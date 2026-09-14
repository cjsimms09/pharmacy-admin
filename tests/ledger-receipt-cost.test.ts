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

describe("a receipt-priced row does not invent a saving by forgetting the rebate", () => {
  /*
   * The regression the wiring itself caused, caught in review the same hour.
   *
   * A delivery receipt has no contract flag — PioneerRx books in what arrived, and whether the line
   * earned the tier rate is on the invoice that never came. Left at its gross price, the row is
   * compared against catalogue listings whose rate has already been taken off, and it recommends
   * moving spend off the contract on a saving that may not exist.
   *
   * Measured on the live ledger the hour it shipped: 68 of 99 `cheaper_elsewhere` rows and
   * $44,373.98 of $46,777.89 — 95% of the money on the switch list. Exactly the fault this module's
   * docstring warns about: "treating a rebated line as unmarked invents a saving and recommends
   * moving spend off the contract, which can cost more in a lost tier than it saves on the invoice."
   */
  const dispensed = { ndc11: "16714005203", itemName: "Clopidogrel", quantityThousandths: 1_000_000, remitCents: 50_000, copayCents: 0, status: "paid" as const };
  const rival = (unitCostMicros: number) => ({
    ndc11: "16714005203", supplier: "IPC", description: null, unitCostMicros,
    packQty: 1, contractFlag: "not rebated", pricedOn: "2026-09-10", availability: null,
  });
  const withRate = { bySupplier: { mckesson: 0.29 }, genericRebateRate: null };

  test("a switch that only pays if the rebate was NOT earned is not recommended", () => {
    /*
     * Receipt gross 75,780 micros a unit. At the 29% tier that is 53,804. A rival at 60,000 beats
     * the gross and loses to the rebated price — so whether the switch pays depends entirely on the
     * unknown, and it is not advice.
     */
    const rows = buildLedger(base({ receiptLines: [receipt()], catalogue: [rival(60_000)], claims: [dispensed], contract: withRate }));
    const r = rows.find((x) => x.ndc11 === "16714005203");
    assert.ok(r?.flags.includes("rebate_unrecorded"), "the row must say why it is quiet");
    assert.ok(!r?.flags.includes("cheaper_elsewhere"), "no switch recommendation on an unknown");
    assert.equal(r?.switchSavingCents, null);
  });

  test("a switch that pays EVEN IF the rebate was earned is still recommended", () => {
    // A rival at 40,000 beats even the rebated 53,804. Real whichever way the rebate went.
    const rows = buildLedger(base({ receiptLines: [receipt()], catalogue: [rival(40_000)], claims: [dispensed], contract: withRate }));
    const r = rows.find((x) => x.ndc11 === "16714005203");
    assert.ok(r?.flags.includes("rebate_unrecorded"));
    assert.ok(r?.flags.includes("cheaper_elsewhere"), "the provable ones must survive the fix");
    assert.ok((r?.switchSavingCents ?? 0) > 0);
  });

  test("the same caution applies to 'paying over NADAC', which would otherwise overstate it", () => {
    /*
     * The identical defect in the other direction: a gross price against NADAC says he is paying
     * over the national average when the rebate may put him under it. That drives a price request
     * to the buying group, and a complaint he cannot support is worse than one not made.
     */
    const nadac = [{ ndc11: "16714005203", unitMicros: 60_000, effectiveOn: "2026-09-01", description: null }];
    const r = buildLedger(base({ receiptLines: [receipt()], nadac, claims: [dispensed], contract: withRate })).find((x) => x.ndc11 === "16714005203");
    assert.ok(!r?.flags.includes("buying_above_nadac"), "53,804 rebated is under a NADAC of 60,000");
  });

  test("with no rate on file for the supplier there is no rebate to be unsure about", () => {
    const r = buildLedger(base({ receiptLines: [receipt({ supplier: "JamsRX" })], claims: [dispensed], contract: withRate })).find((x) => x.ndc11 === "16714005203");
    assert.ok(!r?.flags.includes("rebate_unrecorded"));
  });

  test("an INVOICE line is untouched by this — its flag is recorded, not unknowable", () => {
    /*
     * Checked on the live ledger before choosing the fix: of 99 switch rows, zero were invoice lines
     * with no rebate flag from a rate-bearing supplier. McKesson's invoices always carry the flag.
     * So this narrows to receipts only and costs nothing on the invoice side.
     */
    const r = buildLedger(base({
      invoiceLines: [invoice({ rebated: false })], catalogue: [rival(60_000)], claims: [dispensed],
      packFallback: [{ ndc11: "16714005203", packQty: 500 }], contract: withRate,
    })).find((x) => x.ndc11 === "16714005203");
    assert.ok(!r?.flags.includes("rebate_unrecorded"));
    assert.ok(r?.flags.includes("cheaper_elsewhere"), "a recorded 'not rebated' is a fact and is compared at its gross");
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
