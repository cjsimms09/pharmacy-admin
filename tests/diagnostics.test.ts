import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact, pseudonym, isForbiddenKey, isPrescriptionKey, readmeFor } from "../src/lib/diagnostics";

const opts = { salt: "salt-a" };

describe("prescription numbers", () => {
  test("are replaced by default, and rows of one fill still match each other", () => {
    const { data, report } = redact(
      { fills: [{ rxNumber: "331488", leg: 1 }, { rxNumber: "331488", leg: 2 }, { rxNumber: "305766", leg: 1 }] },
      opts,
    );
    const fills = (data as { fills: { rxNumber: string }[] }).fills;
    assert.notEqual(fills[0].rxNumber, "331488");
    assert.equal(fills[0].rxNumber, fills[1].rxNumber, "one prescription is one value inside the file");
    assert.notEqual(fills[0].rxNumber, fills[2].rxNumber);
    assert.match(fills[0].rxNumber, /^rx-[0-9a-f]{8}$/);
    assert.equal(report.prescriptionsPseudonymised, 3);
    assert.equal(report.distinctPrescriptions, 2);
  });

  test("mean nothing outside their own file", () => {
    // A different export salts differently, so a series of files cannot be joined into a history.
    assert.notEqual(pseudonym("331488", "salt-a"), pseudonym("331488", "salt-b"));
    assert.equal(pseudonym("331488", "salt-a"), pseudonym("331488", "salt-a"));
  });

  test("are kept when the pharmacist deliberately asks for them", () => {
    const { data, report } = redact({ rxNumber: "331488" }, { ...opts, includeIdentifiers: true });
    assert.equal((data as { rxNumber: string }).rxNumber, "331488");
    assert.equal(report.identifiersIncluded, true);
    assert.equal(report.prescriptionsPseudonymised, 0);
  });

  test("the spellings a report might use all count as one", () => {
    for (const k of ["rxNumber", "rx_number", "Rx Number", "prescriptionNumber", "rxNo", "rx"]) {
      assert.equal(isPrescriptionKey(k), true, k);
    }
    assert.equal(isPrescriptionKey("rxRescueCredit"), false, "not every key starting with rx is one");
  });
});

describe("identifiers that must never leave", () => {
  test("are dropped and counted rather than passed through", () => {
    const { data, report } = redact(
      { patientName: "A Person", dob: "1970-01-01", memberId: "X1", ndc11: "00093105601" },
      opts,
    );
    const out = data as Record<string, unknown>;
    assert.equal("patientName" in out, false);
    assert.equal("memberId" in out, false);
    assert.equal(out.ndc11, "00093105601", "a drug code is not a patient identifier");
    assert.equal(report.dropped.patientName, 1);
    assert.equal(report.dropped.memberId, 1);
  });

  test("are recognised however the source spells them", () => {
    for (const k of ["patient_name", "Patient Name", "firstName", "DateOfBirth", "pt_phone", "address1", "SSN", "personCode"]) {
      assert.equal(isForbiddenKey(k), true, k);
    }
    for (const k of ["name", "itemName", "payerLabel", "supplierName", "vendorName"]) {
      assert.equal(isForbiddenKey(k), false, `${k} is not a patient identifier`);
    }
  });

  test("are dropped wherever they are nested", () => {
    const { report } = redact({ a: { b: [{ patientName: "x" }, { patientName: "y" }] } }, opts);
    assert.equal(report.dropped.patientName, 2);
  });
});

describe("things that would otherwise break the export", () => {
  test("a cycle is broken rather than followed", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const { data } = redact(a, opts);
    assert.equal((data as { self: string }).self, "[circular]");
  });

  test("a very long list keeps both ends and says what it dropped", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ i }));
    const { data } = redact({ rows }, { ...opts, maxArray: 10 });
    const out = (data as { rows: unknown[] }).rows;
    assert.equal(out.length, 11);
    assert.deepEqual(out[0], { i: 0 });
    assert.deepEqual(out[10], { i: 4999 });
    assert.match(String(out[5]), /4990 rows omitted/);
  });

  test("a short list is kept whole", () => {
    const { data } = redact({ rows: [1, 2, 3] }, { ...opts, maxArray: 10 });
    assert.deepEqual((data as { rows: number[] }).rows, [1, 2, 3]);
  });

  test("dates, maps, sets and bigints survive as something readable", () => {
    const { data } = redact(
      { at: new Date("2026-09-06T00:00:00Z"), m: new Map([["k", 1]]), s: new Set([1, 2]), big: 10n },
      opts,
    );
    const out = data as Record<string, unknown>;
    assert.equal(out.at, "2026-09-06T00:00:00.000Z");
    assert.deepEqual(out.m, { k: 1 });
    assert.deepEqual(out.s, [1, 2]);
    assert.equal(out.big, "10");
  });

  test("null and undefined are left alone", () => {
    const { data } = redact({ a: null, b: undefined }, opts);
    assert.deepEqual(data, { a: null, b: undefined });
  });
});

describe("the file explains itself", () => {
  test("and says plainly when real numbers are in it", () => {
    const withReal = readmeFor({ pageTitle: "Claims", identifiersIncluded: true }).join(" ");
    assert.match(withReal, /REAL PRESCRIPTION NUMBERS ARE INCLUDED/);
    const without = readmeFor({ pageTitle: "Claims", identifiersIncluded: false }).join(" ");
    assert.match(without, /replaced with stand-ins/);
    assert.doesNotMatch(without, /REAL PRESCRIPTION NUMBERS ARE INCLUDED/);
  });
});
