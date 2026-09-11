import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceLines, splitQuantities, ndc11 } from "../src/lib/invoice-lines";
import { readFileSync } from "node:fs";

/**
 * Reading a wholesaler's invoice as figures rather than as text.
 *
 * Every line here is copied from a real invoice this pharmacy received. Both formats run fields
 * together with no separator, so the only defence against a plausible-looking wrong number is the
 * line's own arithmetic: shipped quantity times unit price is the extended amount.
 */
const MCK = [
  "00002-1436-11257-9894973485930            1EA EMGALITY INJ PEN 120MG/ML 1      916.73 R      739.11       739.11",
  "24208-0463-25211-3991973485930            1EA LATANOPROST OPH.005% B&L2.5ML@       24.38 R        2.32 K        2.32",
  "00169-6339-10137-9593973485930            2CT NOVOLOG F/PEN PREF SYR 3ML   5      167.65 R      131.02       262.04",
  "23155-0689-41265-6098973485930            1*CT OCTREOTIDE SDV500MCG/MLAVET10@      234.00 R      233.99 K      233.99",
  "45802-0281-39398-2303973485932            1EA TESTOS GEL 1.62%PERR1.25G  30@      403.16 D       83.20 K       83.20 3.0",
].join("\n");

const IPC = [
  "5128541Amoxicillin/Clav Pot Tabs 500/125mg Auro 65862050220$8.80$75.6911$2.91$2.91",
  "5309497Estradiol Vaginal 10mcg Inserts Auro 1859651043918$349.17$436.4611$53.00$53.00",
].join("\n");

describe("a McKesson invoice", () => {
  const r = parseInvoiceLines(MCK);

  test("every line is read, and none is guessed at", () => {
    assert.equal(r.format, "mckesson");
    assert.equal(r.lines.length, 5);
    assert.deepEqual(r.unreadable, []);
  });

  test("the NDC, quantity, unit price and extended amount come off correctly", () => {
    const l = r.lines[0];
    assert.equal(l.ndc11, "00002143611");
    assert.equal(l.description, "EMGALITY INJ PEN 120MG/ML 1");
    assert.equal(l.quantity, 1);
    assert.equal(l.unitCostCents, 73_911);
    assert.equal(l.extendedCents, 73_911);
    assert.equal(l.awpCents, 91_673);
    assert.equal(l.itemClass, "R");
  });

  test("a quantity greater than one multiplies out", () => {
    const novolog = r.lines.find((l) => l.ndc11 === "00169633910")!;
    assert.equal(novolog.quantity, 2);
    assert.equal(novolog.unitCostCents, 13_102);
    assert.equal(novolog.extendedCents, 26_204);
  });

  test("the K marks the line as earning the contract rebate, and its absence marks the opposite", () => {
    // The single fact that decides whether a gross price gets the tier rate taken off it.
    assert.equal(r.lines.find((l) => l.ndc11 === "24208046325")!.rebated, true);
    assert.equal(r.lines.find((l) => l.ndc11 === "00002143611")!.rebated, false);
  });

  test("a line carrying an extra figure after the extended amount is still read", () => {
    // Eighty-three dollars went missing from an invoice that otherwise reconciled, because the
    // pattern was anchored hard to the end of the line.
    const gel = r.lines.find((l) => l.ndc11 === "45802028139");
    assert.ok(gel, "the testosterone gel line must not be dropped for its trailing figure");
    assert.equal(gel!.extendedCents, 8_320);
  });

  test("an asterisk before the unit of measure does not break the line", () => {
    assert.equal(r.lines.find((l) => l.ndc11 === "23155068941")!.unitCostCents, 23_399);
  });

  test("a line whose arithmetic does not balance is refused rather than read wrongly", () => {
    // The extended amount changed to something that is not quantity times unit price. A parser
    // that shrugged would put a wrong cost against a drug and nothing would say so.
    const bent = MCK.split("\n")[2].replace("       262.04", "       999.99");
    const bad = parseInvoiceLines(bent);
    assert.equal(bad.lines.length, 0);
    assert.equal(bad.unreadable.length, 1);
  });
});

describe("an IPD invoice", () => {
  const r = parseInvoiceLines(IPC);

  test("the NDC run onto the end of the description is separated out", () => {
    assert.equal(r.lines[0].ndc11, "65862050220");
    assert.equal(r.lines[0].unitCostCents, 291);
    assert.equal(r.lines[1].ndc11, "59651043918");
    assert.equal(r.lines[1].unitCostCents, 5_300);
  });

  test("this invoice prints no contract marking, so nothing is claimed either way", () => {
    // Saying "not rebated" here would strip a discount off the price in every later comparison.
    assert.ok(r.lines.every((l) => l.rebated === null));
  });

  test("the order and ship quantities, printed with no separator, are split by the arithmetic", () => {
    assert.deepEqual(splitQuantities("11", 291, 291), { ordered: 1, shipped: 1 });
    assert.deepEqual(splitQuantities("122", 100, 2200), { ordered: 1, shipped: 22 });
    assert.equal(splitQuantities("11", 291, 999), null, "a split that does not balance is no split");
  });
});

