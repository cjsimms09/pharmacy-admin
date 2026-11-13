import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * The fact sheet tells the manual's reviewer when the pharmacy's registration, its DEA registration and the pharmacist in charge's licence
 * expire. Each is read from the certificate in force, which is the one that runs the longest. A renewal filed as a new row leaves last
 * year's row beside it, and the first row the database hands back is that old one: reading it would tell the reviewer, in the pharmacy's
 * own voice, a date that has already passed while a current certificate is on file.
 *
 * Every number and date is invented, and the dates are far from any day this runs.
 */
describe("the fact sheet reads the certificate in force", () => {
  let db: typeof import("../src/db").db;
  let schema: typeof import("../src/db").schema;
  let pharmacyFacts: typeof import("../src/lib/pharmacy-facts").pharmacyFacts;
  let newId: typeof import("../src/lib/crypto").newId;
  let cleanup: () => void;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ db, schema } = await import("../src/db"));
    ({ pharmacyFacts } = await import("../src/lib/pharmacy-facts"));
    ({ newId } = await import("../src/lib/crypto"));
  });
  after(() => cleanup());
  beforeEach(async () => {
    await db.delete(schema.credentials);
    await db.delete(schema.people);
  });

  type Held = (typeof schema.credentials.$inferInsert)["type"];
  const file = (type: Held, expiresOn: string | null, number: string | null, personId: string | null = null) =>
    db.insert(schema.credentials).values({ id: newId(), type, expiresOn, number, personId });
  const missingWhat = async () => (await pharmacyFacts()).missing.map((m) => m.what);

  test("a registration renewed on a new row is told from the new row, in either order", async () => {
    await file("pharmacy_registration", "2020-06-30", "TEST-REG-1");
    await file("pharmacy_registration", "2099-06-30", "TEST-REG-2");
    let { text } = await pharmacyFacts();
    assert.match(text, /Kansas Board of Pharmacy registration TEST-REG-2, expiring 2099-06-30\./);
    assert.doesNotMatch(text, /TEST-REG-1|2020-06-30/);

    await db.delete(schema.credentials);
    await file("pharmacy_registration", "2099-06-30", "TEST-REG-2");
    await file("pharmacy_registration", "2020-06-30", "TEST-REG-1");
    ({ text } = await pharmacyFacts());
    assert.match(text, /registration TEST-REG-2, expiring 2099-06-30\./);
    assert.doesNotMatch(text, /TEST-REG-1|2020-06-30/);
  });

  test("the DEA registration is told the same way, and its expiry is not reported missing", async () => {
    await file("dea_registration", "2020-03-31", "TEST-DEA-1");
    await file("dea_registration", "2099-03-31", "TEST-DEA-2");
    const { text, missing } = await pharmacyFacts();
    assert.match(text, /DEA registration TEST-DEA-2, expiring 2099-03-31/);
    assert.doesNotMatch(text, /TEST-DEA-1|2020-03-31/);
    assert.ok(!missing.some((m) => m.what === "The expiry date on the DEA registration"));
  });

  test("a DEA row with no date beside a dated one does not hide the date", async () => {
    await file("dea_registration", null, "TEST-DEA-1");
    await file("dea_registration", "2099-03-31", "TEST-DEA-2");
    const { text } = await pharmacyFacts();
    assert.match(text, /DEA registration TEST-DEA-2, expiring 2099-03-31/);
    assert.ok(!(await missingWhat()).includes("The expiry date on the DEA registration"));
  });

  test("a DEA registration with no date anywhere is still reported as missing its date", async () => {
    await file("dea_registration", null, "TEST-DEA-1");
    assert.ok((await missingWhat()).includes("The expiry date on the DEA registration"));
  });

  test("the pharmacist in charge's licence is told from the one that runs the longest", async () => {
    const pic = newId();
    await db.insert(schema.people).values({ id: pic, firstName: "Test", lastName: "Pharmacist", role: "pharmacist", isPic: true });
    await file("pharmacist_license", "2020-12-31", "TEST-LIC-1", pic);
    await file("pharmacist_license", "2099-12-31", "TEST-LIC-2", pic);
    const { text } = await pharmacyFacts();
    assert.match(text, /The pharmacist in charge is Test Pharmacist, Kansas pharmacist licence TEST-LIC-2, expiring 2099-12-31\./);
    assert.doesNotMatch(text, /TEST-LIC-1|2020-12-31/);
  });

  test("a certificate somebody else holds is not the pharmacy's", async () => {
    const person = newId();
    await db.insert(schema.people).values({ id: person, firstName: "Test", lastName: "Technician", role: "technician" });
    await file("pharmacy_registration", "2099-06-30", "TEST-REG-9", person);
    await file("pharmacy_registration", "2020-06-30", "TEST-REG-1");
    const { text } = await pharmacyFacts();
    assert.match(text, /registration TEST-REG-1, expiring 2020-06-30\./);
  });
});
