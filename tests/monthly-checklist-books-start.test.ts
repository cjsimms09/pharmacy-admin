import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { monthJustFinished } from "../src/lib/monthly-checklist";
import { SITE_STARTS_ON } from "../src/lib/books-start";

/*
 * A month before the books began asks for nothing.
 *
 * On 16 September 2026 the morning list led with "August 2026: 3 things still to upload", at the
 * level that means act today. Nothing from August was ever going to arrive — the books start on
 * 1 September — so no act available to anybody could clear it. The checklist is always about the
 * month just finished, which for the whole of September is a month out of books, so this was a red
 * mark with a guaranteed lifetime of thirty days.
 */
let monthlyChecklist: typeof import("../src/lib/monthly-checklist").monthlyChecklist;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ monthlyChecklist } = await import("../src/lib/monthly-checklist"));
});

after(() => cleanUpDb?.());

describe("the month a checklist is about", () => {
  test("is the one just finished, which in September is August", () => {
    assert.equal(monthJustFinished("2026-09-16"), "2026-08");
    assert.equal(monthJustFinished("2026-01-03"), "2025-12");
  });
});

describe("a month before the books begin", () => {
  test("REGRESSION: has nothing outstanding, because nothing was ever coming", async () => {
    const august = await monthlyChecklist("2026-08");
    assert.ok(august.month < SITE_STARTS_ON.slice(0, 7), "August is before the books start");
    assert.equal(august.outstanding, 0, "a row nobody can ever satisfy is how a list stops being read");
    assert.equal(august.blockedCents, 0, "and no money is waiting on a statement that will never exist");
  });

  test("but the items are still shown, saying why — this is not hiding", async () => {
    const august = await monthlyChecklist("2026-08");
    assert.ok(august.items.length > 0);
    assert.ok(
      august.items.some((i) => /before the books begin/.test(i.says)),
      "each undone item says what is true of it rather than disappearing",
    );
  });

  test("the first month of the books is asked about normally", async () => {
    const first = await monthlyChecklist(SITE_STARTS_ON.slice(0, 7));
    assert.ok(first.outstanding > 0, "September is in books and has real things outstanding");
  });
});
