import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * The inspection list asks three questions about the certificates on the wall: the pharmacy registration, the DEA registration and the
 * CSOS certificate. Each is answered from the certificate in force, which is the one that runs the longest. A renewed registration is
 * filed as a new row beside the old one, and the first row the database hands back is the old one: read that, and the list says
 * "blocking" on the day a current certificate is on file.
 *
 * The numbers are invented and the dates are far from any day this runs, so the answers do not depend on when it does.
 */
describe("the inspection list reads the certificate in force", () => {
  let db: typeof import("../src/db").db;
  let schema: typeof import("../src/db").schema;
  let inspectionReport: typeof import("../src/lib/inspection").inspectionReport;
  let newId: typeof import("../src/lib/crypto").newId;
  let cleanup: () => void;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ db, schema } = await import("../src/db"));
    ({ inspectionReport } = await import("../src/lib/inspection"));
    ({ newId } = await import("../src/lib/crypto"));
    const { setSetting } = await import("../src/lib/settings");
    await setSetting("pharmacy_registration_number", "TEST-REG-1");
    await setSetting("pharmacy_dea", "TEST-DEA-1");
  });
  after(() => cleanup());
  beforeEach(async () => {
    await db.delete(schema.credentials);
  });

  type Held = (typeof schema.credentials.$inferInsert)["type"];
  const file = (type: Held, expiresOn: string | null) => db.insert(schema.credentials).values({ id: newId(), type, expiresOn });
  const asked = async (key: string) => {
    const check = (await inspectionReport()).checks.find((c) => c.key === key);
    assert.ok(check, `the list has no "${key}" question`);
    return check;
  };

  test("a registration renewed on a new row is read from the new row, whichever was filed first", async () => {
    await file("pharmacy_registration", "2020-06-30");
    await file("pharmacy_registration", "2099-06-30");
    let check = await asked("pharmacy_registration");
    assert.equal(check.state, "ready");
    assert.equal(check.answer, "Registration TEST-REG-1, current to 2099-06-30.");

    await db.delete(schema.credentials);
    await file("pharmacy_registration", "2099-06-30");
    await file("pharmacy_registration", "2020-06-30");
    check = await asked("pharmacy_registration");
    assert.equal(check.state, "ready");
    assert.equal(check.answer, "Registration TEST-REG-1, current to 2099-06-30.");
  });

  test("the DEA registration and the CSOS certificate are read the same way", async () => {
    await file("dea_registration", "2020-03-31");
    await file("dea_registration", "2099-03-31");
    await file("csos_certificate", "2020-03-31");
    await file("csos_certificate", "2099-03-31");
    const dea = await asked("dea_registration");
    assert.equal(dea.state, "ready");
    assert.equal(dea.answer, "TEST-DEA-1, current to 2099-03-31.");
    const csos = await asked("csos");
    assert.equal(csos.state, "ready");
    assert.equal(csos.answer, "On file, current to 2099-03-31.");
  });

  test("a registration that ran out with nothing after it is still blocking", async () => {
    await file("pharmacy_registration", "2020-06-30");
    assert.equal((await asked("pharmacy_registration")).state, "blocking");
  });

  test("a certificate somebody else holds is not the pharmacy's", async () => {
    const person = newId();
    await db.insert(schema.people).values({ id: person, firstName: "Test", lastName: "Person", role: "technician" });
    await db.insert(schema.credentials).values({ id: newId(), personId: person, type: "pharmacy_registration", expiresOn: "2099-06-30" });
    await file("pharmacy_registration", "2020-06-30");
    assert.equal((await asked("pharmacy_registration")).state, "blocking");
  });

  test("a row with no date beside a dated one is not the certificate read, in either order", async () => {
    await file("pharmacy_registration", null);
    await file("pharmacy_registration", "2099-06-30");
    let check = await asked("pharmacy_registration");
    assert.equal(check.state, "ready");
    assert.equal(check.answer, "Registration TEST-REG-1, current to 2099-06-30.");

    await db.delete(schema.credentials);
    await file("pharmacy_registration", "2099-06-30");
    await file("pharmacy_registration", null);
    check = await asked("pharmacy_registration");
    assert.equal(check.state, "ready");
    assert.equal(check.answer, "Registration TEST-REG-1, current to 2099-06-30.");
  });

  test("a row with no date does not hide a lapsed certificate beside it", async () => {
    await file("pharmacy_registration", "2020-06-30");
    await file("pharmacy_registration", null);
    assert.equal((await asked("pharmacy_registration")).state, "blocking");
  });

  test("a registration with no date anywhere says nothing can tell when it lapses", async () => {
    await file("pharmacy_registration", null);
    const check = await asked("pharmacy_registration");
    assert.equal(check.state, "gap");
    assert.match(check.answer, /no expiry date is on file/);
  });
});
