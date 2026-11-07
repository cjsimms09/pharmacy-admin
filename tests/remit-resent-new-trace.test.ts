import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * The same remittance sent again under a new trace number posts nothing a second time.
 *
 * On 6 November 2026 a RedSail 835 came again with a new trace and the same claim lines: 125 payments and a receipt of $14,305.62 were
 * posted twice. A payment was keyed by trace, and the trace is the sender's number, not the money. Invented Rx numbers and traces.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let importRemittance: typeof import("../src/lib/claim-payments").importRemittance;
let newId: typeof import("../src/lib/crypto").newId;
let cleanup: () => void;

const user = { name: "the test" };

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ importRemittance } = await import("../src/lib/claim-payments"));
  ({ newId } = await import("../src/lib/crypto"));
  const importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test" });
  const claim = (rx: string) => ({ id: newId(), importId, rxNumber: rx, fillNumber: 1, dateFilled: "2026-09-05", ndc11: "81968004560", bin: "610097", pbmName: "OptumRx", status: "paid" as const, remitCents: 14_618, copayCents: 17_205, source: "transaction_report" });
  await db.insert(schema.claims).values([claim("900700"), claim("900701"), claim("900702")]);
});
after(() => cleanup());

const remit = (trace: string, rxs: string[]) =>
  [
    "ISA*00*          *00*          *ZZ*OPTUMRX        *ZZ*WESTWICHITA    *260920*0230*^*00501*000000001*0*P*:~",
    "GS*HP*OPTUMRX*WESTWICHITA*20260920*0230*1*X*005010X221A1~",
    "ST*835*0001~",
    `BPR*I*${(146.18 * rxs.length).toFixed(2)}*C*ACH*CCP*01*021000021*DA*1234567890*1234567890**01*021000021*DA*9876543210*20260920~`,
    `TRN*1*${trace}*1123456789~`,
    "N1*PR*OPTUMRX~",
    "N1*PE*WEST WICHITA FAMILY PHARMACY*XX*1234567893~",
    ...rxs.flatMap((rx, i) => [
      `LX*${i + 1}~`,
      `CLP*${rx}-1*1*328.23*146.18*0*MC*20260920${rx}*80~`,
      "SVC*N4:81968004560*328.23*146.18**30~",
      "DTM*472*20260905~",
      "CAS*CO*45*10.00~",
      "CAS*PR*1*172.05~",
    ]),
    "SE*14*0001~",
    "GE*1*1~",
    "IEA*1*000000001~",
  ].join("");

describe("a remittance re-sent under a new trace", () => {
  test("the first reading posts; the same lines under another trace post nothing and say why", async () => {
    const a = await importRemittance(remit("8888000001", ["900700", "900701"]), "first.txt", user, {});
    assert.equal(a.payments, 2);
    const b = await importRemittance(remit("8888000002", ["900700", "900701"]), "again.txt", user, {});
    assert.equal(b.payments, 0);
    assert.equal(b.alreadyHeld, 2);
    assert.match(b.problems.join(" "), /repeats a remittance already held under another trace/);
    assert.equal((await db.query.claimPayments.findMany()).length, 2);
  });

  test("a file with even one line not yet held is read as new", async () => {
    const c = await importRemittance(remit("8888000003", ["900700", "900702"]), "mixed.txt", user, {});
    assert.ok(c.payments >= 1, "the new line is posted");
    assert.doesNotMatch(c.problems.join(" "), /repeats a remittance/);
  });
});
