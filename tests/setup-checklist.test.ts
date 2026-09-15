import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupItems, ranked, stopsCount, type SetupInput } from "../src/lib/setup-checklist";

/** Everything in place: the list should be all ticks and nothing to do. */
const complete: SetupInput = {
  aiReady: true,
  mail: { configured: true, enabled: true, autoImport: true },
  feeds: [{ key: "claims", label: "the daily report", state: "ok", says: "78 rows this morning", href: "/claims" }],
  jobs: [{ key: "backup", label: "backups", state: "ok", href: "/settings/backups" }],
  plans: { total: 12, decided: 12, claimsUndecided: 0 },
  shelf: { countedOn: "2026-09-06", ageDays: 1 },
  suppliers: [
    { name: "McKesson", primary: true, hasMinimum: false, hasLadder: true, hasTermsPage: "/suppliers/1/terms" },
    { name: "IPC", primary: false, hasMinimum: true, hasLadder: true, hasTermsPage: "/suppliers/2/terms" },
  ],
  standingCosts: 4,
  billsRecent: 20,
  nadac: { state: "current", says: "This week's file." },
  identity: { missing: [] },
  claims: { fills: 500, withBasis: 500 },
  directoryRows: 120_000,
  ksFeeEntered: true,
  contracts: { total: 8, read: 8 },
};

describe("the setup list", () => {
  test("a pharmacy with everything in place has nothing left to do", () => {
    const items = setupItems(complete);
    const { left, done, progress } = ranked(items);
    assert.deepEqual(left.map((i) => i.title), [], "nothing should be outstanding");
    assert.ok(done.length >= 10, "and the done list is the reassurance");
    assert.equal(progress, 1);
    assert.equal(stopsCount(items), 0);
    // The primary's minimum is not asked for: only a secondary needs one to have a card.
    assert.equal(items.some((i) => i.key === "minimum-McKesson"), false);
  });

  test("what stops something comes first, and quickest first inside a rank", () => {
    const items = setupItems({
      ...complete,
      aiReady: false,
      standingCosts: 0,
      ksFeeEntered: false,
      directoryRows: 0,
      plans: { total: 20, decided: 6, claimsUndecided: 431 },
    });
    const { left } = ranked(items);
    const ranks = left.map((i) => i.rank);
    assert.deepEqual([...ranks].sort((a, b) => ({ stops: 0, sharpens: 1, later: 2 })[a] - ({ stops: 0, sharpens: 1, later: 2 })[b]), ranks, "ranks must not interleave");
    const stops = left.filter((i) => i.rank === "stops");
    assert.deepEqual(stops.map((i) => i.minutes), [...stops.map((i) => i.minutes)].sort((a, b) => a - b), "quickest first");
    assert.equal(left[0].key, "ai-key", "five minutes and nothing is read without it");
    const plans = left.find((i) => i.key === "plans");
    assert.equal(plans?.detail, "6 of 20 decided; 431 claims on the rest.");
    assert.equal(stopsCount(items), stops.length);
  });

  test("a feed that is late is something to act on; one that is switched off is not urgent", () => {
    const items = setupItems({
      ...complete,
      feeds: [
        { key: "claims", label: "the daily report", state: "late", says: "nothing since 2 September", href: "/claims" },
        { key: "mtf", label: "facilitator payments", state: "off", says: "not switched on", href: "/remits/mtf" },
      ],
    });
    assert.equal(items.find((i) => i.key === "feed-claims")?.rank, "stops");
    assert.equal(items.find((i) => i.key === "feed-mtf")?.rank, "later");
    assert.equal(items.find((i) => i.key === "feed-claims")?.detail, "nothing since 2 September");
  });

  test("the shelf count goes stale: a fortnight-old count is no longer a shelf", () => {
    assert.equal(setupItems({ ...complete, shelf: { countedOn: "2026-08-01", ageDays: 37 } }).find((i) => i.key === "shelf-count")?.done, false);
    assert.equal(setupItems({ ...complete, shelf: { countedOn: null, ageDays: null } }).find((i) => i.key === "shelf-count")?.detail, "No count has ever been uploaded.");
  });

  test("a secondary without a minimum, and any supplier without a ladder, are named one line each", () => {
    const items = setupItems({
      ...complete,
      suppliers: [
        { name: "McKesson", primary: true, hasMinimum: false, hasLadder: false, hasTermsPage: "/suppliers/1/terms" },
        { name: "IPD", primary: false, hasMinimum: false, hasLadder: true, hasTermsPage: "/suppliers/3/terms" },
      ],
    });
    assert.equal(items.some((i) => i.key === "minimum-IPD"), true);
    assert.equal(items.some((i) => i.key === "minimum-McKesson"), false, "the primary needs no minimum");
    assert.equal(items.find((i) => i.key === "ladder-McKesson")?.rank, "sharpens");
    assert.equal(items.find((i) => i.key === "ladder-McKesson")?.href, "/suppliers/1/terms");
  });

  test("the report columns are counted, not guessed, and eight fills in ten is enough", () => {
    assert.equal(setupItems({ ...complete, claims: { fills: 100, withBasis: 79 } }).find((i) => i.key === "basis-column")?.done, false);
    assert.equal(setupItems({ ...complete, claims: { fills: 100, withBasis: 80 } }).find((i) => i.key === "basis-column")?.done, true);
    assert.equal(setupItems({ ...complete, claims: { fills: 0, withBasis: 0 } }).find((i) => i.key === "basis-column")?.detail, "No claims are held yet.");
  });

  test("nothing is asked for that cannot be checked: no contracts on file, no contract item", () => {
    assert.equal(setupItems({ ...complete, contracts: { total: 0, read: 0 } }).some((i) => i.key === "contracts"), false);
    assert.equal(setupItems({ ...complete, identity: { missing: [] } }).some((i) => i.key === "identity"), false);
    const withGaps = setupItems({ ...complete, identity: { missing: ["the address"] } });
    assert.equal(withGaps.find((i) => i.key === "identity")?.detail, "Missing: the address.");
  });
});
