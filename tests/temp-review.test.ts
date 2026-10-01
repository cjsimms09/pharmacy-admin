import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * Nothing is imported at the top: both modules below open the database the moment they are first
 * imported, reading whatever `DATABASE_PATH` said at that instant. See `support/scratch-db.ts`.
 */
let unsignedTemperatureMonths: typeof import("../src/lib/temp-review").unsignedTemperatureMonths;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ unsignedTemperatureMonths } = await import("../src/lib/temp-review"));
  ({ db, schema } = await import("../src/db"));
});

after(() => cleanUpDb?.());

/**
 * Which finished months nobody has signed off.
 *
 * The readings arrive on their own; what makes them a record is somebody having reviewed the month
 * and said so. On 1 October 2026 the owner asked why nothing on the front page told him to sign the
 * September logs, and the answer was that no alert existed — `alerts.ts` had never mentioned
 * temperatures at all. This is the question that alert asks.
 *
 * The two ways it could be wrong both end in a false alarm, which is how an alert gets ignored: a
 * sensor nobody tracks, and a tracked sensor that recorded nothing. Neither is an unsigned month.
 */
describe("a month of temperatures nobody has signed off", () => {
  const sensor = async (name: string, tracked: boolean) => {
    const id = `s-${name.replace(/\W/g, "")}`;
    await db.insert(schema.tempSensors).values({ id, externalId: `x-${id}`, name, tracked, minTenthsF: 360, maxTenthsF: 460 });
    return id;
  };
  const reading = async (sensorId: string, periodKey: string, takenAt: string, tenths: number, excursion = false) =>
    db.insert(schema.tempReadings).values({ id: `r-${sensorId}-${takenAt}`, sensorId, periodKey, takenAt, valueTenthsF: tenths, excursion });
  const signOff = async (sensorId: string, periodKey: string) =>
    db.insert(schema.tempNotes).values({ id: `n-${sensorId}-${periodKey}`, sensorId, periodKey, note: "Reviewed.", reviewed: true, writtenBy: "Test" });

  before(async () => {
    const fridge = await sensor("Fridge", true);
    const room = await sensor("Room", true);
    const untracked = await sensor("Spare", false);
    const silent = await sensor("Silent", true);

    for (const s of [fridge, room, untracked]) {
      await reading(s, "2026-09", "2026-09-10T12:00:00.000Z", 400);
      await reading(s, "2026-09", "2026-09-20T12:00:00.000Z", 480, true);
      await reading(s, "2026-08", "2026-08-10T12:00:00.000Z", 400);
    }
    void silent; // tracked, and has never returned a reading

    /* The fridge's September was signed; the room's was not. August was signed for both. */
    await signOff(fridge, "2026-09");
    await signOff(fridge, "2026-08");
    await signOff(room, "2026-08");
  });

  test("a tracked sensor with readings and no sign-off is reported", async () => {
    const out = await unsignedTemperatureMonths("2026-09");
    assert.deepEqual(
      out.map((u) => u.name),
      ["Room"],
    );
  });

  test("it carries the figures the reviewer is being asked to look at", async () => {
    const [room] = await unsignedTemperatureMonths("2026-09");
    assert.equal(room.readings, 2);
    assert.equal(room.outOfRange, 1);
  });

  test("a month everybody signed reports nothing", async () => {
    assert.deepEqual(await unsignedTemperatureMonths("2026-08"), []);
  });

  /*
   * The two false alarms. A sensor nobody tracks is not part of the record, and a tracked sensor
   * that recorded nothing has nothing to review — that is a feed to look at, not a signature to
   * chase, and asking for one would be asking somebody to certify an empty page.
   */
  test("a sensor nobody tracks is never asked about, signed or not", async () => {
    const names = (await unsignedTemperatureMonths("2026-09")).map((u) => u.name);
    assert.ok(!names.includes("Spare"));
  });

  test("a tracked sensor that recorded nothing is not an unsigned month", async () => {
    const names = (await unsignedTemperatureMonths("2026-09")).map((u) => u.name);
    assert.ok(!names.includes("Silent"), "nothing was recorded, so there is nothing to sign");
  });

  test("a month nothing was recorded in at all reports nothing", async () => {
    assert.deepEqual(await unsignedTemperatureMonths("2026-07"), []);
  });

  /*
   * Readings are matched on the month they were filed under, not on a date range over the stamp.
   * The stamps are UTC and this pharmacy is six hours behind, so a range would take six hours of
   * 1 September into August and six of 1 October into September — and the sign-off note is keyed on
   * the same period key, so a mismatch would count readings the person signing never saw.
   */
  test("a reading filed under one month is not counted in another, whatever its stamp says", async () => {
    const late = await sensor("Boundary", true);
    /* Stamped in October, filed under September — which is what the local-time boundary produces. */
    await reading(late, "2026-09", "2026-10-01T02:00:00.000Z", 400);
    const sept = (await unsignedTemperatureMonths("2026-09")).find((u) => u.name === "Boundary");
    const oct = (await unsignedTemperatureMonths("2026-10")).find((u) => u.name === "Boundary");
    assert.equal(sept?.readings, 1);
    assert.equal(oct, undefined, "October filed nothing, so October has nothing to sign");
  });
});
