import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { parseDirectoryProducts, parseDirectoryPackages, parseOrangeBook, buildDirectory, equivalenceKey, substitutable, applicationParts, strengthNumbers, packageUnits } from "../src/lib/drug-directory";
import { readZip } from "../src/lib/zip-read";

const products = parseDirectoryProducts(fs.readFileSync("fixtures/fda-ndc-product.txt", "latin1"));
const packages = parseDirectoryPackages(fs.readFileSync("fixtures/fda-ndc-package.txt", "latin1"));
const ob = parseOrangeBook(fs.readFileSync("fixtures/orange-book-products.txt", "latin1"));
const rows = buildDirectory(products, packages, ob);
const by = (ndc: string) => rows.find((r) => r.ndc11 === ndc)!;

describe("the FDA directory and the Orange Book, read", () => {
  test("every package becomes one row keyed on the 11-digit NDC every other file uses", () => {
    assert.equal(products.length, 5);
    assert.equal(packages.length, 6);
    assert.equal(rows.length, 6);
    const teva = by("00093007301");
    assert.equal(teva.labeler, "Teva Pharmaceuticals USA, Inc.");
    assert.equal(teva.genericName, "Omeprazole");
    assert.equal(teva.strength, "20 mg/1");
    assert.equal(teva.form, "CAPSULE, DELAYED RELEASE");
    assert.equal(teva.application, "ANDA076342");
    assert.equal(teva.packageDescription, "100 CAPSULE, DELAYED RELEASE in 1 BOTTLE (0093-0073-01)");
  });

  test("the equivalence key is ingredient, strength, form and route — labeler and pack are not in it", () => {
    assert.equal(by("00093007301").equivalenceKey, "omeprazole|20 mg/1|capsule, delayed release|oral");
    assert.equal(by("00093007301").equivalenceKey, by("00781223401").equivalenceKey, "Teva's and Sandoz's 20 mg are one key");
    assert.equal(by("00093007301").equivalenceKey, by("00093007305").equivalenceKey, "a 100-count and a 500-count are one key");
    assert.notEqual(by("00093007301").equivalenceKey, by("00781223501").equivalenceKey, "20 mg and 40 mg are not");
    assert.notEqual(by("00093007301").equivalenceKey, by("00000999901").equivalenceKey, "a tablet is not a capsule");
    assert.equal(equivalenceKey({ substances: "ETHINYL ESTRADIOL; DROSPIRENONE", strength: ".02; 3", strengthUnit: "mg/1; mg/1", form: "TABLET", route: "ORAL" }), "drospirenone; ethinyl estradiol|0.02 mg/1; 3 mg/1|tablet|oral", "ingredients are sorted so order in the file does not split a key");
  });

  test("the TE code comes from the Orange Book product under the same application and strength", () => {
    assert.equal(by("00093007301").teCode, "AB");
    assert.equal(by("00781223401").teCode, "AB");
    assert.equal(by("00781223501").teCode, "AB", "the 40 mg matched its own product under a two-product application");
    assert.equal(by("00186074231").teCode, "AB", "the brand under its NDA");
    const unapproved = by("00000999901");
    assert.equal(unapproved.teCode, null);
    assert.match(unapproved.teWhy ?? "", /Not an approved application/);
  });

  test("substitutable means the same key and both A-rated, and never an unrated product", () => {
    assert.equal(substitutable(by("00093007301"), by("00781223401")), true, "Teva for Sandoz");
    assert.equal(substitutable(by("00093007301"), by("00186074231")), true, "generic for the brand: same key, both AB");
    assert.equal(substitutable(by("00093007301"), by("00781223501")), false, "not across strengths");
    assert.equal(substitutable(by("00000999901"), by("00093007301")), false, "an unapproved tablet, different form anyway");
    assert.equal(substitutable({ equivalenceKey: "x", teCode: null }, { equivalenceKey: "x", teCode: "AB" }), false, "same key, unrated: not called substitutable");
    assert.equal(substitutable({ equivalenceKey: "x", teCode: "BX" }, { equivalenceKey: "x", teCode: "AB" }), false, "a B-rating is not equivalence");
  });

  test("application numbers and strengths compare the way the two files write them", () => {
    assert.deepEqual(applicationParts("ANDA076342"), { type: "A", no: "076342" });
    assert.deepEqual(applicationParts("NDA019810"), { type: "N", no: "019810" });
    assert.deepEqual(applicationParts("BLA125057"), { type: "N", no: "125057" });
    assert.equal(applicationParts("UNAPPROVED DRUG OTHER"), null);
    assert.deepEqual(strengthNumbers("20"), [20], "the directory's numerator, which is what the join passes");
    assert.deepEqual(strengthNumbers("EQ 20MG BASE"), [20]);
    assert.deepEqual(strengthNumbers("3MG;0.02MG"), [3, 0.02]);
    assert.equal(ob[3].rld, true);
    assert.equal(ob[3].approvedOn, "1989-09-14");
  });
});

