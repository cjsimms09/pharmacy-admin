import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildLedger, effectiveMicros, opportunities, packQtyOf, margins, losers, type LedgerInput } from "../src/lib/product-ledger";

/**
 * Whether the four records add up to a recommendation worth acting on.
 *
 * The figures are taken off this pharmacy's real invoices: latanoprost at $2.32 a unit with
 * McKesson's K against it, Emgality at $739.11 with no K. The rebate is the whole difficulty —
 * a rebated line's invoice price is not what the drug cost, and comparing it with a competitor's
 * price compares the wrong two numbers.
 */
const base = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  invoiceLines: [],
  catalogue: [],
  nadac: [],
  claims: [],
  contract: { genericRebateRate: 0.29 },
  materialityCents: 500,
  ...over,
});

const line = (o: Partial<LedgerInput["invoiceLines"][number]> = {}) => ({
  ndc11: "24208046325", supplier: "McKesson", description: "LATANOPROST OPH.005%",
  unitCostCents: 232, rebated: true, invoiceDate: "2026-09-04", ...o,
});

/**
 * A catalogue entry whose only job is to say how many units are in the package the invoice priced.
 *
 * Without one, nothing about that NDC can be compared — an invoice prices a pen and NADAC prices a
 * millilitre. Most rows have one because the catalogues carry thirty thousand NDCs; the tests that
 * do not are testing what happens when none is known.
 */
const packOnly = (ndc11: string, packQty: number) => ({
  ndc11, supplier: "pack size only", description: null, unitCostMicros: null,
  packQty, contractFlag: null, pricedOn: null, availability: null,
});

describe("the rebate, which decides every comparison", () => {
  test("a rebated line is compared at its price less the tier rate, not at what the invoice said", () => {
    // $2.32 with 29% back is $1.6472 — the number a competitor has to beat.
    assert.equal(effectiveMicros(2_320_000, true, 0.29), 1_647_200);
  });

  test("an unmarked line is never given a discount it may not earn", () => {
    assert.equal(effectiveMicros(2_320_000, false, 0.29), 2_320_000);
    assert.equal(effectiveMicros(2_320_000, null, 0.29), 2_320_000, "unknown is not the same as not rebated");
  });

  test("with no rate on file the gross price is used and the row says so", () => {
    const rows = buildLedger(base({ invoiceLines: [line()], contract: { genericRebateRate: null } }));
    assert.equal(rows[0].paid!.effectiveUnitMicros, 2_320_000);
    assert.ok(rows[0].flags.includes("rebate_unknown"), "a made-up rate must never sit inside a recommendation");
  });

  test("a cheaper competitor that only wins before the rebate is not a saving", () => {
    // ParMed at $1.90 beats McKesson's printed $2.32 and loses to its effective $1.65. Moving the
    // spend would cost money and lose contract volume, so nothing should be recommended.
    const rows = buildLedger(base({
      invoiceLines: [line()],
      catalogue: [{ ndc11: "24208046325", supplier: "ParMed", description: null, unitCostMicros: 1_900_000, packQty: 1, contractFlag: "not rebated", pricedOn: "2026-09-08", availability: null }],
      claims: [{ ndc11: "24208046325", itemName: null, quantityThousandths: 2_500_000, remitCents: 900, copayCents: 0 }],
    }));
    assert.equal(rows[0].best!.supplier, "McKesson", "the rebated line is genuinely the cheapest");
    assert.equal(rows[0].switchSavingCents, null);
    assert.ok(!rows[0].flags.includes("cheaper_elsewhere"));
  });

  test("a competitor that beats the effective price is a saving, scaled by what we dispensed", () => {
    const rows = buildLedger(base({
      invoiceLines: [line()],
      catalogue: [{ ndc11: "24208046325", supplier: "ParMed", description: null, unitCostMicros: 1_000_000, packQty: 1, contractFlag: "not rebated", pricedOn: "2026-09-08", availability: null }],
      claims: [{ ndc11: "24208046325", itemName: null, quantityThousandths: 100_000, remitCents: 900, copayCents: 0 }],
    }));
    // ($1.6472 − $1.00) × 100 units = $64.72
    assert.equal(rows[0].switchSavingCents, 6472);
    assert.ok(rows[0].flags.includes("cheaper_elsewhere"));
  });
});

