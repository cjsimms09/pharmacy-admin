import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { AWAITING_COST, awaitingSaid, cellState, judgedFrom, judgedPeriods, noSaid, registerSaid, yesSaid, type Judged } from "../src/lib/judged";
import { periodsBetween } from "../src/lib/periods";
import type { ObligationCadence } from "../src/db/schema";

/*
 * Which periods of a duty the site judges at all, and what the register may paint for one. The list on Compliance and the register draw the
 * same duties; the fault these hold is the register painting "covered" over a period the list never judged: every period of a duty still
 * waiting for its yes or no, and every period before the day a late-confirmed duty was confirmed. Every date and title here is invented.
 */

const SITE_START = "2026-09-03";
const duty = (over: Partial<Judged> = {}): Judged => ({ cadence: "monthly", needsConfirmation: false, confirmedOn: null, ...over });

describe("judgedFrom: the day counting starts for a duty", () => {
  test("the day the site began, for a duty never asked about and for one answered before the site began", () => {
    assert.equal(judgedFrom(null, SITE_START), SITE_START);
    assert.equal(judgedFrom("2026-08-20", SITE_START), SITE_START);
    assert.equal(judgedFrom(SITE_START, SITE_START), SITE_START);
  });

  test("the day it was confirmed, when that came later", () => {
    assert.equal(judgedFrom("2027-03-01", SITE_START), "2027-03-01");
  });
});

describe("judgedPeriods: the periods the list judges", () => {
  test("a duty still waiting for its yes or no is judged for no period, whatever its cadence and however long ago the site began", () => {
    for (const cadence of ["monthly", "quarterly", "annual", "biennial", "triennial", "as_needed"] as const) {
      assert.deepEqual(judgedPeriods(duty({ cadence, needsConfirmation: true }), SITE_START, "2028-06-01"), [], cadence);
    }
  });

  test("an ordinary duty is judged from the day the site began to today, the current period included", () => {
    assert.deepEqual(judgedPeriods(duty(), SITE_START, "2026-10-07"), ["2026-09", "2026-10"]);
    assert.deepEqual(judgedPeriods(duty({ cadence: "quarterly" }), SITE_START, "2027-01-02"), ["2026-Q3", "2026-Q4", "2027-Q1"]);
    assert.deepEqual(judgedPeriods(duty({ cadence: "annual" }), SITE_START, "2027-01-02"), ["2026", "2027"]);
  });

  test("a duty confirmed as the pharmacy's own after the site began is judged only from the day it was confirmed", () => {
    assert.deepEqual(judgedPeriods(duty({ confirmedOn: "2026-10-02" }), SITE_START, "2026-10-07"), ["2026-10"]);
    assert.deepEqual(judgedPeriods(duty({ cadence: "annual", confirmedOn: "2027-03-01" }), SITE_START, "2027-03-02"), ["2027"]);
  });

  test("a duty answered before the site began is still counted only from the day the site began", () => {
    assert.deepEqual(judgedPeriods(duty({ confirmedOn: "2026-08-01" }), SITE_START, "2026-10-07"), ["2026-09", "2026-10"]);
  });

  test("a duty done as needed has no periods to be judged on", () => {
    assert.deepEqual(judgedPeriods(duty({ cadence: "as_needed" }), SITE_START, "2027-03-02"), []);
  });
});

describe("cellState: what the register paints for one period", () => {
  const judged = new Set(["2026-10", "2026-11"]);
  const answered = { needsConfirmation: false };
  const waiting = { needsConfirmation: true };

  test("a duty still waiting for its yes or no is awaiting in every cell, including one the list carries and one the judged set holds", () => {
    assert.equal(cellState(waiting, "2026-10", judged, undefined), "awaiting");
    assert.equal(cellState(waiting, "2026-10", judged, "missed"), "awaiting");
    assert.equal(cellState(waiting, "2026-08", judged, undefined), "awaiting");
  });

  test("a period outside the judged set was never judged, and is not painted covered", () => {
    assert.equal(cellState(answered, "2026-09", judged, undefined), "not_judged");
  });

  test("a judged period the list does not carry is covered", () => {
    assert.equal(cellState(answered, "2026-10", judged, undefined), "satisfied");
  });

  test("a judged period the list carries keeps the state the list gave it", () => {
    for (const s of ["open", "partial", "missed"] as const) assert.equal(cellState(answered, "2026-11", judged, s), s);
  });
});

