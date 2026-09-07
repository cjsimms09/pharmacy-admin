import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { parseDirectoryProducts, parseDirectoryPackages, parseOrangeBook, buildDirectory, equivalenceKey, substitutable, applicationParts, strengthNumbers } from "../src/lib/drug-directory";
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