describe("against the benchmark", () => {
  test("buying above NADAC is flagged; buying below it is not", () => {
    const above = buildLedger(base({
      invoiceLines: [line({ rebated: false })],
      catalogue: [packOnly("24208046325", 1)],
      nadac: [{ ndc11: "24208046325", unitMicros: 1_000_000, effectiveOn: "2026-09-02", description: "LATANOPROST" }],
    }));
    assert.equal(above[0].vsNadacMicros, 1_320_000);
    assert.ok(above[0].flags.includes("buying_above_nadac"));

    const below = buildLedger(base({
      invoiceLines: [line({ rebated: false })],
      catalogue: [packOnly("24208046325", 1)],
      nadac: [{ ndc11: "24208046325", unitMicros: 3_000_000, effectiveOn: "2026-09-02", description: null }],
    }));
    assert.equal(below[0].vsNadacMicros, -680_000);
    assert.ok(!below[0].flags.includes("buying_above_nadac"));
  });

  test("the rebate is taken off before the benchmark comparison too", () => {
    // $2.32 gross is above a $2.00 NADAC; $1.6472 effective is below it. Only one of those is true.
    const rows = buildLedger(base({
      invoiceLines: [line()],
      catalogue: [packOnly("24208046325", 1)],
      nadac: [{ ndc11: "24208046325", unitMicros: 2_000_000, effectiveOn: "2026-09-02", description: null }],
    }));
    assert.ok(!rows[0].flags.includes("buying_above_nadac"));
  });

  test("the newest NADAC in force is the one used", () => {
    const rows = buildLedger(base({
      invoiceLines: [line()],
      catalogue: [packOnly("24208046325", 1)],
      nadac: [
        { ndc11: "24208046325", unitMicros: 1_000_000, effectiveOn: "2026-08-05", description: null },
        { ndc11: "24208046325", unitMicros: 1_400_000, effectiveOn: "2026-09-09", description: null },
      ],
    }));
    assert.equal(rows[0].nadacMicros, 1_400_000);
    assert.equal(rows[0].nadacOn, "2026-09-09");
  });

  test("a drug with no NADAC says so rather than being scored against nothing", () => {
    const rows = buildLedger(base({ invoiceLines: [line()], catalogue: [packOnly("24208046325", 1)] }));
    assert.equal(rows[0].vsNadacMicros, null);
    assert.ok(rows[0].flags.includes("no_nadac"));
  });

  test("a benchmark for a drug we neither buy nor dispense is not a row", () => {
    const rows = buildLedger(base({ nadac: [{ ndc11: "99999999999", unitMicros: 100, effectiveOn: "2026-09-09", description: null }] }));
    assert.equal(rows.length, 0);
  });
});

describe("what to return, and what never to recommend", () => {
  test("stock bought and never dispensed is flagged as a return candidate", () => {
    const rows = buildLedger(base({ invoiceLines: [line({ ndc11: "00002143611", description: "EMGALITY", unitCostCents: 73_911, rebated: false })] }));
    assert.ok(rows[0].flags.includes("not_dispensed"));
  });

  test("a short-dated lot is never the recommendation, though it stays in the list", () => {
    const rows = buildLedger(base({
      invoiceLines: [line()],
      catalogue: [{ ndc11: "24208046325", supplier: "ParMed", description: null, unitCostMicros: 400_000, packQty: 1, contractFlag: null, pricedOn: "2026-09-08", availability: "Short-dated only (exp 11/26)" }],
      claims: [{ ndc11: "24208046325", itemName: null, quantityThousandths: 100_000, remitCents: 0, copayCents: 0 }],
    }));
    assert.equal(rows[0].best!.supplier, "McKesson", "expiring stock is not a bargain");
    assert.equal(rows[0].switchSavingCents, null);
    assert.equal(rows[0].buys.length, 2, "but the price is still on the record");
  });

  test("a reversed claim is not counted as dispensed", () => {
    const rows = buildLedger(base({
      invoiceLines: [line()],
      claims: [
        { ndc11: "24208046325", itemName: null, quantityThousandths: 100_000, remitCents: 900, copayCents: 0, status: "paid" },
        { ndc11: "24208046325", itemName: null, quantityThousandths: 100_000, remitCents: 900, copayCents: 0, status: "reversed" },
      ],
    }));
    assert.equal(rows[0].claims, 1);
    assert.equal(rows[0].unitsDispensed, 100);
  });

  test("a saving too small to be worth moving a supplier for is not offered as one", () => {
    const rows = buildLedger(base({
      invoiceLines: [line({ rebated: false })],
      catalogue: [{ ndc11: "24208046325", supplier: "ParMed", description: null, unitCostMicros: 2_310_000, packQty: 1, contractFlag: "not rebated", pricedOn: null, availability: null }],
      claims: [{ ndc11: "24208046325", itemName: null, quantityThousandths: 10_000, remitCents: 0, copayCents: 0 }],
    }));
    assert.ok((rows[0].switchSavingCents ?? 0) < 500);
    assert.ok(!rows[0].flags.includes("cheaper_elsewhere"));
  });
});

