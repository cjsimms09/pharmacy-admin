import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * A line that could not answer when it was read, asked again.
 *
 * Measured on the real database, 16 September 2026: 588 invoice lines on file and exactly one
 * carrying a schedule, while the FDA directory could answer for 83 of them and registered 48 of
 * those as CII. The reading code was correct — run against those same rows it produced 82 answers —
 * so nothing in it was broken. The rows were simply read before the directory held those NDCs, and
 * nothing ever asked a second time.
 *
 * What that cost was not an empty column. `filingDisagrees` asks the one question a regulator cares
 * about — a Schedule II line on an invoice filed as ordinary — and it was reported clean across 588
 * lines of which 587 made no claim at all. A check asked of silence cannot fail. These cases exist
 * so it is asked of lines that can speak.
 */
let fillLineSchedules: typeof import("../src/lib/line-schedule-backfill").fillLineSchedules;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ fillLineSchedules } = await import("../src/lib/line-schedule-backfill"));
  ({ db, schema } = await import("../src/db"));

  await db.insert(schema.documents).values({
    id: "doc-bf", category: "invoice", title: "t", fileName: "t.pdf", mimeType: "application/pdf",
    sizeBytes: 1, sha256: "bf", storageKey: "x/bf", uploadedBy: "test",
  } as never);
  await db.insert(schema.supplierInvoices).values({
    id: "inv-bf", documentId: "doc-bf", supplier: "Testco", invoiceNumber: "BF-1",
    invoiceDate: "2026-09-15", totalCents: 1000, schedule: "schedule_2",
  } as never);

  /* The FDA's own spelling, which is what the directory actually holds — not "2". */
  const listed = (ndc11: string, deaSchedule: string) => ({
    ndc11,
    productNdc: `${ndc11.slice(0, 5)}-${ndc11.slice(5, 9)}`,
    genericName: "test substance",
    substances: "test substance",
    strength: "1 mg",
    form: "TABLET",
    route: "ORAL",
    labeler: "Testco Labs",
    marketingCategory: "ANDA",
    packageDescription: "100 TABLET in 1 BOTTLE",
    equivalenceKey: `test-${ndc11}`,
    deaSchedule,
  });
  await db.insert(schema.drugDirectory).values([
    listed("00000000001", "CII"),
    listed("00000000002", "CIV"),
    listed("00000000003", ""),
  ] as never);

  await db.insert(schema.invoiceLines).values([
    /* Read before the directory knew it: the shape this exists for. */
    { id: "l-stale", invoiceId: "inv-bf", supplier: "Testco", ndc11: "00000000001", description: "x", quantity: 1, unitCostCents: 100, extendedCents: 100 },
    { id: "l-four", invoiceId: "inv-bf", supplier: "Testco", ndc11: "00000000002", description: "x", quantity: 1, unitCostCents: 100, extendedCents: 100 },
    /* The directory lists it with no schedule, which is a fact: not controlled. */
    { id: "l-plain", invoiceId: "inv-bf", supplier: "Testco", ndc11: "00000000003", description: "x", quantity: 1, unitCostCents: 100, extendedCents: 100 },
    /* Nobody can answer for this one, and it must stay silent rather than be guessed at. */
    { id: "l-unknown", invoiceId: "inv-bf", supplier: "Testco", ndc11: "99999999999", description: "x", quantity: 1, unitCostCents: 100, extendedCents: 100 },
    /* Already answered by the strongest source there is; the backfill must not touch it. */
    { id: "l-held", invoiceId: "inv-bf", supplier: "Testco", ndc11: "00000000002", description: "x", quantity: 1, unitCostCents: 100, extendedCents: 100,
      controlled: true, deaSchedule: "schedule_2", deaScheduleFrom: "the invoice's own sections" },
  ] as never);
});

after(() => cleanUpDb?.());

const lineById = async (id: string) =>
  (await db.query.invoiceLines.findFirst({ where: (t, { eq }) => eq(t.id, id), columns: { deaSchedule: true, deaScheduleFrom: true, controlled: true } }))!;

describe("asking the lines again", () => {
  test("REGRESSION: a line the directory can now answer for stops being silent", async () => {
    const r = await fillLineSchedules();
    assert.equal(r.looked, 4, "the one already answered is not looked at again");
    assert.equal(r.filled, 3);

    const stale = await lineById("l-stale");
    assert.equal(stale.deaSchedule, "schedule_2", "CII is a Schedule II, spelled the FDA's way");
    assert.equal(stale.deaScheduleFrom, "the FDA directory");
    assert.equal(stale.controlled, true);
  });

  test("the lower schedules and the uncontrolled ones are answered too", async () => {
    assert.equal((await lineById("l-four")).deaSchedule, "schedule_3_5");
    assert.equal((await lineById("l-four")).controlled, false);
    assert.equal((await lineById("l-plain")).deaSchedule, "none", "listed with no schedule means not controlled");
  });

  test("a line nothing can answer for stays null, which is honest rather than failed", async () => {
    const unknown = await lineById("l-unknown");
    assert.equal(unknown.deaSchedule, null);
    assert.equal(unknown.deaScheduleFrom, null);
    assert.equal(unknown.controlled, null, "null is 'not said', never 'not controlled'");
  });

  test("REGRESSION: an answer already given by the invoice's own page is never overwritten", async () => {
    const held = await lineById("l-held");
    assert.equal(held.deaSchedule, "schedule_2");
    assert.equal(held.deaScheduleFrom, "the invoice's own sections", "the reader looking at the page beats a lookup");
  });

  test("running it twice changes nothing, so it is safe on a nightly beat", async () => {
    const again = await fillLineSchedules();
    assert.equal(again.looked, 1, "only the one nothing can answer for is still unanswered");
    assert.equal(again.filled, 0);
    assert.equal(again.stillSilent, 1);
  });

  test("it says which source answered, so a disagreement can be argued with", async () => {
    const r = await fillLineSchedules();
    assert.deepEqual(r.bySource, {}, "nothing left to fill");
    assert.equal(r.stillSilent, 1);
  });
});
