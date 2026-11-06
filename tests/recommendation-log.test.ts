import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcile, switchOutcome, scorecard, type LogEntry } from "../src/lib/recommendation-log";
import type { MoneyRow } from "../src/lib/money-found";

/**
 * Advice with a memory. A row is remembered from the morning it first appears, brought up to date
 * while it persists, resolved when it goes, and — where the claims can say — scored by what
 * actually happened afterwards.
 */
const row = (key: string, amountCents = 1000): MoneyRow => ({ key, says: `${key} says`, todo: `${key} todo`, amountCents, cadence: "recurring_monthly", confidence: "likely", basis: "", href: "/" });
const entry = (o: Partial<LogEntry> = {}): LogEntry => ({
  id: "e1", key: "switch-ndc", subject: null, says: "old", todo: "old", amountCents: 500, cadence: "recurring_monthly", confidence: "likely",
  firstSeenOn: "2026-09-01", lastSeenOn: "2026-09-05", resolvedOn: null, status: "open", outcomeCents: null, outcomeBasis: null, measuredOn: null, note: null, ...o,
});

describe("reconciling today's rows with the log", () => {
  test("a new row starts an entry; a persisting one is brought up to date and aged; a missing one is resolved", () => {
    const r = reconcile([entry(), entry({ id: "e2", key: "returns-closing" })], [row("switch-ndc", 800), row("kansas-floor", 250)], "2026-09-06");
    assert.equal(r.insert.length, 1);
    assert.equal(r.insert[0].key, "kansas-floor");
    assert.equal(r.insert[0].firstSeenOn, "2026-09-06");
    assert.deepEqual(r.update, [{ id: "e1", lastSeenOn: "2026-09-06", amountCents: 800, says: "switch-ndc says", todo: "switch-ndc todo", confidence: "likely" }]);
    assert.deepEqual(r.resolve, [{ id: "e2", resolvedOn: "2026-09-06" }]);
    assert.equal(r.ages.get("switch-ndc"), 6);
    assert.equal(r.ages.get("kansas-floor"), 1);
  });

  test("a dismissed entry keeps its status while the row persists, and is not re-inserted", () => {
    const r = reconcile([entry({ status: "dismissed" })], [row("switch-ndc")], "2026-09-06");
    assert.equal(r.insert.length, 0);
    assert.equal(r.update.length, 1);
  });

  test("an already-resolved entry is not matched: the row coming back is a new occasion", () => {
    const r = reconcile([entry({ resolvedOn: "2026-09-03" })], [row("switch-ndc")], "2026-09-06");
    assert.equal(r.insert.length, 1);
    assert.equal(r.resolve.length, 0);
  });
});

describe("scoring a switch-NDC recommendation on the claims since", () => {
  const product = new Set(["A", "B"]);
  const claim = (ndc11: string, units: number, status?: string) => ({ ndc11, quantityThousandths: units * 1000, status });

  test("followed: most units went out under the pick, and the realised gap is on those units", () => {
    const o = switchOutcome([claim("B", 90), claim("A", 10)], "B", product, 80_000);
    assert.equal(o.verdict, "followed");
    assert.equal(o.unitsSince, 100);
    assert.equal(o.realisedCents, 720); // 80,000 micros × 90 units
    assert.equal(o.potentialCents, 800);
    assert.match(o.says, /Followed: 90% of 100 units/);
  });

  test("not followed: the potential is named so the cost of ignoring it is visible", () => {
    const o = switchOutcome([claim("A", 100)], "B", product, 80_000);
    assert.equal(o.verdict, "not followed");
    assert.equal(o.realisedCents, 0);
    assert.match(o.says, /\$8\.00 was there to be had/);
  });

  test("too early under the minimum, and reversed or foreign claims do not count", () => {
    const o = switchOutcome([claim("B", 10), claim("B", 100, "reversed"), claim("Z", 500)], "B", product, 80_000);
    assert.equal(o.verdict, "too early");
    assert.equal(o.unitsSince, 10);
  });
});

describe("the scorecard", () => {
  test("counts by status and adds up promised against realised, per kind of advice", () => {
    const s = scorecard([
      entry({ id: "1", status: "acted", outcomeCents: 700, amountCents: 800 }),
      entry({ id: "2", status: "dismissed", amountCents: 300 }),
      entry({ id: "3", key: "kansas-floor", resolvedOn: "2026-09-04", amountCents: 250 }),
      entry({ id: "4", key: "kansas-floor", amountCents: 100 }),
    ]);
    assert.equal(s.acted, 1);
    assert.equal(s.dismissed, 1);
    assert.equal(s.resolved, 1);
    assert.equal(s.open, 1);
    assert.equal(s.promisedCents, 1450);
    assert.equal(s.realisedCents, 700);
    assert.deepEqual(s.byKey.map((k) => [k.key, k.shown, k.realisedCents]), [["switch-ndc", 2, 700], ["kansas-floor", 2, 0]]);
  });
});