describe("the two screens agree about what was judged", () => {
  test("the register paints a period covered only if the list's own periods hold it, for every cadence, answer, confirmation day and today", () => {
    const counts = { satisfied: 0, not_judged: 0, awaiting: 0 };
    for (const cadence of ["monthly", "quarterly", "annual"] as const) {
      for (const needsConfirmation of [false, true]) {
        for (const confirmedOn of [null, "2026-08-01", "2026-10-02", "2027-03-01"]) {
          for (const today of ["2026-09-03", "2026-10-07", "2027-01-02", "2027-03-02", "2028-01-01"]) {
            const o = duty({ cadence, needsConfirmation, confirmedOn });
            const judged = new Set(judgedPeriods(o, SITE_START, today));
            // The register draws a cell for every period from the day the site began, not only for the judged ones.
            for (const p of periodsBetween(cadence, SITE_START, today)) {
              const where = `${cadence} ${needsConfirmation ? "unanswered" : "answered"} confirmed ${confirmedOn} on ${today}, period ${p}`;
              const s = cellState(o, p, judged, undefined);
              if (needsConfirmation) assert.equal(s, "awaiting", where);
              else if (judged.has(p)) assert.equal(s, "satisfied", where);
              else assert.equal(s, "not_judged", where);
              if (s === "satisfied" || s === "not_judged" || s === "awaiting") counts[s]++;
            }
          }
        }
      }
    }
    // A sweep that never reached one of the three would pass without testing it.
    assert.ok(counts.satisfied > 0 && counts.not_judged > 0 && counts.awaiting > 0, JSON.stringify(counts));
  });
});

