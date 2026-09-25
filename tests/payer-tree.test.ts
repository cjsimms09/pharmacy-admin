import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPayerTree, describeReach, type PlanKey } from "../src/lib/payer-tree";

const claim = (a: Partial<Parameters<typeof buildPayerTree>[0]["claims"][number]> = {}) => ({
  bin: "004336", pcn: "ADV", groupNumber: "RX1234", pbmName: "CVS Caremark", payerLabel: "CAREMARK", remitCents: 1_000, ...a,
});
const build = (a: Partial<Parameters<typeof buildPayerTree>[0]> = {}) =>
  buildPayerTree({ claims: [claim()], register: [], bins: [], contractFor: () => null, contracts: [], ...a });

describe("the payer hierarchy", () => {
  test("payer, then BIN, then the plan the claim was routed under", () => {
    const t = build();
    assert.equal(t.length, 1);
    assert.equal(t[0].payer, "CVS Caremark");
    assert.equal(t[0].bins[0].bin, "004336");
    assert.deepEqual(t[0].bins[0].plans[0].key, { bin: "004336", pcn: "ADV", groupNumber: "RX1234" });
  });

  test("one payer's several BINs all hang under it", () => {
    const t = build({ claims: [claim(), claim({ bin: "610591", groupNumber: "RX9" })] });
    assert.equal(t.length, 1);
    assert.deepEqual(t[0].bins.map((b) => b.bin).sort(), ["004336", "610591"]);
  });

  test("a BIN that appears under more than one payer is marked, never resolved on alone", () => {
    // payer_bins.collides exists with exactly this note; the tree has to carry it forward.
    const t = build({ bins: [{ bin: "004336", pbmName: "CVS Caremark", collides: true }] });
    assert.equal(t[0].bins[0].shared, true);
  });

  test("claims and money add up from the plan to the BIN to the payer", () => {
    const t = build({ claims: [claim({ remitCents: 1_000 }), claim({ groupNumber: "RX2", remitCents: 500 }), claim({ bin: "610591", remitCents: 250 })] });
    assert.equal(t[0].claims, 3);
    assert.equal(t[0].remitCents, 1_750);
    const first = t[0].bins.find((b) => b.bin === "004336")!;
    assert.equal(first.remitCents, 1_500);
    assert.equal(first.plans.length, 2);
  });

  test("a plan the claims used and nobody has identified is shown, not dropped", () => {
    // The pharmacy was paid on it either way, and it is the row most worth chasing.
    const t = build({ claims: [claim({ pbmName: null, payerLabel: "UNKNOWN PLAN" })] });
    assert.equal(t[0].payer, "UNKNOWN PLAN");
    const t2 = build({ claims: [claim({ pbmName: null, payerLabel: null })] });
    assert.equal(t2[0].payer, "Not identified");
  });

  test("the register fills in the sponsor and the classification where it knows them", () => {
    const t = build({
      register: [{ bin: "004336", pcn: "ADV", groupNumber: "RX1234", pbmName: "CVS Caremark", sponsorName: "Acme Inc", classification: "erisa" }],
    });
    assert.equal(t[0].bins[0].plans[0].sponsorName, "Acme Inc");
    assert.equal(t[0].bins[0].plans[0].classification, "erisa");
  });

  test("plans with no contract are counted, because that is the gap worth closing", () => {
    const withNone = build({ claims: [claim(), claim({ groupNumber: "RX2" })] });
    assert.equal(withNone[0].plansWithoutContract, 2);
    const covered = build({
      claims: [claim(), claim({ groupNumber: "RX2" })],
      contractFor: (k: PlanKey) => (k.groupNumber === "RX1234" ? { documentName: "Exhibit B", counterparty: "CVS Caremark", matchedOn: "bin and pcn and group" } : null),
    });
    assert.equal(covered[0].plansWithoutContract, 1);
    assert.equal(covered[0].bins[0].plans.find((p) => p.key.groupNumber === "RX1234")?.contract?.documentName, "Exhibit B");
  });

  test("a contract read but attached to nothing is still visible under its payer", () => {
    const t = build({ contracts: [{ documentName: "Orphan addendum", counterparty: "CVS Caremark", bins: [], pcns: [], groupIds: [] }] });
    assert.equal(t[0].contracts[0].documentName, "Orphan addendum");
    assert.match(t[0].contracts[0].attachesTo, /nothing routable/);
  });

  test("payers are ordered by the money that came through them", () => {
    const t = build({ claims: [claim({ pbmName: "Small", remitCents: 10 }), claim({ pbmName: "Big", groupNumber: "G2", remitCents: 900 })] });
    assert.deepEqual(t.map((p) => p.payer), ["Big", "Small"]);
  });
});

describe("where a contract attaches", () => {
  test("its reach reads as what it actually names", () => {
    assert.equal(describeReach({ bins: ["1", "2"], pcns: [], groupIds: [] }), "2 BINs");
    assert.equal(describeReach({ bins: ["1"], pcns: ["A"], groupIds: ["G"] }), "1 BIN, 1 PCN, 1 group");
  });

  test("a contract naming nothing routable says so, because no claim can ever reach it", () => {
    assert.match(describeReach({ bins: [], pcns: [], groupIds: [] }), /no BIN, PCN or group/);
  });
});