describe("the zip reader", () => {
  /** A two-entry archive built by hand: one stored, one deflated. */
  function zip(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const body = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
      const name = Buffer.from(e.name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(e.deflate ? 8 : 0, 8);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(e.data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(e.deflate ? 8 : 0, 10);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(e.data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, name, body);
      centrals.push(central, name);
      offset += local.length + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }

  test("reads stored and deflated entries back out", () => {
    const text = "PRODUCTID\tPRODUCTNDC\n0093-0073_1a2b\t0093-0073\n".repeat(50);
    const archive = zip([
      { name: "product.txt", data: Buffer.from(text, "latin1"), deflate: true },
      { name: "package.txt", data: Buffer.from("small", "latin1"), deflate: false },
    ]);
    const entries = readZip(archive);
    assert.deepEqual(entries.map((e) => e.name), ["product.txt", "package.txt"]);
    assert.equal(entries[0].data.toString("latin1"), text);
    assert.equal(entries[1].data.toString("latin1"), "small");
  });

  test("refuses what is not a zip rather than returning nothing", () => {
    assert.throws(() => readZip(Buffer.from("PK is not enough")), /Not a zip archive/);
  });
});

describe("the A-rating subgroup", () => {
  /*
   * AB1 and AB2 exist because the FDA could not say the products under one code are all
   * interchangeable. Substituting across that line is the mistake this module exists to prevent,
   * and doing it while showing an FDA rating as the reason would be worse than having no rating.
   */
  const k = "amlodipine besylate|2.5mg|tablet|oral";
  const c = (teCode: string | null) => ({ equivalenceKey: k, teCode });

  test("the same subgroup is substitutable", () => {
    assert.equal(substitutable(c("AB1"), c("AB1")), true);
    assert.equal(substitutable(c("AB"), c("AB")), true);
    assert.equal(substitutable(c("AP"), c("AP")), true);
  });

  test("a different subgroup is not, however alike the codes look", () => {
    assert.equal(substitutable(c("AB1"), c("AB2")), false);
    assert.equal(substitutable(c("AB2"), c("AB3")), false);
  });

  test("a bare AB is its own group, not a wildcard over the numbered ones", () => {
    assert.equal(substitutable(c("AB"), c("AB1")), false);
    assert.equal(substitutable(c("AB1"), c("AB")), false);
  });

  test("different ratings of the same letter are still different ratings", () => {
    assert.equal(substitutable(c("AB"), c("AP")), false);
  });

  test("unrated is never substitutable, and neither is a B rating", () => {
    assert.equal(substitutable(c(null), c(null)), false);
    assert.equal(substitutable(c("BX"), c("BX")), false);
    assert.equal(substitutable(c("AB"), c("BX")), false);
  });

  test("a different drug is never substitutable whatever the rating", () => {
    assert.equal(substitutable({ equivalenceKey: "a", teCode: "AB1" }, { equivalenceKey: "b", teCode: "AB1" }), false);
  });
});

describe("what a package holds, from the FDA rather than from a wholesaler", () => {
  /*
   * Every string below is verbatim from the pharmacy's own failed load, so the reader is tested
   * against the file as it really arrives rather than against a tidied version of it.
   */
  test("a plain bottle is its own count", () => {
    assert.deepEqual(packageUnits("30 TABLET, COATED in 1 BOTTLE, PLASTIC (71921-105-33)"), { units: 30, uom: "EA" });
    assert.deepEqual(packageUnits("900 PELLET in 1 VIAL, GLASS (71919-811-05)"), { units: 900, uom: "EA" });
    assert.deepEqual(packageUnits("1000 TABLET in 1 BOTTLE (71930-006-13)"), { units: 1000, uom: "EA" });
  });

  test("a nest multiplies out, which is the whole answer to the argument", () => {
    // The levels are joined by "/", not ">". A carton of 144 pouches of 0.9 g is 129.6 g.
    assert.deepEqual(
      packageUnits("144 POUCH in 1 BOX (71927-015-03) / .9 g in 1 POUCH (71927-015-01)"),
      { units: 129.6, uom: "GM" },
    );
    // A box of six spray containers is six dispensing units.
    assert.deepEqual(packageUnits("6 CONTAINER in 1 BOX (71921-170-61) / 1 SPRAY in 1 CONTAINER"), { units: 6, uom: "EA" });
    // One dropper bottle in a carton is 5 mL, not 1.
    assert.deepEqual(
      packageUnits("1 BOTTLE, DROPPER in 1 CARTON (71921-188-05) / 5 mL in 1 BOTTLE, DROPPER"),
      { units: 5, uom: "ML" },
    );
    assert.deepEqual(packageUnits("1 BOTTLE in 1 CARTON (71921-410-72) / 300 mL in 1 BOTTLE"), { units: 300, uom: "ML" });
  });

  test("a volume is a volume and a count is a count", () => {
    assert.deepEqual(packageUnits("236.5 mL in 1 BOTTLE (71921-175-08)"), { units: 236.5, uom: "ML" });
    assert.deepEqual(packageUnits("3.78 L in 1 BOTTLE, PLASTIC (71925-301-41)"), { units: 3780, uom: "ML" });
    assert.deepEqual(packageUnits("30 g in 1 JAR (71922-100-30)"), { units: 30, uom: "GM" });
    // Milligrams are converted rather than refused; a package stated in mg is still a package.
    assert.deepEqual(packageUnits("5 mg in 1 BOTTLE, PLASTIC (71921-185-05)"), { units: 0.005, uom: "GM" });
  });

  test("a kit is refused rather than guessed at", () => {
    // Fifty different remedies in one box have no single dispensing unit, and inventing one would
    // put a wrong number exactly where this is meant to be the party nobody argues with.
    assert.equal(
      packageUnits("50 VIAL, GLASS in 1 KIT (71919-821-18) / 1 KIT in 1 VIAL, GLASS (71919-821-01) * 750 PELLET in 1 VIAL, GLASS (68428-127-01)"),
      null,
    );
    assert.equal(
      packageUnits("1 KIT in 1 CARTON (71921-307-51) * 11 TABLET, FILM COATED in 1 BLISTER PACK * 42 TABLET, FILM COATED in 1 BLISTER PACK"),
      null,
    );
  });

  test("anything that is not this shape gives nothing rather than a guess", () => {
    for (const s of ["", "   ", "a bottle", "TABLET in 1 BOTTLE", "0 TABLET in 1 BOTTLE"]) assert.equal(packageUnits(s), null);
  });

  test("the same package NDC listed twice is one row, not a failed load", () => {
    // The real file lists 72043-2500-1 twice, identically, which refused all 250,000 rows.
    const products = [{
      productNdc: "72043-2500", productType: "HUMAN OTC DRUG", brandName: "EltaMD UV Clear SPF46", genericName: "Zinc oxide",
      form: "LOTION", route: "TOPICAL", substances: "ZINC OXIDE", strength: "90", strengthUnit: "g/1000g",
      labeler: "CP Skin Health Group, Inc.", application: "M020", marketingCategory: "OTC MONOGRAPH DRUG",
      deaSchedule: null, marketedFrom: null, marketedTo: null, excluded: false,
    }];
    const pkg = { ndc11: "72043250001", productNdc: "72043-2500", packageDescription: "48 g in 1 BOTTLE (72043-2500-1)", marketedFrom: null, marketedTo: null, sample: false };
    const rows = buildDirectory(products, [pkg, { ...pkg }], []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ndc11, "72043250001");
  });
});
