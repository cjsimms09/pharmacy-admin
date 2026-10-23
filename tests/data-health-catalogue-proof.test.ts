import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCatalogueProof, catalogueProofFraction, catalogueProofGaps, catalogueProofNote } from "../src/lib/data-health-catalogue-proof";

/*
 * The catalogue, proved against the wholesaler's own file.
 *
 * The figures below are the real 8 September run: ANDA 7,953 listings over 7,947 NDCs with 5 listed
 * twice; IPC 2,504 over 2,485 with 19 twice; McKesson 44,802 over 44,251 with 539 twice; ParMed 2;
 * IPD nothing. The first version of this proof called 239 of those duplicate listings wrong prices.
 * None of them were, which is why every count here is per NDC.
 */
const proof = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    provedOn: "2026-09-09",
    suppliers: [
      { supplier: "McKesson", supplierId: "s1", fileName: "MCKCatalog9_8_2026.txt", importedAt: "2026-09-08T05:02:00.000Z", printedOn: "2026-09-08", documentFound: true, rowsInFile: 44_802, ndcsInFile: 44_251, listedTwice: 539, itemsInTable: 44_251, proved: 44_251, matchedOtherListing: 0, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 1, tableUnitMicros: 1, problems: [] },
      { supplier: "IPC", supplierId: "s2", fileName: "IPC9_8_2026.txt", importedAt: "2026-09-08T05:04:00.000Z", printedOn: "2026-09-08", documentFound: true, rowsInFile: 2_504, ndcsInFile: 2_485, listedTwice: 19, itemsInTable: 2_485, proved: 2_485, matchedOtherListing: 0, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 1, tableUnitMicros: 1, problems: [] },
      { supplier: "IPD", supplierId: "s3", fileName: null, importedAt: null, printedOn: null, documentFound: false, rowsInFile: 0, ndcsInFile: 0, listedTwice: 0, itemsInTable: 0, proved: 0, matchedOtherListing: 0, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 0, tableUnitMicros: 0, problems: ["no catalogue has ever been imported for this wholesaler"] },
    ],
    rowsInFiles: 47_306,
    ndcsInFiles: 46_736,
    listedTwice: 558,
    proved: 46_736,
    matchedOtherListing: 0,
    priceDiffers: 0,
    missing: 0,
    carriedOver: 0,
    suppliersWithNoFile: ["IPD"],
    lines: [],
    ...over,
  });

