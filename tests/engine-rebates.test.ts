import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rebateMonth, type Estimate } from "../src/lib/engine/rebates";

const MCK: Estimate = { supplierId: "s-mck", supplier: "McKesson", cents: 1_562_586, contractRatePercent: 29, unmarkedCents: 95_327, totalCents: 45_247_074 };

describe("a month's rebate: estimated, stated, received", () => {
  test("before the statement is due it is an estimate, and called one; after, the statement is late", () => {
    const early = rebateMonth("2026-09", MCK, null, [], "2026-10-01");
    assert.equal(early.state, "estimated");
    assert.equal(early.expectedBy, "2026-10-20");
    assert.match(early.says, /estimated at the contract rates/);
    assert.match(early.says, /expected by 2026-10-20/);
    assert.match(early.estimateSays, /lines the rate sheet does not place/);
    const late = rebateMonth("2026-09", MCK, null, [], "2026-10-21");
    assert.equal(late.state, "statement_late");
  });
  test("a statement on file is the wholesaler's word, shown against the estimate, until the credit lands", () => {
    const m = rebateMonth("2026-08", { ...MCK, cents: 1_200_000 }, { supplierId: "s-mck", cents: 1_069_724, documentId: "d1" }, [], "2026-09-18");
    assert.equal(m.state, "stated");
    assert.equal(m.statedCents, 1_069_724);
    assert.match(m.says, /\$10,697\.24 against \$12,000\.00 estimated \(\$1,302\.76 less\)/);
    assert.match(m.says, /has not reached the bank yet/);
  });
  test("the credit on the bank statement in the following month, to the cent, is received", () => {
    const m = rebateMonth("2026-08", MCK, { supplierId: "s-mck", cents: 1_069_724, documentId: null }, [{ supplierId: "s-mck", cents: 1_069_724, on: "2026-09-17" }, { supplierId: "s-mck", cents: 970_652, on: "2026-08-19" }], "2026-10-01");
    assert.equal(m.state, "received");
    assert.equal(m.receivedCents, 1_069_724);
    assert.equal(m.receivedOn, "2026-09-17");
    assert.match(m.says, /received on 2026-09-17/);
  });
  test("a credit smaller than the statement is short, by the amount", () => {
    const m = rebateMonth("2026-08", MCK, { supplierId: "s-mck", cents: 1_069_724, documentId: null }, [{ supplierId: "s-mck", cents: 1_000_000, on: "2026-09-17" }], "2026-10-01");
    assert.equal(m.state, "short");
    assert.match(m.says, /\$697\.24 short/);
  });
  test("a supplier with purchases but no contract rate on file cannot be estimated, and says so", () => {
    const m = rebateMonth("2026-09", { supplierId: "s-ipc", supplier: "IPC", cents: null, contractRatePercent: null, unmarkedCents: 2_257_067, totalCents: 2_257_067 }, null, [], "2026-10-01");
    assert.equal(m.state, "no_rate");
    assert.match(m.says, /no contract rate on file/);
  });
});
