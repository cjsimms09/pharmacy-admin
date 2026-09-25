import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { invoicesFiledTwice } from "../src/lib/books-check";

/**
 * A wholesaler issues one number once.
 *
 * This check exists because the thing it looks for actually happened and could not be explained
 * afterwards: an IPC invoice was on file twice at $1,530.89 while a credit from the same wholesaler
 * was being filed, and minutes later it was gone. Something removed it and nothing recorded what.
 * A question about money that cannot be answered afterwards has to be answerable continuously.
 */
const bill = (invoiceNumber: string | null, totalCents: number | null, invoiceDate = "2026-09-04") => ({ invoiceNumber, totalCents, invoiceDate });

describe("one bill, one row", () => {
  test("a month of distinct invoices is clean", () => {
    assert.deepEqual(invoicesFiledTwice([bill("11490216", 153_089), bill("11490227", 7_850), bill("11493051", 307_764)]), []);
  });

  test("nothing on file at all is clean", () => {
    assert.deepEqual(invoicesFiledTwice([]), []);
  });
});

describe("one bill, two rows", () => {
  test("the second copy is the money counted twice, not the first", () => {
    const r = invoicesFiledTwice([bill("11490216", 153_089), bill("11490216", 153_089), bill("11490227", 7_850)]);
    assert.equal(r.length, 1);
    assert.equal(r[0].number, "11490216");
    assert.equal(r[0].copies, 2);
    assert.equal(r[0].overCents, 153_089, "one bill is real; the extra copy is the overstatement");
  });

  test("three copies overstate by two of them", () => {
    const r = invoicesFiledTwice([bill("A1", 10_000), bill("A1", 10_000), bill("A1", 10_000)]);
    assert.equal(r[0].copies, 3);
    assert.equal(r[0].overCents, 20_000);
  });

  /*
   * Matched on the number alone. The two systems spell this wholesaler three ways — "IPC",
   * "Independent Pharmacy Cooperative", "Independent Pharmacy Cooperative (IPC)" — and keying on the
   * name as well is exactly how the last matching bug hid.
   */
  test("case and stray spaces do not let a copy through", () => {
    const r = invoicesFiledTwice([bill(" 11490216 ", 153_089), bill("11490216", 153_089)]);
    assert.equal(r.length, 1);
    assert.equal(r[0].overCents, 153_089);
  });

  test("the worst is first, so the list leads with the money", () => {
    const r = invoicesFiledTwice([bill("small", 100), bill("small", 100), bill("big", 500_000), bill("big", 500_000)]);
    assert.equal(r[0].number, "BIG");
  });

  test("a credit filed twice is reported too, and its overstatement is negative", () => {
    const r = invoicesFiledTwice([bill("CM107761", -19_900), bill("CM107761", -19_900)]);
    assert.equal(r[0].overCents, -19_900, "a credit counted twice takes off twice as much, which is equally wrong");
  });
});

describe("what is not a duplicate", () => {
  /*
   * A document with no number is not a second copy of anything. Two of them are two documents
   * nothing can match, which is a different problem and named on the invoices page instead.
   */
  test("documents with no invoice number are never called duplicates", () => {
    assert.deepEqual(invoicesFiledTwice([bill(null, 325_570), bill(null, 1_424), bill("", 500)]), []);
  });

  test("the same amount from two different bills is two bills", () => {
    assert.deepEqual(invoicesFiledTwice([bill("11490216", 153_089), bill("11490999", 153_089)]), []);
  });
});
