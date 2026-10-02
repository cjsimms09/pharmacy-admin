import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * The three compliance alerts fire on their regression cases, through alerts() itself — not only through the pure
 * rules behind them. Each block in alerts.ts sits inside its own try/catch, so a refactor that breaks a reader
 * silences the alert without any test failing; these assert the rows positively, on a scratch database.
 *
 * The stage-4 gate of the rebuild (docs/REBUILD.md): "CQI, temps and CS alerts fire on their regression cases".
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let alerts: typeof import("../src/lib/alerts").alerts;
let newId: typeof import("../src/lib/crypto").newId;
let todayIso: typeof import("../src/lib/dates").todayIso;
let monthJustFinished: typeof import("../src/lib/monthly-checklist").monthJustFinished;
let currentCqiObligation: typeof import("../src/lib/cqi").currentCqiObligation;
let cleanup: () => void;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ alerts } = await import("../src/lib/alerts"));
  ({ newId } = await import("../src/lib/crypto"));
  ({ todayIso } = await import("../src/lib/dates"));
  ({ monthJustFinished } = await import("../src/lib/monthly-checklist"));
  ({ currentCqiObligation } = await import("../src/lib/cqi"));
});
after(() => cleanup());

describe("the controlled-substance inventory alert", () => {
  test("with no inventory on file, the site says so today", async () => {
    const a = (await alerts()).find((x) => x.key === "cs-inventory-never");
    assert.ok(a, "cs-inventory-never");
    assert.equal(a.level, "now");
  });
  test("an inventory 400 days old is overdue today; one 360 days old is due soon", async () => {
    const today = todayIso();
    const id = newId();
    await db.insert(schema.csInventories).values({ id, inventoryDate: addDays(today, -400), takenAt: "close", isKsAnnual: true, coversCii: true, coversCiiiV: true, participantIds: "[]", createdBy: "the test" });
    let list = await alerts();
    assert.ok(list.find((x) => x.key === "cs-inventory"), "cs-inventory, now");
    assert.equal(list.find((x) => x.key === "cs-inventory")?.level, "now");
    assert.equal(list.find((x) => x.key === "cs-inventory-never"), undefined);
    await db.update(schema.csInventories).set({ inventoryDate: addDays(today, -360) }).where((await import("drizzle-orm")).eq(schema.csInventories.id, id));
    list = await alerts();
    assert.ok(list.find((x) => x.key === "cs-inventory-soon"), "cs-inventory-soon");
    assert.equal(list.find((x) => x.key === "cs-inventory"), undefined);
    await db.update(schema.csInventories).set({ inventoryDate: addDays(today, -30) }).where((await import("drizzle-orm")).eq(schema.csInventories.id, id));
    list = await alerts();
    assert.equal(list.find((x) => x.key.startsWith("cs-inventory")), undefined, "a fresh inventory raises nothing");
  });
});

describe("the temperature sign-off alert", () => {
  test("a tracked sensor with readings in the month just finished and no sign-off is asked about; signed, it is not", async () => {
    const month = monthJustFinished(todayIso());
    const sensorId = newId();
    await db.insert(schema.tempSensors).values({ id: sensorId, externalId: "test-fridge-1", externalName: "fridge", name: "Vaccine fridge", kind: "refrigerator", tracked: true, minTenthsF: 360, maxTenthsF: 460 });
    await db.insert(schema.tempReadings).values([
      { id: newId(), sensorId, takenAt: `${month}-10T12:00:00.000Z`, periodKey: month, valueTenthsF: 400, excursion: false },
      { id: newId(), sensorId, takenAt: `${month}-11T12:00:00.000Z`, periodKey: month, valueTenthsF: 405, excursion: false },
    ]);
    let a = (await alerts()).find((x) => x.key === `temps-unsigned-${month}`);
    assert.ok(a, `temps-unsigned-${month}`);
    assert.ok(["now", "soon"].includes(a.level));
    await db.insert(schema.tempNotes).values({ id: newId(), sensorId, periodKey: month, readingId: null, note: "Reviewed by the test.", reviewed: true, writtenBy: "the test" });
    a = (await alerts()).find((x) => x.key === `temps-unsigned-${month}`);
    assert.equal(a, undefined, "signed off: nothing to ask");
  });
});

describe("the CQI summary alert", () => {
  test("the current period's summary is asked for inside thirty days of its due date, under its own key, and a final summary ends it", async () => {
    const today = todayIso();
    const { period } = await currentCqiObligation();
    const days = (Date.parse(`${period.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5;
    const key = `cqi-${period.periodStart}`;
    const a = (await alerts()).find((x) => x.key === key);
    if (days <= 30) {
      assert.ok(a, `${key} inside thirty days of ${period.dueOn}`);
      assert.match(a.title, /CQI summary/);
    } else {
      assert.equal(a, undefined, `${key} outside thirty days of ${period.dueOn}`);
    }
    await db.insert(schema.cqiSummaries).values({ id: newId(), periodStart: period.periodStart, periodEnd: period.periodEnd, dueOn: period.dueOn, isNullReport: true, status: "final", incidentIds: "[]", finalizedAt: new Date().toISOString(), finalizedBy: "the test" });
    assert.equal((await alerts()).find((x) => x.key === key), undefined, "filed and final: the period stops being asked for");
  });
});