describe("a duty waiting for its yes or no, one confirmed late and one answered no, read through the real tables", () => {
  let db: typeof import("../src/db").db;
  let schema: typeof import("../src/db").schema;
  let compliance: typeof import("../src/lib/compliance-status");
  let ensureObligations: typeof import("../src/lib/obligations").ensureObligations;
  let forgetHeld: typeof import("../src/lib/held").forgetHeld;
  let newId: typeof import("../src/lib/crypto").newId;
  let todayIso: typeof import("../src/lib/dates").todayIso;
  let cleanup: () => void;
  const SITE_STARTED = "2026-09-03T12:00:00.000Z";
  const pharmacist = { id: "the-test", name: "The Test Pharmacist" };

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ db, schema } = await import("../src/db"));
    compliance = await import("../src/lib/compliance-status");
    ({ ensureObligations } = await import("../src/lib/obligations"));
    ({ forgetHeld } = await import("../src/lib/held"));
    ({ newId } = await import("../src/lib/crypto"));
    ({ todayIso } = await import("../src/lib/dates"));
  });
  after(() => cleanup());
  beforeEach(async () => {
    // Each test starts from the seeded duties as they ship, with the site beginning before any date under test.
    await db.delete(schema.obligationCompletions);
    await db.delete(schema.obligations);
    await ensureObligations();
    await db.update(schema.obligations).set({ createdAt: SITE_STARTED });
  });

  const make = async (over: { title: string; cadence?: ObligationCadence; needsConfirmation?: boolean; confirmedOn?: string | null; citation?: string }) => {
    const id = newId();
    await db.insert(schema.obligations).values({ id, seedKey: null, cadence: "monthly", createdAt: SITE_STARTED, ...over });
    return id;
  };
  const mine = async (id: string, today: string) => (await compliance.openItems(today)).filter((i) => i.obligationId === id);
  // The register's cells for one duty, composed from the same three pieces the page composes them from.
  const register = async (id: string, today: string) => {
    const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.id, id) });
    assert.ok(o, "the duty exists");
    const start = await compliance.startedUsingSite();
    const judged = new Set(judgedPeriods(o, start, today));
    const states = compliance.openStates(await compliance.openItems(today));
    return periodsBetween(o.cadence, start, today).map((p) => `${p} ${cellState(o, p, judged, states.get(`${o.id}|${p}`))}`);
  };

  test("a duty nobody has answered is not listed late or part done, however long ago the site began, and is offered as a question", async () => {
    const id = await make({ title: "A duty nobody has answered", needsConfirmation: true });
    assert.deepEqual(await mine(id, "2027-03-02"), []);
    assert.ok((await compliance.unansweredObligations()).some((u) => u.obligationId === id));
  });

  test("the register shows every period of it as awaiting, and none as covered", async () => {
    const id = await make({ title: "A duty nobody has answered", needsConfirmation: true });
    const cells = await register(id, "2026-11-10");
    assert.deepEqual(cells, ["2026-09 awaiting", "2026-10 awaiting", "2026-11 awaiting"]);
  });

  test("a duty confirmed late is judged from the day it was confirmed: the list and the register agree, and the earlier periods are not judged", async () => {
    const id = await make({ title: "A duty confirmed in March", confirmedOn: "2027-03-01" });
    assert.deepEqual((await mine(id, "2027-03-02")).map((i) => `${i.periodKey} ${i.state}`), ["2027-03 open"]);
    assert.deepEqual(await register(id, "2027-03-02"), [
      "2026-09 not_judged", "2026-10 not_judged", "2026-11 not_judged", "2026-12 not_judged", "2027-01 not_judged", "2027-02 not_judged", "2027-03 open",
    ]);
  });

  test("the same duty not confirmed late is late for every period since the site began, so the late confirmation is what changed the reading", async () => {
    const id = await make({ title: "A duty never asked about" });
    assert.deepEqual((await mine(id, "2027-03-02")).map((i) => `${i.periodKey} ${i.state}`), [
      "2026-09 missed", "2026-10 missed", "2026-11 missed", "2026-12 missed", "2027-01 missed", "2027-02 missed", "2027-03 open",
    ]);
  });

  test("a period filed for is covered on the register and not listed, and the one beside it keeps the state the list gave it", async () => {
    const id = await make({ title: "A duty filed for one month" });
    await db.insert(schema.obligationCompletions).values({ id: newId(), obligationId: id, periodKey: "2026-09", completedOn: "2026-09-20", completedBy: "the test" });
    assert.deepEqual((await mine(id, "2026-10-07")).map((i) => `${i.periodKey} ${i.state}`), ["2026-10 open"]);
    assert.deepEqual(await register(id, "2026-10-07"), ["2026-09 satisfied", "2026-10 open"]);
  });

  test("a duty done as needed is judged for no period, on the list and on the register", async () => {
    const id = await make({ title: "A duty done as needed", cadence: "as_needed" });
    assert.deepEqual(await mine(id, "2027-03-02"), []);
    assert.deepEqual(await register(id, "2027-03-02"), []);
  });

  test("a duty answered no counts nowhere, and the register lists it with the day and the person who decided", async () => {
    const id = await make({ title: "A duty that does not apply", needsConfirmation: true, citation: "Invented rule 1" });
    assert.deepEqual(await compliance.answerObligation(id, false, pharmacist), { title: "A duty that does not apply", cadence: "monthly" });
    assert.deepEqual(await mine(id, "2027-03-02"), []);
    assert.ok(!(await compliance.unansweredObligations()).some((u) => u.obligationId === id));
    // Every seeded duty ships switched on, so this one is the only entry there is to find.
    assert.deepEqual(await compliance.dismissedObligations(), [
      { obligationId: id, title: "A duty that does not apply", citation: "Invented rule 1", cadence: "monthly", decidedOn: todayIso(), decidedBy: "The Test Pharmacist" },
    ]);
  });

  test("a duty answered yes is judged from the day it was answered, and is no longer a question", async () => {
    const id = await make({ title: "A duty that applies", cadence: "annual", needsConfirmation: true });
    await compliance.answerObligation(id, true, pharmacist);
    assert.ok(!(await compliance.unansweredObligations()).some((u) => u.obligationId === id));
    assert.deepEqual(await compliance.dismissedObligations(), []);
    const today = todayIso();
    assert.deepEqual((await mine(id, today)).map((i) => `${i.periodKey} ${i.state}`), [`${today.slice(0, 4)} open`]);
  });

  test("the summary lists a duty still waiting for its answer though nothing is late, and stops listing it once it is answered", async () => {
    // Every seeded duty is put aside so that the only thing that could be listed is the duty made here.
    await db.update(schema.obligations).set({ active: false });
    const id = await make({ title: "A duty nobody has answered", cadence: "annual", needsConfirmation: true });
    forgetHeld("compliance-summary");
    const before = await compliance.complianceSummary();
    assert.deepEqual([before.missed.length, before.partial.length], [0, 0], "nothing is late");
    assert.deepEqual(before.unanswered.map((u) => u.obligationId), [id]);
    assert.ok(!("clean" in before), "the summary used to carry a clean that no screen read, and it meant less than the word says");
    await compliance.answerObligation(id, true, pharmacist);
    forgetHeld("compliance-summary");
    const answered = await compliance.complianceSummary();
    assert.deepEqual(answered.unanswered, []);
    assert.deepEqual(answered.openNow.map((i) => `${i.obligationId} ${i.state}`), [`${id} open`]);
  });

  test("the inspection list does not call the calendar ready while a duty waits for its answer, and does once it is answered", async () => {
    const { inspectionReport } = await import("../src/lib/inspection");
    const register = async () => {
      forgetHeld("compliance-summary");
      const check = (await inspectionReport()).checks.find((c) => c.key === "register");
      assert.ok(check, "the list has no question about the calendar");
      return check;
    };
    await db.update(schema.obligations).set({ active: false });
    const id = await make({ title: "A duty nobody has answered", cadence: "annual", needsConfirmation: true });
    const waiting = await register();
    assert.equal(waiting.state, "gap");
    assert.equal(waiting.answer, `Every period that has been judged is covered. 1 duty is waiting for your yes or no. ${AWAITING_COST}`);
    await compliance.answerObligation(id, true, pharmacist);
    const answered = await register();
    assert.equal(answered.state, "ready");
    assert.equal(answered.answer, "Every period that has ended is covered.");
  });

  test("the inspection list says both things when a period was missed and a duty is still waiting", async () => {
    const { inspectionReport } = await import("../src/lib/inspection");
    await db.update(schema.obligations).set({ active: false });
    await make({ title: "A monthly duty never asked about" });
    await make({ title: "A duty nobody has answered", cadence: "annual", needsConfirmation: true });
    forgetHeld("compliance-summary");
    const check = (await inspectionReport()).checks.find((c) => c.key === "register");
    assert.ok(check, "the list has no question about the calendar");
    assert.ok(check.state === "gap" || check.state === "blocking", check.state);
    assert.match(check.answer, /^\d+ periods? went by without being covered\. Those are what an inspector finds\. 1 duty is waiting for your yes or no\. /);
  });
});

