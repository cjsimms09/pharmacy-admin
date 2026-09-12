import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceLines, splitQuantities, ndc11, scheduleFromDea, ndcFromRun, sameDrugCode } from "../src/lib/invoice-lines";
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

/**
 * How many digits the NDC column printed, on a layout that runs it into the item number.
 *
 * IPD's invoice 1008931 prints, on its Non-CII half:
 *
 *   91654707560094 1 0EACH 3.99  0 % 3.99
 *
 * The item number is 91654 and the NDC column holds **nine** digits — 70756-0094, the propranolol,
 * with no package code. The report clipped it, the same way it printed "PROPRANOLO" for propranolol
 * and "BUME" for bumetanide on the lines either side. Taking the last eleven digits took two off
 * the end of the item number and produced 54707560094: not a drug, not any code, $3.99 of purchases
 * against nothing, and the item number stored as "916" rather than the 91654 you would reorder by.
 *
 * PioneerRx booked the same line in as 70756-0094-11 off the bottle, which is how the difference
 * was found at all.
 */
describe("the NDC column's own length, on IPD and ParMed runs", () => {
  /* The FDA lists two packages of 70756-094: the hundred-count and the thousand-count. */
  const propranolol = ["70756009411", "70756009412"];
  const known = (n: string) => propranolol.includes(n) || n === "70756008151";
  const packagesOf = (nine: string) => (nine === "707560094" ? propranolol : nine === "707560081" ? ["70756008151"] : []);

  test("eleven digits that are a drug are the answer, and the item number is what is left", () => {
    /* The bumetanide on the same invoice: 90977 then all eleven digits of 70756-0081-51. */
    const r = ndcFromRun("9097770756008151", known, packagesOf);
    assert.deepEqual(r, { code: "70756008151", printed: 11 });
  });

  test("a nine-digit column is read as nine rather than stealing two digits of the item number", () => {
    const r = ndcFromRun("91654707560094", known, packagesOf);
    assert.equal(r.printed, 9);
    assert.equal(r.code, "707560094", "the product IPD printed, not 54707560094 which is nobody's code");
  });

  test("the pack code is never invented, because every cost per tablet divides by it", () => {
    /* 70756-094 comes in 100s and in 1000s. The invoice does not say which, so neither does this. */
    assert.equal(ndcFromRun("91654707560094", known, packagesOf).code.length, 9);
  });

  test("one package listed under the product settles the line to all eleven digits", () => {
    /* Same shape, but the FDA lists only the one pack, so nothing is left open. */
    const r = ndcFromRun("91654707560081", known, packagesOf);
    assert.deepEqual(r, { code: "70756008151", printed: 9 });
  });

  test("a package code the directory has not caught up with is still the maker's own code", () => {
    /* Eleven digits whose labeller and product the FDA lists are trusted as printed. */
    const r = ndcFromRun("1234570756009499", known, (nine) => (nine === "707560094" ? propranolol : []));
    assert.deepEqual(r, { code: "70756009499", printed: 11 });
  });

  test("with no directory to ask, the last eleven digits stand, exactly as before", () => {
    assert.deepEqual(ndcFromRun("91654707560094"), { code: "54707560094", printed: 11 });
  });

  test("a device line with no NDC to find keeps the digits it had", () => {
    /* ParMed's Accu-Chek Softclix, off invoice 7491384103. There is no NDC for it anywhere. */
    const r = ndcFromRun("102399715075537009710", () => false, () => []);
    assert.deepEqual(r, { code: "75537009710", printed: 11 });
  });

  test("read off the whole IPD line, the item number and the NDC both come out right", () => {
    const line = ["Non-CII", "91654707560094 1 0EACH 3.99  0 % 3.99", "PROPRANOLO", "Non-CII Subtotal:$3.99 "].join("\n");
    const p = parseInvoiceLines(line, 399, known, packagesOf);
    assert.equal(p.lines.length, 1);
    assert.equal(p.lines[0].ndc11, "707560094");
    assert.equal(p.lines[0].itemNumber, "91654", "IPD's own catalogue number, which was coming out as 916");
    assert.equal(p.lines[0].extendedCents, 399);
  });
});

