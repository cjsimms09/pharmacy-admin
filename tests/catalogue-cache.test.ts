import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { borrowAwp } from "../src/lib/catalogue-cache";

/**
 * An AWP is the NDC's, not the seller's. ParMed and IPD print none, so before this every comparison
 * that read the AWP was blind to both wholesalers: 7,551 NDCs on the real database had no AWP on
 * one supplier's row and a printed one on another's. Borrowing took the catalogue from 79.7% of
 * rows with an AWP to 93.6%.
 */
const row = (supplier: string, ndc11: string, awpCents: number | null, pricedOn: string | null = "2026-09-07") => ({ supplier, ndc11, awpCents, pricedOn });

describe("borrowing an AWP from another catalogue of the same NDC", () => {
  test("a row with no AWP takes the one another supplier printed, and says whose", () => {
    const out = borrowAwp([row("McKesson", "00000000001", 12345), row("ParMed", "00000000001", null)]);
    const parmed = out.find((r) => r.supplier === "ParMed")!;
    assert.equal(parmed.awpCents, 12345);
    assert.equal(parmed.awpBorrowedFrom, "McKesson");
  });

  test("a row that printed its own AWP is never overwritten, and is not marked borrowed", () => {
    const out = borrowAwp([row("McKesson", "00000000001", 12345), row("ANDA", "00000000001", 12000)]);
    const anda = out.find((r) => r.supplier === "ANDA")!;
    assert.equal(anda.awpCents, 12000);
    assert.equal(anda.awpBorrowedFrom, undefined);
  });

  test("where two catalogues disagree, the newest priced-on date lends, because AWPs change", () => {
    const out = borrowAwp([
      row("McKesson", "00000000001", 10000, "2026-08-01"),
      row("ANDA", "00000000001", 10500, "2026-09-07"),
      row("IPD", "00000000001", null),
    ]);
    const ipd = out.find((r) => r.supplier === "IPD")!;
    assert.equal(ipd.awpCents, 10500);
    assert.equal(ipd.awpBorrowedFrom, "ANDA");
  });

  test("a zero AWP is no AWP: it neither lends nor blocks borrowing", () => {
    const out = borrowAwp([row("McKesson", "00000000001", 0), row("ANDA", "00000000001", 9000), row("IPD", "00000000001", null)]);
    assert.equal(out.find((r) => r.supplier === "McKesson")!.awpCents, 9000);
    assert.equal(out.find((r) => r.supplier === "IPD")!.awpCents, 9000);
  });

  test("an NDC nobody printed an AWP for stays without one", () => {
    const out = borrowAwp([row("ParMed", "00000000002", null), row("IPD", "00000000002", null)]);
    assert.ok(out.every((r) => r.awpCents === null && r.awpBorrowedFrom === undefined));
  });

  test("borrowing never crosses NDCs", () => {
    const out = borrowAwp([row("McKesson", "00000000001", 12345), row("ParMed", "00000000002", null)]);
    assert.equal(out.find((r) => r.ndc11 === "00000000002")!.awpCents, null);
  });
});