describe("what comes out of it", () => {
  test("the most valuable move comes first", () => {
    const rows = buildLedger(base({
      invoiceLines: [line(), line({ ndc11: "00093342505", description: "OTHER", unitCostCents: 1000, rebated: false })],
      catalogue: [
        { ndc11: "24208046325", supplier: "ParMed", description: null, unitCostMicros: 1_000_000, packQty: 1, contractFlag: "not rebated", pricedOn: null, availability: null },
        { ndc11: "00093342505", supplier: "IPD", description: null, unitCostMicros: 5_000_000, packQty: 1, contractFlag: "not rebated", pricedOn: null, availability: null },
      ],
      claims: [
        { ndc11: "24208046325", itemName: null, quantityThousandths: 100_000, remitCents: 0, copayCents: 0 },
        { ndc11: "00093342505", itemName: null, quantityThousandths: 1_000_000, remitCents: 0, copayCents: 0 },
      ],
    }));
    const top = opportunities(rows);
    // $5.00 a unit off a thousand units is $5,000; $0.65 off a hundred is $64.72. The bigger
    // number of dollars leads, not the bigger percentage — it is the one worth an afternoon.
    assert.equal(top[0].ndc11, "00093342505");
    assert.ok((top[0].switchSavingCents ?? 0) >= (top[1].switchSavingCents ?? 0));
  });

  test("the most recent invoice is what the pharmacy pays today", () => {
    const rows = buildLedger(base({
      invoiceLines: [
        line({ unitCostCents: 500, invoiceDate: "2026-07-01" }),
        line({ unitCostCents: 232, invoiceDate: "2026-09-04" }),
      ],
    }));
    assert.equal(rows[0].paid!.unitCostMicros, 2_320_000);
    assert.equal(rows[0].paid!.on, "2026-09-04");
  });
});

/**
 * The bug this section exists for.
 *
 * An invoice prices a package; a catalogue prices a unit inside it. Ozempic came off a real
 * McKesson invoice at $996.68 for a 3 mL pen, and off the same wholesaler's catalogue at
 * $332.2267 per millilitre. Those are the same price to the cent. The first version of the ledger
 * compared them directly, decided the catalogue was two thirds cheaper, and offered a saving of
 * ninety-nine thousand dollars for switching supplier to the supplier already being used.
 */
