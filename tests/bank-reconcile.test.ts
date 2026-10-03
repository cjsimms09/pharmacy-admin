import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  explainDeposit,
  inRange,
  unpaidSettlements,
  outstandingCents,
  MAX_CANDIDATES,
  type Settlement,
} from "../src/lib/bank-reconcile";

/**
 * This matches on money and date and nothing else, which makes it the one module here capable of
 * being confidently wrong without anything looking wrong. A deposit tied to the wrong payer's
 * remittances still balances the books — it just balances them against a lie — so most of what
 * follows tests that it refuses rather than that it decides.
 */

const rem = (over: Partial<Settlement> & { id: string; amountCents: number; on: string }): Settlement => ({
  kind: "remittance",
  reference: `TRN-${over.id}`,
  payor: "CVS Caremark",
  ...over,
});

describe("a deposit explained exactly", () => {
  test("one remittance, one deposit", () => {
    const r = rem({ id: "a", amountCents: 124_000, on: "2026-09-01" });
    const e = explainDeposit({ on: "2026-09-03", amountCents: 124_000 }, [r]);
    assert.equal(e.kind, "explained");
    if (e.kind !== "explained") return;
    assert.deepEqual(e.settlements.map((s) => s.id), ["a"]);
    assert.equal(e.totalCents, 124_000);
  });

  test("two remittances banked together", () => {
    const e = explainDeposit({ on: "2026-09-03", amountCents: 180_000 }, [
      rem({ id: "a", amountCents: 124_000, on: "2026-09-01" }),
      rem({ id: "b", amountCents: 56_000, on: "2026-09-02" }),
    ]);
    assert.equal(e.kind, "explained");
    if (e.kind !== "explained") return;
    assert.deepEqual(e.settlements.map((s) => s.id).sort(), ["a", "b"]);
  });

  test("what is already tied to another deposit does not count again", () => {
    // A remittance split across two deposits: the first took $1,000 of it, so only $240 is left and
    // the second deposit is explained by that remainder rather than by the whole.
    const r = rem({ id: "a", amountCents: 124_000, on: "2026-09-01", appliedCents: 100_000 });
    assert.equal(outstandingCents(r), 24_000);
    const e = explainDeposit({ on: "2026-09-05", amountCents: 24_000 }, [r]);
    assert.equal(e.kind, "explained");
  });

  test("a fully applied remittance is not a candidate at all", () => {
    const r = rem({ id: "a", amountCents: 124_000, on: "2026-09-01", appliedCents: 124_000 });
    assert.equal(inRange({ on: "2026-09-03", amountCents: 124_000 }, [r]).length, 0);
  });
});

describe("what it refuses to decide", () => {
  test("two payers sending the same money in the same week is left for a person", () => {
    // The dangerous case, and the reason this returns sets rather than a set. Picking one ties CVS's
    // money to Optum's name and the books still balance — nothing downstream would ever notice.
    const e = explainDeposit({ on: "2026-09-03", amountCents: 124_000 }, [
      rem({ id: "cvs", amountCents: 124_000, on: "2026-09-01", payor: "CVS Caremark" }),
      rem({ id: "optum", amountCents: 124_000, on: "2026-09-02", payor: "OptumRx" }),
    ]);
    assert.equal(e.kind, "ambiguous");
    if (e.kind !== "ambiguous") return;
    assert.equal(e.candidates.length, 2);
    assert.match(e.why, /books would still balance/);
  });

  test("naming the payer resolves what would otherwise be ambiguous", () => {
    const e = explainDeposit(
      { on: "2026-09-03", amountCents: 124_000 },
      [
        rem({ id: "cvs", amountCents: 124_000, on: "2026-09-01", payor: "CVS Caremark" }),
        rem({ id: "optum", amountCents: 124_000, on: "2026-09-02", payor: "OptumRx" }),
      ],
      { payor: "OptumRx" },
    );
    assert.equal(e.kind, "explained");
    if (e.kind !== "explained") return;
    assert.equal(e.settlements[0].id, "optum");
  });

  test("a deposit smaller than one outstanding remittance is offered, never recorded", () => {
    // A remittance legitimately splits across two deposits, so this shape is real — but arithmetic
    // cannot tell a genuine instalment from a coincidence, and asserting one leaves a receivable
    // that looks settled and is not.
    const e = explainDeposit({ on: "2026-09-03", amountCents: 60_000 }, [
      rem({ id: "a", amountCents: 124_000, on: "2026-09-01" }),
    ]);
    assert.equal(e.kind, "possible-split");
    if (e.kind !== "possible-split") return;
    assert.match(e.why, /may be part of it/);
  });

  test("near enough is not a reconciliation", () => {
    // One cent out is not a match. Rounding here would be a second, quieter set of books.
    const e = explainDeposit({ on: "2026-09-03", amountCents: 123_999 }, [
      rem({ id: "a", amountCents: 124_000, on: "2026-09-01" }),
    ]);
    assert.notEqual(e.kind, "explained");
  });

  test("too many candidates proposes nothing rather than searching forever", () => {
    // Subset-sum is exponential and this runs on real data. A slow page is a bug; a page that stops
    // answering is an outage, and it would arrive the day a payer sent thirty remittances.
    const many = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) =>
      rem({ id: `r${i}`, amountCents: 1_000 + i, on: "2026-09-01" }),
    );
    const e = explainDeposit({ on: "2026-09-03", amountCents: 1_000 }, many);
    assert.equal(e.kind, "unexplained");
    assert.match((e as { why: string }).why, /too many to combine safely/);
  });
});

