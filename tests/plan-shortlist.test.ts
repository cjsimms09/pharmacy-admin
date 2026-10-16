import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shortlist, askFor, MAX_ROWS, type PlanAggregate } from "../src/lib/plan-shortlist";

/**
 * Fifty-one unexplained PCNs is an afternoon, and an afternoon does not happen. The job of the
 * shortlist is to make it fifteen minutes, and the two ways it can fail are opposite: a list so
 * long nobody finishes it, or a list so short that real money is quietly dropped off the bottom
 * without anybody being told. The tail count is what makes the second one impossible.
 */

/*
 * A BIN nothing publishes a payer sheet for.
 *
 * These tests are about ranking and cutting a list, not about what settles a plan, and pinning them
 * to a real routing means they change meaning the day a stronger source learns that routing's
 * answer. So they use a number nobody will ever publish.
 */
const FICTION = "900001";

const plan = (over: Partial<PlanAggregate> = {}): PlanAggregate => ({
  bin: FICTION,
  pcn: "A4",
  claims: 1,
  receivedCents: 100,
  payerLabel: null,
  pbmName: null,
  planName: null,
  linesOfBusiness: null,
  exampleDrug: null,
  groups: [],
  pioneer: [],
  ...over,
});

/** Settled by PioneerRx's plan file, so it lands in `settled` rather than the questions. */
const settledPlan = (over: Partial<PlanAggregate> = {}) =>
  plan({ pioneer: [{ bin: FICTION, pcn: "KSPARTD", source: "plan_file", planName: "Bc/bs Kansas Pdp", processor: null, planType: "Part D", isActive: true }], pcn: "KSPARTD", ...over });

describe("what goes on the list", () => {
  test("what the evidence settles is separated from what he has to answer", () => {
    const r = shortlist([settledPlan({ claims: 10 }), plan({ pcn: "ZZ", claims: 5 })]);
    assert.equal(r.settled.length, 1);
    assert.equal(r.open.length, 1);
    assert.equal(r.settled[0].classification, "medicare");
    assert.equal(r.settled[0].confidence, "stated");
    assert.equal(r.open[0].pcn, "ZZ");
  });

  test("every settled row carries its source and confidence, not just an answer", () => {
    // The whole point of the register. A class with no source is a guess that has learned to dress
    // like a finding, and this codebase has been bitten by exactly that.
    const s = shortlist([settledPlan()]).settled[0];
    assert.equal(s.source, "pioneer_plan_file");
    assert.ok(s.from.length > 20, "the sentence it was read from must be carried");
  });

  test("ranked by money, with claim count breaking ties", () => {
    const r = shortlist([
      plan({ pcn: "SMALL", claims: 300, receivedCents: 900 }),
      plan({ pcn: "BIG", claims: 28, receivedCents: 3_547_634 }),
      plan({ pcn: "MID", claims: 20, receivedCents: 900 }),
    ]);
    assert.deepEqual(r.open.map((o) => o.pcn), ["BIG", "SMALL", "MID"]);
  });
});

describe("where the list stops, and saying so", () => {
  test("the tail is reported rather than dropped", () => {
    // Stopping the list is a decision, and a decision the owner cannot see is one he cannot
    // disagree with. So whatever is left below the line is counted and named.
    const rows = [plan({ pcn: "BIG", claims: 500, receivedCents: 5_000_000 }), ...Array.from({ length: 30 }, (_, i) => plan({ pcn: `T${i}`, claims: 1, receivedCents: 100 }))];
    const r = shortlist(rows);
    assert.ok(r.open.length < rows.length);
    assert.equal(r.tail.plans, rows.length - r.open.length);
    assert.equal(r.open.reduce((n, o) => n + o.claims, 0) + r.tail.claims, r.totals.openClaims);
    assert.equal(r.open.reduce((n, o) => n + o.receivedCents, 0) + r.tail.receivedCents, r.totals.openCents);
  });

  test("never longer than a sitting, however many plans there are", () => {
    const r = shortlist(Array.from({ length: 200 }, (_, i) => plan({ pcn: `P${i}`, claims: 10, receivedCents: 100_000 })));
    assert.equal(r.open.length, MAX_ROWS);
    assert.equal(r.tail.plans, 185);
  });

  test("a short list is not padded out to the cap", () => {
    const r = shortlist([plan({ pcn: "A" }), plan({ pcn: "B" })]);
    assert.equal(r.open.length, 2);
    assert.equal(r.tail.plans, 0);
  });

  test("one plan carrying everything ends the list after one row", () => {
    // The cut is a share of what is left, not a count, so a month with one big unknown asks one
    // question rather than fifteen.
    const r = shortlist([plan({ pcn: "ALL", claims: 1000, receivedCents: 10_000_000 }), plan({ pcn: "TINY", claims: 1, receivedCents: 10 })]);
    assert.equal(r.open.length, 1);
    assert.equal(r.tail.plans, 1);
  });
});

describe("the question actually put to him", () => {
  test("a commercial plan is asked the one question that decides it", () => {
    const ask = askFor(plan({ planName: "Cwa", claims: 93 }), "which does not say whether the employer bought insurance or funds the plan itself");
    assert.match(ask, /Cwa/);
    assert.match(ask, /insured, or does it fund its own plan/);
    // The consequence is stated, because that is what makes it worth answering.
    assert.match(ask, /ERISA/);
    assert.match(ask, /93 claims/);
  });

  test("anything else is asked what it is, with what he needs to recognise it", () => {
    const ask = askFor(plan({ planName: "Maxorplus Super (upshaw)", claims: 59, receivedCents: 264_438, exampleDrug: "LOSARTAN POTASSIUM 50 MG TAB" }), "Nothing on file says what BIN 005377 carries.");
    assert.match(ask, /Maxorplus Super/);
    assert.match(ask, /Medicare Advantage/);
    assert.match(ask, /\$2,644.38/);
    assert.match(ask, /LOSARTAN/);
  });

  test("a plan with no name is asked about by its BIN, not by nothing", () => {
    assert.match(askFor(plan({ planName: null, payerLabel: null, pbmName: null }), "unknown"), new RegExp(`BIN ${FICTION}`));
  });
});

describe("a Government filing is surfaced, because it is the one that puts a plan in scope", () => {
  test("the hint rides along with the question", () => {
    const r = shortlist([
      plan({ pcn: "G", pioneer: [{ bin: FICTION, pcn: "G", source: "pharmacy", planName: "City of Wichita", processor: null, planType: "Government", isActive: true }] }),
    ]);
    assert.equal(r.open.length, 1);
    assert.ok(r.open[0].governmentHint);
    assert.match(r.open[0].governmentHint!, /City of Wichita/);
  });
});