describe("adding up to the invoice", () => {
  test("lines that match the printed total reconcile", () => {
    const r = parseInvoiceLines(MCK, 73_911 + 232 + 26_204 + 23_399 + 8_320);
    assert.equal(r.reconciles, true);
  });

  test("a line silently dropped shows as a failure to reconcile, not as a clean read", () => {
    // The dangerous outcome: four plausible lines, no errors, and the pharmacy short on a drug.
    const r = parseInvoiceLines(MCK, 73_911 + 232 + 26_204 + 23_399 + 8_320 + 5_000);
    assert.equal(r.reconciles, false);
  });

  test("with no printed total to check against, it says so rather than claiming success", () => {
    assert.equal(parseInvoiceLines(MCK).reconciles, null);
  });
});

describe("NDCs", () => {
  test("hyphenated and plain forms both land on the eleven-digit billing form", () => {
    assert.equal(ndc11("00002-1436-11"), "00002143611");
    assert.equal(ndc11("0002-1436-11"), "00002143611");
    assert.equal(ndc11("65862050220"), "65862050220");
    assert.equal(ndc11("not an ndc"), null);
  });
});

describe("the two supplier layouts, on real files with the identifiers changed", () => {
  test("IPC reads in full and adds up to the printed total", () => {
    const text = readFileSync(new URL("../fixtures/invoice-ipc.txt", import.meta.url), "utf8");
    const r = parseInvoiceLines(text, 29023);
    assert.equal(r.format, "ipc");
    assert.equal(r.lines.length, 21);
    assert.equal(r.unreadable.length, 0);
    assert.equal(r.reconciles, true, "every line read, and the sum is the invoice total");
  });

  test("IPD reads nothing, and that is the correct answer", () => {
    /*
     * Not a gap to be papered over with a looser pattern.
     *
     * This layout's columns do not survive text extraction: every NDC on a page comes out as one
     * unbroken run of digits, every quantity in another. Which figure belongs to which product was
     * in the geometry of the page. A regular expression that returned something from this would be
     * returning a guess, and a guessed cost against a drug is acted on. The site reads this layout
     * by sending the document itself to the model, and still requires the arithmetic to hold.
     */
    const text = readFileSync(new URL("../fixtures/invoice-ipd.txt", import.meta.url), "utf8");
    const r = parseInvoiceLines(text, null);
    assert.equal(r.lines.length, 0);
    assert.equal(r.format, null);
  });
});

/**
 * McKesson's front-end lines carry a UPC, not an NDC.
 *
 * These five rows are copied from the $12,998.31 invoice of 8 September. Each was read as eleven
 * digits that are not any drug — "305361-32710" taken as the NDC 30536-1327-10, which does not
 * exist — and the purchase sat against nothing. A drug UPC is a prefix digit and then the NDC in
 * its ten-digit form, and the ten-digit form has to be padded back in one of three places.
 *
 * PioneerRx booked in four of these independently, off the bottle rather than off the page, and
 * agrees with every answer here.
 */
describe("a front-end UPC is not an NDC", () => {
  const UPC_LINES = [
    "305361-32710137-9593973485930            1EA ACETAM TAB 325MG RUG 1000@       21.80 R       21.80        21.80",
    "316714-79902137-9593973485930            1EA CETIRIZINE HCI TB10MG 100NSTR@        6.99 R        6.99         6.99",
    "041167-05877137-9593973485930            1EA ASPERCREME LIDCNE CREME 2.7OZ         5.84 R        5.84         5.84",
  ].join("\n");

  /* What the FDA directory actually holds for these three, and nothing else. */
  const known = (n: string) => ["00536132710", "16714079902", "41167058707"].includes(n);

  test("resolves each UPC to the drug the FDA lists", () => {
    const got = parseInvoiceLines(UPC_LINES, null, known).lines.map((l) => l.ndc11);
    assert.deepEqual(got, ["00536132710", "16714079902", "41167058707"]);
  });

  test("with no directory to ask, the digits stand rather than a guess replacing them", () => {
    const got = parseInvoiceLines(UPC_LINES, null).lines.map((l) => l.ndc11);
    assert.deepEqual(got, ["30536132710", "31671479902", "04116705877"]);
  });

  test("a code that is already a drug is left alone", () => {
    /* 5-4-2 is an NDC and is read as one; only the 6-5 form is a UPC. */
    assert.equal(ndc11("00002-1436-11"), "00002143611");
  });

  test("a device UPC resolves to nothing and keeps its digits", () => {
    /* Pen needles and sensors have no NDC at all. Guessing one would be worse than none. */
    const line = "094030-00211137-9593973485930            1EA EMBRACE PEN NEEDLE 31G 5MM 100        8.50 R        8.50         8.50";
    const got = parseInvoiceLines(line, null, () => false).lines.map((l) => l.ndc11);
    assert.deepEqual(got, ["09403000211"]);
  });
});