describe("a package is not a unit", () => {
  const ozempic = { ndc11: "00169418113", supplier: "McKesson", description: "OZEMPIC INJ 0.25MG/0.5MG 3ML", unitCostCents: 99_668, rebated: false, invoiceDate: "2026-09-04" };
  const cat = (over = {}) => ({ ndc11: "00169418113", supplier: "McKesson", description: null, unitCostMicros: 332_226_700, packQty: 3, contractFlag: "not rebated", pricedOn: "2026-09-08", availability: null, ...over });

  test("the same price quoted two ways is not a saving", () => {
    const rows = buildLedger(base({
      invoiceLines: [ozempic],
      catalogue: [cat()],
      claims: [{ ndc11: "00169418113", itemName: null, quantityThousandths: 300_000, remitCents: 0, copayCents: 0 }],
    }));
    assert.equal(rows[0].paid!.unitCostMicros, 332_226_667, "the invoice is put on a per-unit footing");
    assert.equal(rows[0].switchSavingCents, null, "switching to the supplier we already use saves nothing");
    assert.ok(!rows[0].flags.includes("cheaper_elsewhere"));
  });

  test("a genuinely cheaper supplier still shows, on the same footing", () => {
    const rows = buildLedger(base({
      invoiceLines: [ozempic],
      catalogue: [cat(), cat({ supplier: "ABC (Cencora)", unitCostMicros: 300_000_000 })],
      claims: [{ ndc11: "00169418113", itemName: null, quantityThousandths: 30_000, remitCents: 0, copayCents: 0 }],
    }));
    assert.equal(rows[0].best!.supplier, "ABC (Cencora)");
    // ($332.2267 − $300.00) × 30 units
    assert.equal(rows[0].switchSavingCents, 96_680);
  });

  test("the benchmark is compared per unit too, not against a package price", () => {
    const rows = buildLedger(base({
      invoiceLines: [ozempic],
      catalogue: [cat()],
      nadac: [{ ndc11: "00169418113", unitMicros: 340_000_000, effectiveOn: "2026-09-02", description: null }],
    }));
    // Per package the invoice looks $650 above a $340 NADAC. Per unit it is below it.
    assert.ok(rows[0].vsNadacMicros! < 0);
    assert.ok(!rows[0].flags.includes("buying_above_nadac"));
  });

  test("with no pack size known, nothing is concluded at all", () => {
    const rows = buildLedger(base({
      invoiceLines: [ozempic],
      nadac: [{ ndc11: "00169418113", unitMicros: 340_000_000, effectiveOn: "2026-09-02", description: null }],
      claims: [{ ndc11: "00169418113", itemName: null, quantityThousandths: 300_000, remitCents: 0, copayCents: 0 }],
    }));
    assert.ok(rows[0].flags.includes("pack_size_unknown"));
    assert.equal(rows[0].vsNadacMicros, null, "a package compared with a unit is the error, not a finding");
    assert.equal(rows[0].switchSavingCents, null);
    assert.ok(!rows[0].flags.includes("buying_above_nadac"));
  });

  test("a pack this cannot state is refused, not answered with the inner one", () => {
    /*
     * This used to assert 100, on the reading that the bracket is an order multiple and the
     * package is the hundred. The catalogue proof settled otherwise on 9 September: for a bracketed
     * pack the printed unit cost is the carton's cost over the inner pack alone, and the package is
     * cartons times inner — matched against NADAC on 1,593 of 2,147 multi-pack rows.
     *
     * Rather than answer 1,000 here, this refuses. `wholePackage` in catalogue-cache is the one
     * place that settles a package, and every caller of this is meant to be reading its output,
     * where no bracket survives. A bracket arriving means the caller read the raw table — which
     * `appeals.ts` did, dividing an invoice's per-package price by the inner pack and stating an
     * acquisition cost five times what was paid, to a PBM.
     */
    assert.equal(packQtyOf("(10) 100 EA"), null);
    assert.equal(packQtyOf("(5) 1 ML"), null);
    assert.equal(packQtyOf("30 EA"), 30);
    assert.equal(packQtyOf("2.5 ML"), 2.5);
    assert.equal(packQtyOf(null), null);
    assert.equal(packQtyOf("a box"), null);
  });
});


describe("a rebate belongs to the supplier that pays it", () => {
  const base = {
    catalogue: [
      { ndc11: "00093721698", supplier: "McKesson", description: "AMLODIPINE 5MG", unitCostMicros: 100_000, packQty: 90, contractFlag: "rebated", pricedOn: "2026-09-01", availability: null },
      { ndc11: "00093721698", supplier: "IPC", description: "AMLODIPINE 5MG", unitCostMicros: 95_000, packQty: 90, contractFlag: "rebated", pricedOn: "2026-09-01", availability: null },
    ],
    nadac: [],
    claims: [],
    materialityCents: 100,
  };

  test("one supplier's contract discount is never lent to another", () => {
    // The failure: a single global rate took McKesson's thirty percent off an IPC line the moment
    // IPC's catalogue marked something rebated, and the comparison then preferred IPC on a
    // discount it does not give.
    const rows = buildLedger({ ...base, invoiceLines: [], contract: { bySupplier: { mckesson: 0.3 }, genericRebateRate: null } });
    const buys = rows[0].buys;
    const mck = buys.find((b) => b.supplier === "McKesson")!;
    const ipc = buys.find((b) => b.supplier === "IPC")!;
    assert.equal(mck.effectiveUnitMicros, 70_000, "30% off the contract line");
    assert.equal(ipc.effectiveUnitMicros, 95_000, "IPC has no ladder on file, so nothing comes off");
  });

  test("a rebated line with no rate on file is flagged rather than priced gross in silence", () => {
    const rows = buildLedger({ ...base, invoiceLines: [], contract: { bySupplier: { mckesson: 0.3 }, genericRebateRate: null } });
    assert.ok(rows[0].flags.includes("rebate_unknown"), "IPC's rebated line has no rate, and that is said out loud");
  });

  test("with no ladders at all, everything is compared at its gross price", () => {
    const rows = buildLedger({ ...base, invoiceLines: [], contract: { genericRebateRate: null } });
    assert.deepEqual(
      rows[0].buys.map((b) => [b.supplier, b.effectiveUnitMicros]).sort(),
      [["IPC", 95_000], ["McKesson", 100_000]],
    );
  });
});

