import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { copayRemitTextFromPdf, readingsOf } from "../src/lib/copay-remit-scan";
import { parseCopayRemit } from "../src/lib/copay-remit";
import type { ScanItem } from "../src/lib/scanned-bank-statement";

/*
 * A scanned copay-voucher remittance, made from the text fixture (every identifier already changed) the way the owner's
 * scan arrives: every printed line broken into words with positions, and the scanner's own mistakes put back in — the
 * slash before the payment year read as a 1, and a 1 inside a row's figures read as I. The text layer that `pdfText`
 * returns for such a scan is useless (one field per line), which is modelled as an empty layer.
 */
const fixture = fs.readFileSync("fixtures/copay-remit-redsail.txt", "utf8");
const lines = fixture.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("//"));

function asScan(textLines: string[]): ScanItem[] {
  const items: ScanItem[] = [];
  textLines.forEach((line, n) => {
    let x = 0;
    for (const word of line.split(/\s+/).filter(Boolean)) {
      items.push({ page: 1, x, y: 1000 - n * 12, text: word });
      x += word.length * 6 + 6;
    }
  });
  return items;
}

describe("a scanned copay-voucher remittance", () => {
  const clean = parseCopayRemit(fixture);

  test("the fixture itself reads, which is what the scan has to match", () => {
    assert.equal(clean.unreadable.length, 0);
    assert.ok(clean.lines.length > 2);
  });

  test("its lines rebuilt from word positions read exactly as the text does", () => {
    const got = copayRemitTextFromPdf("", asScan(lines));
    assert.equal(got.from, "rebuilt lines");
    const r = parseCopayRemit(got.text);
    assert.equal(r.paymentAmountCents, clean.paymentAmountCents);
    assert.deepEqual(r.lines.map((l) => [l.reference, l.paidCents]), clean.lines.map((l) => [l.reference, l.paidCents]));
  });

  test("the scanner's own mistakes are repaired only where the row's arithmetic proves the reading", () => {
    const dateAt = lines.findIndex((l) => /Payment\s*Date/i.test(l));
    const rowAt = lines.findIndex((l) => /^\d{6,}/.test(l.trim()) && /\d1\d/.test(l));
    assert.ok(dateAt >= 0 && rowAt >= 0);
    const damaged = lines.slice();
    damaged[dateAt] = damaged[dateAt].replace(/(\d{2}\/\d{2})\/(\d{4})/, "$1 1$2");
    damaged[rowAt] = damaged[rowAt].replace(/(\d)1(\d)/, "$1I$2");
    const checkAt = lines.findIndex((l) => /Check\/ACH/i.test(l));
    damaged[checkAt] = damaged[checkAt].replace(/Check\/ACH/, "ChecUACH").replace(/(\d)(\d{4})(\d{3})\b/, "$1 $2 $3");
    const got = copayRemitTextFromPdf("", asScan(damaged));
    assert.equal(got.repaired.length, 3, got.repaired.join("; "));
    const r = parseCopayRemit(got.text);
    assert.equal(r.paidOn, clean.paidOn);
    // The number a second read is recognised by: without it every re-read records the payments again.
    assert.ok(clean.reference);
    assert.equal(r.reference, clean.reference);
    assert.deepEqual(r.lines.map((l) => [l.reference, l.paidCents]), clean.lines.map((l) => [l.reference, l.paidCents]));
  });

  test("a figure the scan destroyed is not guessed: the statement then refuses itself", () => {
    const rowAt = lines.findIndex((l) => /^\d{6,}/.test(l.trim()));
    const damaged = lines.slice();
    damaged[rowAt] = damaged[rowAt].replace(/(\d+\.\d{2})(\s*)$/, "#?.??$2");
    const r = parseCopayRemit(copayRemitTextFromPdf("", asScan(damaged)).text);
    assert.ok(r.unreadable.length > 0 || r.lines.length < clean.lines.length);
  });

  test("a doubtful character is only read as a digit where digits surround it", () => {
    assert.deepEqual(readingsOf("12I4 Ibuprofen"), ["1214 Ibuprofen"]);
    assert.deepEqual(readingsOf("1s5.00"), ["155.00", "185.00"]);
    assert.deepEqual(readingsOf("Sodium 200 MG"), []);
  });

  test("a PDF that is not a voucher at all is left alone", () => {
    assert.equal(copayRemitTextFromPdf("Merchant Statement", asScan(["Total Deposits 150.00"])).from, null);
  });
});
