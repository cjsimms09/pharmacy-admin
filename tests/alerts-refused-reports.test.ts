import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/* Nothing at the top: both modules open the database on first import. See support/scratch-db.ts. */
let alerts: typeof import("../src/lib/alerts").alerts;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ alerts } = await import("../src/lib/alerts"));
  ({ db, schema } = await import("../src/db"));
});

after(() => cleanUpDb?.());

/**
 * A report that arrived, was recognised, and was refused.
 *
 * The owner, 1 October 2026: "this site is not useful if it doest work and Ihave to babysit
 * evberything. please stop this stuff from happening."
 *
 * In two days three correct reports were refused by three different readers — two Sundays of
 * payment-type takings, a month of them carrying a cash-price prescription, and September's whole
 * System Sales Summary at $705,263.81 — and in every case the money did not land and nothing said
 * so. He found all three by knowing what should have arrived and going to look. The refusals were
 * written into `route_result` as "Held, nothing stored" and read by nothing.
 *
 * A reader refusing is not the failure; sometimes it is exactly right. A refusal nobody hears is.
 */
describe("a report arrived and was not counted", () => {
  const arrival = async (id: string, routedAs: string, routeResult: string, status = "stored") =>
    db.insert(schema.inboxItems).values({
      id,
      messageId: `m-${id}`,
      receivedAt: new Date(Date.now() - 86_400_000).toISOString(),
      fromAddress: "notifications@example.invalid",
      subject: `${routedAs} delivery`,
      fileName: `${routedAs}.txt`,
      status: status as "stored" | "rejected" | "ignored",
      routedAs,
      routeResult,
    });

  const refusedAlert = async () => (await alerts()).find((a) => a.key === "reports-refused") ?? null;

  test("with nothing refused, there is no row — the list does not carry a permanent mark", async () => {
    assert.equal(await refusedAlert(), null);
  });

  test("a recognised report held back is on the front page, at the level that means today", async () => {
    await arrival("a1", "sales_by_payment", "Held, nothing stored: the \"Rx Sales Totals:\" row is missing. Nothing was recorded.");
    const a = await refusedAlert();
    assert.ok(a, "a refused report must reach the dashboard");
    assert.equal(a.level, "now");
    assert.match(a.title, /1 report that arrived and was not counted/);
    assert.match(a.why, /recognised and then refused/);
    assert.equal(a.href, "/inbox");
  });

  test("it names the kinds rather than counting silently", async () => {
    await arrival("a2", "accrual_sales", "Recognised as the System Sales Summary but nothing was filed: Retail and prescriptions do not add to the total the report printed.");
    const a = await refusedAlert();
    assert.ok(a);
    assert.match(a.why, /Sales by payment type/);
    assert.match(a.why, /System sales summary/);
    assert.match(a.title, /2 reports/);
  });

  /*
   * The distinction the whole row depends on. Something unrecognised is usually nothing — a listserv
   * photograph, somebody's immunisation certificate — and a row that fires on those every morning is
   * a row that gets scrolled past, which is how the site ends up where it started.
   */
  test("something merely unrecognised does not fire it", async () => {
    await arrival("a3", "unrecognised", "A PDF this does not recognise. Filed as a document.");
    const a = await refusedAlert();
    assert.ok(a);
    assert.match(a.title, /2 reports/, "still two: the unrecognised one is not a refusal");
  });

  test("a report that loaded cleanly does not fire it either", async () => {
    await arrival("a4", "on_hand", "2,277 items counted on 2026-09-30, replacing the earlier upload for that day.");
    const a = await refusedAlert();
    assert.ok(a);
    assert.match(a.title, /2 reports/);
  });

  test("a file refused before it was stored at all counts — nothing from it reached the books either", async () => {
    await arrival("a5", "remittance_835", "Refused: the file names patients and the gate turned it away.", "rejected");
    const a = await refusedAlert();
    assert.ok(a);
    assert.match(a.title, /3 reports/);
  });

  /*
   * Re-reading one successfully is what clears it. The alert reads the row's current state rather
   * than keeping a list of its own, so a fixed reader that re-reads the document takes the row off
   * the page with no second place to remember to tidy.
   */
  test("re-reading one successfully takes it off the list", async () => {
    await db
      .update(schema.inboxItems)
      .set({ routeResult: "2026-09: $705,263.81 taken in total, retail and prescriptions together." })
      .where((await import("drizzle-orm")).eq(schema.inboxItems.id, "a2"));
    const a = await refusedAlert();
    assert.ok(a);
    assert.match(a.title, /2 reports/);
    assert.doesNotMatch(a.why, /System sales summary/);
  });
});