describe("what each drug actually earns", () => {
  const row = (over: Partial<import("../src/lib/product-ledger").LedgerRow> = {}) => ({
    ndc11: "00093721698",
    name: "AMLODIPINE 5MG",
    buys: [],
    paid: { supplier: "McKesson", unitCostMicros: 100_000, effectiveUnitMicros: 70_000, rebated: true, source: "invoice" as const, on: "2026-08-20", shortDated: null },
    best: null,
    nadacMicros: 90_000,
    nadacOn: "2026-09-01",
    unitsDispensed: 90,
    receivedCents: 1_500,
    claims: 1,
    vsNadacMicros: -20_000,
    switchSavingCents: null,
    flags: [] as import("../src/lib/product-ledger").Flag[],
    ...over,
  });

  test("cost is what the supplier really charges, after the rebate that supplier pays", () => {
    /*
     * The whole point. 90 units at 7 cents effective is $6.30, not the $9.00 the invoice printed —
     * and $15.00 came in. A margin worked out on gross prices understates every contract generic
     * by the tier rate, which here would turn $8.70 of margin into $6.00 and could get a
     * profitable drug dropped.
     */
    const [m] = margins([row()]);
    assert.equal(m.costCents, 630);
    assert.equal(m.marginCents, 870);
    assert.equal(m.marginPercent, 58);
  });

  test("a drug dispensed at a loss is separated out, worst first", () => {
    const rows = margins([
      row({ ndc11: "1", receivedCents: 1_500 }),
      row({ ndc11: "2", receivedCents: 400 }),
      row({ ndc11: "3", receivedCents: 100 }),
    ]);
    const bad = losers(rows);
    assert.deepEqual(bad.map((m) => m.ndc11), ["3", "2"]);
    assert.equal(bad[0].marginCents, -530);
  });

  test("nothing dispensed, or no price we actually paid, and no margin is claimed", () => {
    assert.deepEqual(margins([row({ unitsDispensed: 0, claims: 0 })]), []);
    assert.deepEqual(margins([row({ paid: null })]), []);
  });

  test("an unknown pack size means no margin rather than a wrong one", () => {
    // The same rule the comparison uses: a per-package price read as a per-unit one is out by the
    // pack size, and a margin built on it is confidently wrong rather than absent.
    assert.deepEqual(margins([row({ flags: ["pack_size_unknown"] })]), []);
  });

  test("per unit as well as in total, so a rare drug can be compared with a common one", () => {
    const [m] = margins([row()]);
    assert.equal(m.marginPerUnitMicros, Math.round((870 * 10_000) / 90));
  });
});

describe("a fill billed twice is still one dispensing", () => {
  test("units and revenue come from the fill, not from each transmission", () => {
    /*
     * The inconsistency this closes: the purchasing page summed claims while the claims page
     * grouped fills, so the same question had two answers depending on which screen it was asked
     * from — and the purchasing one said a drug was dispensed twice as often as it was, which
     * overstated every saving worked out on those quantities by the same factor.
     *
     * buildLedger is fed one row per dispensing. This asserts the shape that feeds it.
     */
    const rows = buildLedger({
      invoiceLines: [
        { ndc11: "81968004560", supplier: "McKesson", description: "OZEMPIC 1MG", unitCostCents: 57_676, rebated: false, invoiceDate: "2026-09-04" },
      ],
      catalogue: [
        { ndc11: "81968004560", supplier: "McKesson", description: "OZEMPIC 1MG", unitCostMicros: 57_676 * 10_000, packQty: 1, contractFlag: null, pricedOn: "2026-09-01", availability: null },
      ],
      nadac: [],
      // One fill: 30 units, $598 in — not two claims of 30 units each.
      claims: [{ ndc11: "81968004560", itemName: "OZEMPIC 1MG", quantityThousandths: 30_000, remitCents: 59_800, copayCents: 0, status: "paid" }],
      contract: { genericRebateRate: null },
      materialityCents: 100,
    });
    assert.equal(rows[0].unitsDispensed, 30);
    assert.equal(rows[0].claims, 1);
    assert.equal(rows[0].receivedCents, 59_800);
  });
});