/**
 * Two codes for one item, which is not two items.
 *
 * The invoice and the delivery are filled in by different people from different documents, and that
 * independence is the whole value of comparing them — worthless if a difference in how a code was
 * *written* reads as a difference in what was *bought*. Every pair below is off the pharmacy's own
 * invoices of 8-9 September, where ten such lines were being reported as "the invoice and the
 * delivery disagree" and not one of them was a wrong drug against the money.
 */
describe("the same item, written two ways", () => {
  test("the same ten digits padded in different places", () => {
    /* Aspercreme, McKesson 7656840418: UPC 041167-05877 carries 4116705877. The FDA lists it as
       41167-0587-07; the counter booked 41167-0058-77. One tube of cream, $5.84, both sides. */
    assert.ok(sameDrugCode("41167058707", "41167005877"));
    /* Ricola, the same invoice: 036602-07917 against 36602-0079-17. */
    assert.ok(sameDrugCode("03660207917", "36602007917"));
  });

  test("a UPC with its prefix still on, against the NDC it stands for", () => {
    /* Florastor and the Pulmoneb nebuliser, McKesson 7657098065. The FDA lists neither, so
       ndcFromUpc keeps the digits it was handed — prefix and all. */
    assert.ok(sameDrugCode("70414200024", "04142000024"));
    assert.ok(sameDrugCode("88530400178", "85304000178"));
  });

  test("a product whose package code the invoice did not print", () => {
    /* IPD 1008931's propranolol: nine digits billed, eleven booked in. */
    assert.ok(sameDrugCode("707560094", "70756009411"));
    assert.ok(sameDrugCode("70756009411", "707560094"));
  });

  test("two packs of one drug are not the same item, because a cost per tablet divides by the pack", () => {
    /* The hundred-count and the thousand-count of the same propranolol. */
    assert.equal(sameDrugCode("70756009411", "70756009412"), false);
  });

  test("a retail barcode against an NDC is not the same code, and no arithmetic joins them", () => {
    /* McKesson bills AZO Standard as 787651-30152; the counter booked 00998-0015-30. Benadryl as
       312547-17031 against 50580-0226-24. Integra as 850976-00608 against 52747-0710-30. */
    assert.equal(sameDrugCode("78765130152", "00998001530"), false);
    assert.equal(sameDrugCode("31254717031", "50580022624"), false);
    assert.equal(sameDrugCode("85097600608", "52747071030"), false);
  });

  test("one digit apart is one digit apart", () => {
    /* Cepacol: the invoice's 363824-71016 carries 6382471016 and the counter's 63824-0715-16
       reduces to 6382471516. The labeller happens to match; the item does not. */
    assert.equal(sameDrugCode("36382471016", "63824071516"), false);
  });

  test("a missing code is never the same as anything", () => {
    assert.equal(sameDrugCode(null, "70756009411"), false);
    assert.equal(sameDrugCode("70756009411", ""), false);
    assert.equal(sameDrugCode(null, null), false);
  });
});

/**
 * Which drawer an invoice goes in, decided from what the pharmacy actually booked in.
 *
 * 21 CFR 1304.04(h)(1) keeps the Schedule II records apart, so one CII line decides the whole
 * document. The rule that matters most here is the last one: nothing is a guess. A schedule nobody
 * recorded is unknown, and filing an unknown as an ordinary business record is the single mistake
 * that breaks the separation.
 */
