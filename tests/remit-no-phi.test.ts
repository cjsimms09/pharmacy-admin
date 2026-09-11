import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parse835 } from "../src/lib/x12-835";

/**
 * The owner, 11 September 2026: "i do not want the site to get patient names.. or at least to
 * retain them."
 *
 * An 835 names the patient. The NM1 loop carries the member's surname, first name and member id for
 * every claim it pays, and a real remittance from ProviderPay is full of them. This site reads those
 * files, so the question is not whether the names are in the input — they are — but whether any of
 * them survives into anything the site keeps.
 *
 * The parser handles nine segment types and NM1 is not one of them, so today the answer is no. This
 * test is what stops that being true by accident. Adding NM1 handling, or widening the parser to
 * collect unknown segments "just in case", breaks it.
 */

/** A small but complete remittance carrying patient names in the shape a real one uses. */
const WITH_PATIENTS = [
  "ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *260415*1200*^*00501*000000001*0*P*:~",
  "GS*HP*SENDER*RECEIVER*20260415*1200*1*X*005010X221A1~",
  "ST*835*0001~",
  "BPR*I*6614*C*ACH*CCP*01*999999999*DA*123456789*1234567890**01*999888777*DA*4891210841*20260415~",
  "TRN*1*912013659*1999999999~",
  "DTM*405*20260415~",
  "N1*PR*SS&C HEALTH~",
  "N1*PE*WEST WICHITA FAMILY PHARMACY*XX*1722734~",
  "LX*1~",
  "CLP*332359-1*1*10000*4614*386*12*101000012043023*80~",
  "NM1*QC*1*HARGREAVES*WILHELMINA*Q***MI*ZZQ88817733~",
  "NM1*74*1*HARGREAVES*WINNIFRED****MI*ZZQ88817734~",
  "SVC*N4:00093721410*10000*4614**30~",
  "DTM*472*20260401~",
  "CAS*PR*1*386~",
  "CLP*332360-1*1*5000*2000*100*12*101000012043024*80~",
  "NM1*QC*1*OYELARAN-BUTLER*THEODOSIA*R***MI*ZZQ44412299~",
  "SVC*N4:00378395293*5000*2000**60~",
  "DTM*472*20260402~",
  "SE*19*0001~",
].join("");

/** Every patient identifier planted above. None may appear in anything the parser hands back. */
const PLANTED = [
  "HARGREAVES",
  "WILHELMINA",
  "WINNIFRED",
  "OYELARAN-BUTLER",
  "THEODOSIA",
  "ZZQ88817733",
  "ZZQ88817734",
  "ZZQ44412299",
];

describe("a remittance leaves no patient behind", () => {
  test("the file really does contain the names, or this test proves nothing", () => {
    for (const name of PLANTED) {
      assert.ok(WITH_PATIENTS.includes(name), `${name} should be in the fixture`);
    }
  });

  test("nothing the parser returns contains any of them", () => {
    const r = parse835(WITH_PATIENTS);
    const serialised = JSON.stringify(r).toUpperCase();
    for (const name of PLANTED) {
      assert.ok(
        !serialised.includes(name.toUpperCase()),
        `"${name}" survived the parse — the site would retain a patient identifier`,
      );
    }
  });

  test("and the money it did read is right, so the names were skipped rather than the file", () => {
    const r = parse835(WITH_PATIENTS);
    assert.equal(r.payments.length, 2, "both claims were read");
    assert.deepEqual(
      r.payments.map((p) => [p.rxNumber, p.paidCents]),
      [
        ["332359", 461_400],
        ["332360", 200_000],
      ],
    );
    assert.equal(r.traceNumber, "912013659");
    assert.equal(r.payer, "SS&C HEALTH", "the payer is an organisation, not a person");
  });

  test("the payee name is the pharmacy, which is not patient data", () => {
    // N1 is read on purpose: PR is the payer and PE is this pharmacy. Neither is a patient, and
    // losing them would make a remittance untraceable to who sent it.
    const r = parse835(WITH_PATIENTS);
    assert.ok((r.payee ?? "").toUpperCase().includes("WEST WICHITA"));
  });
});