describe("what the screens say about a duty waiting for its yes or no, and about the answer", () => {
  test("the count is said once, in the singular and the plural", () => {
    assert.equal(awaitingSaid(1), "1 duty is waiting for your yes or no");
    assert.equal(awaitingSaid(6), "6 duties are waiting for your yes or no");
  });

  test("what waiting costs says that nothing is judged, so that none of it reads late or covered", () => {
    assert.match(AWAITING_COST, /no period of a waiting duty is judged, so none reads late and none reads covered/);
  });

  test("what waiting costs does not read as though the subject were untracked: a person's training and a licence are judged on their own screens", () => {
    assert.match(AWAITING_COST, /A person's training or a licence is judged on its own screen either way/);
  });

  test("the inspection sheet's register line is a pure function of what is late, part done and waiting, and never says covered while any is behind", () => {
    assert.equal(registerSaid(0, 0, 0), "Every period that has ended is covered.");
    assert.equal(registerSaid(0, 0, 2), `Every period that has been judged is covered. 2 duties are waiting for your yes or no. ${AWAITING_COST}`);
    assert.equal(registerSaid(1, 0, 0), "1 period went by without being covered. Those are what an inspector finds.");
    assert.equal(registerSaid(3, 0, 0), "3 periods went by without being covered. Those are what an inspector finds.");
    assert.equal(registerSaid(0, 1, 0), "1 period was only partly covered. Those are what an inspector finds.");
    assert.equal(registerSaid(0, 2, 0), "2 periods were only partly covered. Those are what an inspector finds.");
    assert.equal(
      registerSaid(1, 2, 1),
      `1 period went by without being covered. 2 periods were only partly covered. Those are what an inspector finds. 1 duty is waiting for your yes or no. ${AWAITING_COST}`,
    );
    for (const [m, p, w] of [[1, 0, 0], [0, 1, 0], [2, 3, 0], [1, 0, 4], [0, 2, 1]]) assert.doesNotMatch(registerSaid(m, p, w), /Every period/, `${m} late, ${p} part done, ${w} waiting`);
  });

  test("a yes names the period that holds the day it was said, because that period can still go late", () => {
    assert.match(yesSaid("Check the invented thing", "monthly", "2026-10-07"), /counted from the period that holds today, October 2026, so that period can still be late if it ends uncovered; earlier ones are not counted/);
    assert.match(yesSaid("Check the invented thing", "quarterly", "2026-10-07"), /holds today, Q4 2026,/);
    assert.match(yesSaid("Check the invented thing", "annual", "2026-10-07"), /holds today, 2026,/);
  });

  test("a yes to a duty done when it happens says it has no periods and never says it can be late", () => {
    const said = yesSaid("Do the invented thing when it comes up", "as_needed", "2026-10-07");
    assert.match(said, /has no periods and is never counted late/);
    assert.doesNotMatch(said, /can still be late|counted from/);
  });

  test("a no says what it stops and what it leaves alone", () => {
    const said = noSaid("Check the invented thing");
    assert.match(said, /not applying here, with today's date and your name/);
    assert.match(said, /Considered and not applicable/);
    assert.match(said, /a person's training or a licence, is still tracked there/);
  });
});

describe("no screen says what a duty waiting for its answer made false", () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const text = (file: string) => fs.readFileSync(file, "utf8");

  test("none of the sentences that were wrong is still on a screen", () => {
    const dead = [
      "counting from today rather than from before you said so",
      "is switched off, with today's date",
      "nothing is due in the next 45 days",
      "shipped switched on",
      "Nothing here is counting against you in the meantime",
      "Nothing here counts against you until you say it applies",
      "They count nowhere",
      "Nothing is late today",
      "every duty has been answered yes or no",
    ];
    const found: string[] = [];
    for (const f of files("src")) {
      const t = text(f);
      for (const d of dead) if (t.includes(d)) found.push(`${f.split(path.sep).join("/")}: ${d}`);
    }
    assert.deepEqual(found, []);
  });

  test("every screen that can say covered or clean reads the duties still waiting", () => {
    // A stand-in: it reads the source for the word, not what the screen does with it. The pages themselves were not rendered by this test.
    for (const f of ["src/app/(app)/compliance/page.tsx", "src/app/(app)/dashboard/page.tsx", "src/lib/inspection.ts"]) {
      assert.match(text(f), /\.unanswered\.length/, `${f} no longer reads the duties still waiting for an answer`);
    }
    assert.match(text("src/app/(app)/compliance/register/page.tsx"), /cellState\(/, "the register no longer decides a cell through cellState");
  });

  test("the top of Today does not say nothing needs you while something further down does, and the inspection sheet counts part-done periods", () => {
    // Stands in for rendering the pages, which this test does not do: it reads the source for the decision.
    const today = text("src/app/(app)/dashboard/page.tsx");
    assert.match(today, /const elsewhere = lateCount > 0 \|\| waiting > 0;/);
    assert.match(today, /elsewhere \? "No alert is open today" : "Nothing needs you today"/);
    assert.match(text("src/lib/inspection.ts"), /registerSaid\(missed, partial, waiting\)/);
    assert.match(text("src/lib/inspection.ts"), /missed > 0 \|\| partial > 0 \|\| waiting > 0/);
  });
});