describe("the schedule, from what PioneerRx booked in", () => {
  test("any Schedule II line makes the whole invoice a Schedule II record", () => {
    assert.equal(scheduleFromDea(["0", "0", "2"]), "schedule_2");
    assert.equal(scheduleFromDea(["2"]), "schedule_2");
    /* A CII alongside a CIV is still a CII record; the strictest drawer wins. */
    assert.equal(scheduleFromDea(["4", "2", "0"]), "schedule_2");
  });

  test("anything else controlled makes it a III-V record", () => {
    assert.equal(scheduleFromDea(["0", "4"]), "schedule_3_5");
    assert.equal(scheduleFromDea(["3"]), "schedule_3_5");
    assert.equal(scheduleFromDea(["5", "0", "0"]), "schedule_3_5");
  });

  test("only a delivery that is wholly non-controlled is an ordinary record", () => {
    assert.equal(scheduleFromDea(["0"]), "none");
    assert.equal(scheduleFromDea(["0", "0", "0"]), "none");
  });

  test("nothing recorded is unknown, never none", () => {
    /* A delivery whose schedules were never recorded has not been shown to be free of controls. */
    assert.equal(scheduleFromDea([]), "unknown");
    assert.equal(scheduleFromDea([null, undefined, ""]), "unknown");
  });

  test("a code this does not recognise is unknown, never none", () => {
    /* Treating an unrecognised code as a nought would file an unknown schedule as an ordinary one. */
    assert.equal(scheduleFromDea(["0", "X"]), "unknown");
    assert.equal(scheduleFromDea(["9"]), "unknown");
  });

  test("the lettered forms are read too, in case a source writes them", () => {
    assert.equal(scheduleFromDea(["CII"]), "schedule_2");
    assert.equal(scheduleFromDea(["cIV", "0"]), "schedule_3_5");
    assert.equal(scheduleFromDea(["2N"]), "schedule_2");
  });
});

/**
 * The FDA's own schedule codes, which are now a source for the drawer.
 *
 * The owner: "parmed doesnt send controls" — said about a ParMed invoice sitting in the Schedule II
 * drawer whose only line was NovoLog insulin. It was filed there because its schedule was
 * "unknown", and it was unknown because the reader could not read the row and PioneerRx had never
 * booked the delivery in.
 *
 * `scheduleFromInvoiceLines` in invoices.ts now settles that case from the NDCs on the invoice
 * against `drug_directory.dea_schedule`, and hands the codes to this function rather than deciding
 * anything itself. So what it hands over has to be understood: the FDA writes "CII" where PioneerRx
 * writes "2", and it leaves the column blank for a drug that is not controlled.
 */
describe("DEA schedules as the FDA writes them", () => {
  test("the FDA's lettered codes decide the same drawer as PioneerRx's numbers", () => {
    assert.equal(scheduleFromDea(["CII"]), "schedule_2");
    assert.equal(scheduleFromDea(["cii"]), "schedule_2");
    assert.equal(scheduleFromDea(["CIII"]), "schedule_3_5");
    assert.equal(scheduleFromDea(["CIV"]), "schedule_3_5");
    assert.equal(scheduleFromDea(["CV"]), "schedule_3_5");
  });

  test("one Schedule II line makes the whole invoice a Schedule II record", () => {
    // 21 CFR 1304.04(h)(1). A folder is not a separation if a CII invoice sits in the ordinary one.
    assert.equal(scheduleFromDea(["0", "CIV", "CII", "0"]), "schedule_2");
  });

  test("a blank must be spelled out as 0, or an uncontrolled invoice reads as unknown", () => {
    /*
     * The trap `scheduleFromInvoiceLines` has to avoid. The directory leaves the column blank for a
     * drug that is not controlled, and filtering those out leaves an empty list — which this reads
     * as "unknown", which files with the Schedule IIs. An invoice of nothing but insulin would go
     * straight back into the drawer it was just taken out of.
     */
    assert.equal(scheduleFromDea([]), "unknown");
    assert.equal(scheduleFromDea([null, undefined, ""]), "unknown");
    assert.equal(scheduleFromDea(["0", "0"]), "none");
  });

  test("and a code nobody recognises is still not evidence of nothing", () => {
    assert.equal(scheduleFromDea(["N/A"]), "unknown");
    assert.equal(scheduleFromDea(["0", "SOMETHING"]), "unknown");
  });
});