describe("the catalogue proof row", () => {
  test("the fraction is per NDC, never per listing", () => {
    const p = parseCatalogueProof(proof())!;
    assert.deepEqual(catalogueProofFraction(p), { numerator: 46_736, denominator: 46_736 });
    // 47,306 listings over 46,736 NDCs: a fraction on listings counts 558 products twice.
    assert.notEqual(catalogueProofFraction(p).denominator, p.rowsInFiles);
  });

  test("a price no listing in the file states costs the percentage and names the wholesaler", () => {
    const p = parseCatalogueProof(
      proof({
        suppliers: [{ supplier: "McKesson", supplierId: "s1", fileName: "MCKCatalog9_8_2026.txt", importedAt: null, printedOn: "2026-09-08", documentFound: true, rowsInFile: 44_802, ndcsInFile: 44_251, listedTwice: 539, itemsInTable: 44_251, proved: 44_244, matchedOtherListing: 0, priceDiffers: 7, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 1, tableUnitMicros: 1, problems: [] }],
        ndcsInFiles: 44_251,
        proved: 44_244,
        priceDiffers: 7,
      }),
    )!;
    const f = catalogueProofFraction(p);
    assert.ok(f.numerator < f.denominator);
    assert.match(catalogueProofGaps(p)[0], /McKesson: 7 prices in the table that no listing in MCKCatalog9_8_2026\.txt states/);
    assert.match(catalogueProofGaps(p)[0], /Every buying decision on those NDCs is made on the table's figure/);
  });

  test("a price held on a different listing of the same NDC counts as agreement, not as a fault", () => {
    /*
     * The table holds a price the file does state, just not the listing the import rule would pick
     * today. That is the file or the rule having changed, and calling it a wrong price is exactly
     * the false alarm that made the first run report 239 of them.
     */
    const p = parseCatalogueProof(proof({ proved: 46_730, matchedOtherListing: 6, suppliers: [{ supplier: "IPC", supplierId: "s2", fileName: "IPC9_8_2026.txt", importedAt: null, printedOn: "2026-09-08", documentFound: true, rowsInFile: 2_504, ndcsInFile: 2_485, listedTwice: 19, itemsInTable: 2_485, proved: 2_479, matchedOtherListing: 6, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 1, tableUnitMicros: 1, problems: [] }], ndcsInFiles: 2_485 }))!;
    assert.deepEqual(catalogueProofFraction(p), { numerator: 2_485, denominator: 2_485 }, "agreement, so the row is complete");
    assert.match(catalogueProofGaps(p).join(" "), /a different listing from the one the import rule would pick today/);
    assert.match(catalogueProofGaps(p).join(" "), /Not a wrong price/);
  });

  test("carried-over prices are outside the fraction and reported with their age", () => {
    /*
     * A catalogue import replaces only the NDCs the arriving file carries. Counting a product the
     * wholesaler stopped listing against the score would make a trimmed catalogue look like wrong
     * prices — and the real risk is that the price is old, which the fraction cannot express.
     */
    const p = parseCatalogueProof(
      proof({
        suppliers: [{ supplier: "ANDA", supplierId: "s4", fileName: "ANDA9_8_2026.txt", importedAt: null, printedOn: "2026-09-08", documentFound: true, rowsInFile: 7_953, ndcsInFile: 7_947, listedTwice: 5, itemsInTable: 9_100, proved: 7_947, matchedOtherListing: 0, priceDiffers: 0, missing: 0, carriedOver: 1_153, carriedOverOldestPricedOn: "2026-07-14", fileUnitMicros: 1, tableUnitMicros: 1, problems: [] }],
        ndcsInFiles: 7_947,
        proved: 7_947,
        carriedOver: 1_153,
      }),
    )!;
    assert.deepEqual(catalogueProofFraction(p), { numerator: 7_947, denominator: 7_947 }, "the newest file is fully agreed with");
    assert.match(catalogueProofGaps(p).join(" "), /1,153 prices are held that ANDA9_8_2026\.txt does not carry, the oldest priced 2026-07-14/);
    assert.match(catalogueProofNote(p), /outside this figure: the newest file says nothing about them/);
  });

  test("a wholesaler with no catalogue is named, not silently left out of the sum", () => {
    // Four silent wholesalers behind one good one is the reassuring-row fault; the gap says so and
    // points at the row whose denominator can actually see it.
    const gaps = catalogueProofGaps(parseCatalogueProof(proof())!);
    assert.match(gaps.join(" "), /No catalogue has ever been imported for IPD/);
    assert.match(gaps.join(" "), /"Catalogue files arriving" row/);
  });

  test("the note counts NDCs and listings apart, and says how many are listed twice", () => {
    const note = catalogueProofNote(parseCatalogueProof(proof())!);
    assert.match(note, /46,736 NDCs across 47,306 listings/);
    assert.match(note, /558 of them listed more than once in their own file/);
    assert.match(note, /oldest of those files was priced 2026-09-08/);
  });

  test("never run is null, and a run with no file to prove against says so", () => {
    assert.equal(parseCatalogueProof(undefined), null);
    assert.equal(parseCatalogueProof("[]"), null);
    assert.match(catalogueProofNote(parseCatalogueProof(proof({ suppliers: [], ndcsInFiles: 0 }))!), /found no wholesaler with a catalogue file/);
  });

  test("a stored file that has gone missing is a problem on its supplier, and is named", () => {
    const p = parseCatalogueProof(
      proof({
        suppliers: [{ supplier: "ParMed", supplierId: "s5", fileName: "ParMed9_1_2026.txt", importedAt: null, printedOn: null, documentFound: false, rowsInFile: 0, ndcsInFile: 0, listedTwice: 0, itemsInTable: 2, proved: 0, matchedOtherListing: 0, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 0, tableUnitMicros: 0, problems: ["the file ParMed9_1_2026.txt is no longer stored, so the table cannot be set against it"] }],
        ndcsInFiles: 0,
        proved: 0,
      }),
    )!;
    assert.match(catalogueProofGaps(p).join(" "), /ParMed: the file ParMed9_1_2026\.txt is no longer stored/);
  });
});