describe("the date window is one-sided, because money follows the file", () => {
  test("a remittance produced after the deposit cannot explain it", () => {
    const e = explainDeposit({ on: "2026-09-01", amountCents: 124_000 }, [
      rem({ id: "a", amountCents: 124_000, on: "2026-09-05" }),
    ]);
    assert.equal(e.kind, "unexplained");
  });

  test("a remittance older than the window is out of reach", () => {
    // Otherwise a deposit reaches back into last month's unclaimed remittances and finds a
    // coincidence there, which is worse than finding nothing.
    const e = explainDeposit({ on: "2026-09-30", amountCents: 124_000 }, [
      rem({ id: "a", amountCents: 124_000, on: "2026-07-01" }),
    ]);
    assert.equal(e.kind, "unexplained");
  });

  test("a same-day remittance is in range", () => {
    assert.equal(inRange({ on: "2026-09-01", amountCents: 1 }, [rem({ id: "a", amountCents: 1, on: "2026-09-01" })]).length, 1);
  });
});

describe("what a deposit is not", () => {
  test("money going out is not a deposit", () => {
    const e = explainDeposit({ on: "2026-09-03", amountCents: -5_000 }, [rem({ id: "a", amountCents: 5_000, on: "2026-09-01" })]);
    assert.equal(e.kind, "unexplained");
    assert.match((e as { why: string }).why, /took money out/);
  });

  test("nothing in range says so, which is a different statement from nothing explaining it", () => {
    // Early on this is the true answer nearly every time — no 835 has been received at all — and
    // reading it as "nothing explains this deposit" would suggest a fault rather than a gap.
    const e = explainDeposit({ on: "2026-09-03", amountCents: 5_000 }, []);
    assert.equal(e.kind, "unexplained");
    assert.match((e as { why: string }).why, /may be register takings/);
  });
});

describe("a remittance nobody's deposit accounts for", () => {
  const today = "2026-09-30";

  test("money a payer promised and never sent is the finding that matters", () => {
    const rows = unpaidSettlements(
      [
        rem({ id: "a", amountCents: 400_000, on: "2026-08-01" }),
        rem({ id: "b", amountCents: 120_000, on: "2026-08-15" }),
      ],
      today,
    );
    assert.deepEqual(rows.map((r) => r.settlement.id), ["a", "b"], "largest first, because that is where to start");
    assert.equal(rows[0].outstandingCents, 400_000);
  });

  test("a remittance produced yesterday is not late", () => {
    assert.deepEqual(unpaidSettlements([rem({ id: "a", amountCents: 400_000, on: "2026-09-29" })], today), []);
  });

  test("one already banked is not outstanding", () => {
    const paid = rem({ id: "a", amountCents: 400_000, on: "2026-08-01", appliedCents: 400_000 });
    assert.deepEqual(unpaidSettlements([paid], today), []);
  });

  test("a partly banked remittance is outstanding for the remainder only", () => {
    const part = rem({ id: "a", amountCents: 400_000, on: "2026-08-01", appliedCents: 250_000 });
    assert.equal(unpaidSettlements([part], today)[0].outstandingCents, 150_000);
  });
});

describe("facilitator money is not a plan paying its remittance", () => {
  test("the kind is carried through, so a page can say what the deposit actually was", () => {
    // All 22 later payments on the database today are MTF facilitator money and there is not one
    // 835 in the vault. A deposit explained by facilitator payments has told nobody that a plan
    // paid what it promised, and the page must be able to say which it was.
    const e = explainDeposit({ on: "2026-09-03", amountCents: 573_515 }, [
      { id: "mtf", kind: "facilitator", reference: null, payor: "MEDICARE TRANSACTION FACILITATOR", amountCents: 573_515, on: "2026-09-01" },
    ]);
    assert.equal(e.kind, "explained");
    if (e.kind !== "explained") return;
    assert.equal(e.settlements[0].kind, "facilitator");
  });
});
