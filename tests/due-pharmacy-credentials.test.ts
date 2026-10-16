import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * The due list names one thing to renew for each certificate the pharmacy holds: the one in force. A registration renewed on a new row
 * leaves last year's row beside it, and that row owes nothing; listing it would keep a renewed registration "overdue" on Today for as
 * long as the old row is kept. Two rows are the same kind the way the Licences page counts them (type and label), and the one in force
 * is the one that runs the longest, so the list and that page cannot disagree about which certificate is the pharmacy's.
 *
 * The dates are far from any day this runs (2020 is over, 2098 and 2099 are not), so the answers do not depend on when it does.
 */
describe("the due list names the pharmacy's certificate in force, not every row it has kept", () => {
  let db: typeof import("../src/db").db;
  let schema: typeof import("../src/db").schema;
  let dueList: typeof import("../src/lib/due").dueList;
  let newId: typeof import("../src/lib/crypto").newId;
  let cleanup: () => void;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ db, schema } = await import("../src/db"));
    ({ dueList } = await import("../src/lib/due"));
    ({ newId } = await import("../src/lib/crypto"));
  });
  after(() => cleanup());
  beforeEach(async () => {
    await db.delete(schema.credentials);
  });

  type Held = (typeof schema.credentials.$inferInsert)["type"];
  const file = async (type: Held, expiresOn: string | null, more: { noExpiry?: boolean; label?: string; number?: string } = {}) => {
    const id = newId();
    await db.insert(schema.credentials).values({ id, type, expiresOn, ...more });
    return id;
  };
  /** What the list says about the pharmacy's own certificates of one kind that carry a date (not the "nothing on file" lines). */
  const listed = async (type: Held) => {
    const rows = await dueList({ horizonDays: 100000 });
    const prefix = type === "pharmacy_registration" ? "Kansas pharmacy registration" : type === "dea_registration" ? "DEA registration" : "Professional liability insurance";
    return rows.filter((r) => r.personId === null && r.dueOn !== null && r.title.startsWith(prefix));
  };

  test("a registration renewed on a new row owes nothing on the old one, whichever row was filed first", async () => {
    await file("pharmacy_registration", "2020-06-30");
    const renewed = await file("pharmacy_registration", "2099-06-30");
    let items = await listed("pharmacy_registration");
    assert.deepEqual(items.map((i) => i.id), [`cred-${renewed}`]);
    assert.equal(items[0].dueOn, "2099-06-30");
    assert.notEqual(items[0].severity, "overdue");

    await db.delete(schema.credentials);
    const renewedFirst = await file("pharmacy_registration", "2099-06-30");
    await file("pharmacy_registration", "2020-06-30");
    items = await listed("pharmacy_registration");
    assert.deepEqual(items.map((i) => i.id), [`cred-${renewedFirst}`]);
  });

  test("a registration that ran out with nothing after it is overdue, and says where to renew it", async () => {
    const id = await file("pharmacy_registration", "2020-06-30");
    const items = await listed("pharmacy_registration");
    assert.deepEqual(items.map((i) => i.id), [`cred-${id}`]);
    assert.equal(items[0].severity, "overdue");
    assert.equal(items[0].href, "/licenses", "a file put under Documents makes no credential row for the pharmacy, so that cannot be the place");
    assert.match(items[0].action, /Licences/);
  });

  test("a renewal filed early, while the old one still runs, lists the new one only", async () => {
    await file("dea_registration", "2098-03-31");
    const renewed = await file("dea_registration", "2099-03-31");
    const items = await listed("dea_registration");
    assert.deepEqual(items.map((i) => i.id), [`cred-${renewed}`]);
    assert.equal(items[0].dueOn, "2099-03-31");
  });

  test("a row with no date beside a dated one does not become the certificate in force", async () => {
    await file("pharmacy_registration", null);
    const dated = await file("pharmacy_registration", "2020-06-30");
    const items = await listed("pharmacy_registration");
    assert.deepEqual(items.map((i) => i.id), [`cred-${dated}`], "the dated row is read, in whichever order the rows come");
    assert.equal(items[0].severity, "overdue");
  });

  test("a certificate said to have no expiry is not chased, even beside a lapsed row and even with a stale date left on it", async () => {
    await file("pharmacy_registration", "2020-06-30");
    await file("pharmacy_registration", "2020-01-01", { noExpiry: true });
    assert.deepEqual(await listed("pharmacy_registration"), []);
  });

  test("two certificates of one type with different labels are two kinds, as the Licences page counts them", async () => {
    const lapsedA = await file("liability_insurance", "2020-01-01", { label: "Professional" });
    const lapsedB = await file("liability_insurance", "2020-01-01", { label: "Professional" });
    const current = await file("liability_insurance", "2099-01-01", { label: "General" });
    const items = await listed("liability_insurance");
    const ids = items.map((i) => i.id);
    assert.ok(ids.includes(`cred-${current}`), "the other kind's certificate is listed");
    assert.equal(ids.length, 2, "one item for each kind");
    assert.equal(ids.filter((id) => id === `cred-${lapsedA}` || id === `cred-${lapsedB}`).length, 1, "the lapsed kind is listed once, not once per row kept");
    assert.equal(items.filter((i) => i.severity === "overdue").length, 1, "and the lapsed kind is the overdue one");
  });

  test("the certificate's number is shown with it", async () => {
    await file("pharmacy_registration", "2099-06-30", { number: "TEST-REG-1" });
    const items = await listed("pharmacy_registration");
    assert.equal(items[0].title, "Kansas pharmacy registration (TEST-REG-1)");
  });

  test("a type with no row at all is still said to have nothing on file, and stops being said once a row is filed", async () => {
    let rows = await dueList({ horizonDays: 100000 });
    assert.ok(rows.some((r) => r.id === "cred-missing-pharmacy-pharmacy_registration"));
    await file("pharmacy_registration", "2099-06-30");
    rows = await dueList({ horizonDays: 100000 });
    assert.ok(!rows.some((r) => r.id === "cred-missing-pharmacy-pharmacy_registration"));
  });
});
