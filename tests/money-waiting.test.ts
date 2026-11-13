import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { moneyWaiting } from "../src/lib/money-waiting";

/*
 * The pots of money waiting on somebody. The figures are September's shape: a big payer that has never sent anything,
 * one that pays and is simply mid-cycle, a voucher programme, and card takings whose batch was never forwarded.
 */
const pot = (over: Partial<Parameters<typeof moneyWaiting>[0]["pots"][number]>) => ({
  key: "k",
  name: "A payer",
  bin: "012345",
  kind: "payer" as const,
  claims: 10,
  billedCents: 100_000,
  receivedCents: 0,
  outstandingCents: 100_000,
  oldestOn: "2026-09-01",
  ...over,
});

describe("money waiting on somebody", () => {
  const w = moneyWaiting({
    pots: [
      pot({ key: "dst", name: "DST Pharmacy Solutions", claims: 41, billedCents: 4_157_695, outstandingCents: 4_157_695 }),
      pot({ key: "prime", name: "Prime Therapeutics", claims: 651, billedCents: 4_615_015, receivedCents: 117_347, outstandingCents: 4_497_668, oldestOn: "2026-09-02" }),
      pot({ key: "redsail", name: "RedSail copay voucher", kind: "programme", bin: null, claims: 47, billedCents: 773_285, outstandingCents: 773_285 }),
      pot({ key: "settled", name: "A payer that is square", billedCents: 50_000, receivedCents: 50_000, outstandingCents: 0 }),
    ],
    unbanked: [{ key: "card|2026-09-01", name: "Card takings of 2026-09-01", cents: 672_937, on: "2026-09-01", settledBy: "Forward that day's card batch report.", href: "/inbox" }],
    today: "2026-09-16",
  });

  test("largest first, and anything settled is not on the list at all", () => {
    assert.deepEqual(w.rows.map((r) => r.key), ["prime", "dst", "redsail", "card|2026-09-01"]);
    assert.ok(!w.rows.some((r) => r.key === "settled"));
    assert.equal(w.totalCents, 4_497_668 + 4_157_695 + 773_285 + 672_937);
  });

  test("a payer that has never sent anything is marked, and told what to do about it", () => {
    const dst = w.rows.find((r) => r.key === "dst")!;
    assert.equal(dst.neverAnything, true);
    assert.match(dst.settles, /No document has ever settled one of its claims/);
    assert.equal(dst.waitingDays, 15);
  });

  test("a payer that has paid before is not a job", () => {
    const prime = w.rows.find((r) => r.key === "prime")!;
    assert.equal(prime.neverAnything, false);
    assert.match(prime.settles, /Nothing to do unless it stops/);
    assert.match(prime.what, /\$1,173\.47 of \$46,150\.15 has arrived/);
  });

  test("a voucher programme says it is paid after the plan, and card takings say the batch banks them", () => {
    assert.match(w.rows.find((r) => r.key === "redsail")!.what, /pays after the plan/);
    const card = w.rows.find((r) => r.kind === "unbanked")!;
    assert.match(card.what, /not in the cash account/);
    assert.match(card.settles, /card batch report/);
  });

  test("the headline says how much of it is from payers nobody would notice", () => {
    assert.match(w.says, /is waiting on somebody/);
    assert.match(w.says, /never sent anything the site reads/);
    assert.equal(w.neverAnythingCents, 4_157_695 + 773_285 + 672_937);
  });

  test("nothing waiting says so plainly", () => {
    const none = moneyWaiting({ pots: [pot({ outstandingCents: 0, receivedCents: 100_000 })], unbanked: [], today: "2026-09-16" });
    assert.equal(none.rows.length, 0);
    assert.match(none.says, /Nothing is waiting/);
  });
});
