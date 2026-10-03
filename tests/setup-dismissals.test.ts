import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ranked, stopsCount, type SetupItem } from "../src/lib/setup-checklist";

/*
 * The third answer the setup list never had.
 *
 * The owner, 16 September 2026, pasting forty-five rows of it: "these are all irrelevant, i dont
 * have them or they arent relevant, need system to leave me alone about them". Every row ended
 * "something is wrong until this is done", and there was no way to say that a rebate ladder for a
 * wholesaler he has never bought from is not one of those things.
 *
 * The danger in the remedy is the obvious one: set aside quietly becoming done. These cases exist
 * to hold those two apart, because one of them means a check passed and the other means a question
 * was answered, and only the first is evidence about the pharmacy.
 */

const item = (o: Partial<SetupItem> & { key: string }): SetupItem => ({
  title: o.key,
  rank: "stops",
  done: false,
  why: "",
  detail: "",
  href: "/",
  action: "Do it",
  minutes: 10,
  area: "buying",
  ...o,
});

const aside = { reason: "we do not buy from them", at: "2026-09-16T12:00:00.000Z", by: "Owner" };

describe("an item set aside leaves the list without being called done", () => {
  test("it is in neither what is left nor what is done", () => {
    const items = [
      item({ key: "minimum-Xymogen", notApplicable: aside }),
      item({ key: "shelf-count" }),
      item({ key: "ai-key", done: true }),
    ];
    const r = ranked(items);
    assert.deepEqual(r.left.map((i) => i.key), ["shelf-count"]);
    assert.deepEqual(r.done.map((i) => i.key), ["ai-key"], "set aside is NOT done: no check passed");
    assert.deepEqual(r.notApplicable.map((i) => i.key), ["minimum-Xymogen"]);
  });

  test("the reason and who gave it travel with it, because somebody asks in eleven months", () => {
    const r = ranked([item({ key: "ladder-TopRx", notApplicable: aside })]);
    assert.equal(r.notApplicable[0].notApplicable?.reason, "we do not buy from them");
    assert.equal(r.notApplicable[0].notApplicable?.by, "Owner");
  });

  test("its minutes stop being counted towards the work outstanding", () => {
    const left = [item({ key: "a", minutes: 30 }), item({ key: "b", minutes: 10, notApplicable: aside })];
    assert.equal(ranked(left).minutesLeft, 30, "an hour of work he will never do is not an hour outstanding");
  });

  test("the badge that makes him open the list counts only what he has not answered", () => {
    const items = [
      item({ key: "a", rank: "stops" }),
      item({ key: "b", rank: "stops", notApplicable: aside }),
      item({ key: "c", rank: "sharpens" }),
    ];
    assert.equal(stopsCount(items), 1, "a number he cannot move is a number he stops looking at");
  });

  test("progress counts an answered question as settled, so the bar can reach the end", () => {
    const items = [item({ key: "a", done: true }), item({ key: "b", notApplicable: aside })];
    assert.equal(ranked(items).progress, 1);
  });

  test("a done item stays done even if it was once set aside — the check is what decides", () => {
    /*
     * He sets a ladder aside, then enters it anyway. `done` comes from the data and outranks the
     * note: the item is done, and it must not sit in the set-aside pile claiming otherwise.
     */
    const r = ranked([item({ key: "ladder-IPC", done: true, notApplicable: aside })]);
    assert.deepEqual(r.done.map((i) => i.key), ["ladder-IPC"]);
    assert.equal(r.notApplicable.length, 0);
    assert.equal(r.left.length, 0);
  });
});

describe("the list is unchanged where nothing has been set aside", () => {
  test("REGRESSION: ranking, minutes and counts behave exactly as before", () => {
    const items = [
      item({ key: "slow", rank: "stops", minutes: 30 }),
      item({ key: "quick", rank: "stops", minutes: 2 }),
      item({ key: "later", rank: "later", minutes: 5 }),
      item({ key: "done", done: true }),
    ];
    const r = ranked(items);
    assert.deepEqual(r.left.map((i) => i.key), ["quick", "slow", "later"], "quickest first inside each rank");
    assert.equal(r.minutesLeft, 37);
    assert.equal(stopsCount(items), 2);
    assert.equal(r.notApplicable.length, 0);
  });
});
