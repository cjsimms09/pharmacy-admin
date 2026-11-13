import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq, or } from "drizzle-orm";
import { readRenewal, renewalMissing, type HeldCertificate } from "../src/lib/renewal-cover";

/*
 * When the certificate on file shows a renewal duty done: a period is covered when a pharmacy certificate of the type runs past the end of
 * the period, and a period nothing covers is late once the date the certificate on file runs to has passed. Every date here is invented;
 * the one rule taken from life is that the Kansas registration runs to a 30 June.
 */

const KS = "pharmacy_registration";
const DEA = "dea_registration";
const cert = (type: string, expiresOn: string | null, noExpiry = false): HeldCertificate => ({ type, expiresOn, noExpiry });

describe("readRenewal: whether the certificate on file covers a period", () => {
  test("a certificate that runs past the end of the year covers it", () => {
    const r = readRenewal(KS, "2026", [cert(KS, "2027-06-30")]);
    assert.deepEqual(r, { covered: true, onFile: true, runsTo: "2027-06-30" });
  });

  test("one that runs out on the last day of the year does not: the renewal falling due inside the year is still to do", () => {
    assert.equal(readRenewal(KS, "2026", [cert(KS, "2026-12-31")]).covered, false);
    assert.equal(readRenewal(KS, "2026", [cert(KS, "2027-01-01")]).covered, true);
  });

  // The Add and Edit forms on Licences have no "does not expire" box, so only a row set some other way reaches this; it pins the rule for one.
  test("a certificate marked as never expiring covers every period", () => {
    for (const p of ["2026", "2027", "2040"]) assert.equal(readRenewal(DEA, p, [cert(DEA, null, true)]).covered, true);
  });

  test("a row with no date, and not marked as never expiring, covers nothing: a blank date means nobody entered one", () => {
    assert.deepEqual(readRenewal(KS, "2026", [cert(KS, null)]), { covered: false, onFile: true, runsTo: null });
  });

  test("nothing on file covers nothing and says it is not on file", () => {
    assert.deepEqual(readRenewal(KS, "2026", []), { covered: false, onFile: false, runsTo: null });
  });

  test("another registration's certificate covers nothing here", () => {
    const r = readRenewal(KS, "2026", [cert(DEA, "2031-03-31"), cert(DEA, null, true)]);
    assert.deepEqual(r, { covered: false, onFile: false, runsTo: null });
  });

  test("a renewal is a new row beside last year's, and the latest date decides whichever order they come in", () => {
    const rows = [cert(KS, "2026-06-30"), cert(KS, "2027-06-30")];
    assert.equal(readRenewal(KS, "2026", rows).runsTo, "2027-06-30");
    assert.equal(readRenewal(KS, "2026", [...rows].reverse()).runsTo, "2027-06-30");
    assert.equal(readRenewal(KS, "2026", rows).covered, true);
    assert.equal(readRenewal(KS, "2027", rows).covered, false);
  });

  test("a certificate that ran out before the period does not cover it, and its date is the one reported as where it runs to", () => {
    const r = readRenewal(KS, "2026", [cert(KS, "2020-06-30")]);
    assert.equal(r.covered, false);
    assert.equal(r.runsTo, "2020-06-30");
  });
});

describe("renewalMissing: what he reads under a duty the certificate does not cover", () => {
  const sentence = (held: HeldCertificate[]) => renewalMissing("Kansas pharmacy registration", "2026", readRenewal(KS, "2026", held));

  test("nothing on file says to file it, with its date", () => {
    assert.equal(sentence([]), "No Kansas pharmacy registration is on file. File it under Licences, with the date it expires.");
  });

  test("a certificate with no date says what cannot be told, and where to add it", () => {
    assert.equal(sentence([cert(KS, null)]), "The Kansas pharmacy registration on file has no expiry date, so what it covers cannot be told. Add the date under Licences.");
  });

  test("a certificate that does not reach says the date it runs to and what has to be filed", () => {
    assert.equal(
      sentence([cert(KS, "2020-06-30")]),
      "The Kansas pharmacy registration on file runs to June 30, 2020. It has to run past the end of 2026 before this closes: file the renewed certificate under Licences, with its new expiry date.",
    );
  });
});

describe("the renewal duties, read through openItems() against the certificates on file", () => {
  let db: typeof import("../src/db").db;
  let schema: typeof import("../src/db").schema;
  let openItems: typeof import("../src/lib/compliance-status").openItems;
  let openStates: typeof import("../src/lib/compliance-status").openStates;
  let comingSentence: typeof import("../src/lib/compliance-status").comingSentence;
  let newId: typeof import("../src/lib/crypto").newId;
  let cleanup: () => void;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ db, schema } = await import("../src/db"));
    ({ openItems, openStates, comingSentence } = await import("../src/lib/compliance-status"));
    ({ newId } = await import("../src/lib/crypto"));
    const { ensureObligations } = await import("../src/lib/obligations");
    await ensureObligations();
    // The register counts from the earliest obligation, so the scratch ones have to begin before the dates under test.
    await db.update(schema.obligations).set({ createdAt: "2026-09-03T12:00:00.000Z" });
    await db
      .update(schema.obligations)
      .set({ needsConfirmation: false, confirmedOn: null })
      .where(or(eq(schema.obligations.seedKey, "ks_pharmacy_registration"), eq(schema.obligations.seedKey, "dea_registration"), eq(schema.obligations.seedKey, "fwa_training")));
    // Every test below that expects nothing to be listed would pass just as well if the two renewal duties did not exist.
    const duties = await db
      .select()
      .from(schema.obligations)
      .where(or(eq(schema.obligations.seedKey, "ks_pharmacy_registration"), eq(schema.obligations.seedKey, "dea_registration")));
    assert.deepEqual(duties.map((d) => `${d.seedKey} ${d.kind} ${d.active}`).sort(), ["dea_registration renewal true", "ks_pharmacy_registration renewal true"]);
  });
  after(() => cleanup());
  beforeEach(async () => {
    await db.delete(schema.credentials);
  });

  const held = (type: typeof KS | typeof DEA, expiresOn: string | null, noExpiry = false) =>
    db.insert(schema.credentials).values({ id: newId(), type, expiresOn, noExpiry });
  const renewals = async (today: string) => (await openItems(today)).filter((i) => i.seedKey === "ks_pharmacy_registration" || i.seedKey === "dea_registration");
  const brief = (items: Awaited<ReturnType<typeof renewals>>) => items.map((i) => `${i.seedKey} ${i.periodKey} ${i.state} ${i.dueOn}`);

  test("certificates that run past the year leave nothing to do for it", async () => {
    await held(KS, "2027-06-30");
    await held(DEA, "2031-03-31");
    assert.deepEqual(brief(await renewals("2026-10-07")), []);
  });

  test("on 1 January 2027 the registration on file is not a missed 2026, and 2027 waits for its own date", async () => {
    await held(KS, "2027-06-30");
    await held(DEA, "2031-03-31");
    assert.deepEqual(brief(await renewals("2027-01-01")), ["ks_pharmacy_registration 2027 open 2027-06-30"]);
  });

  test("on the day the certificate runs out the renewal is due and not late; the next day it is missed, by one day", async () => {
    await held(KS, "2027-06-30");
    await held(DEA, "2031-03-31");
    assert.deepEqual(brief(await renewals("2027-06-30")), ["ks_pharmacy_registration 2027 open 2027-06-30"]);
    const [late, ...rest] = await renewals("2027-07-01");
    assert.equal(rest.length, 0);
    assert.equal(`${late.seedKey} ${late.periodKey} ${late.state} ${late.dueOn}`, "ks_pharmacy_registration 2027 missed 2027-06-30");
    assert.equal(late.daysLate, 1);
  });

  test("a certificate that runs out on the last day of the year: due that day, then one lapse that shows as two missed years", async () => {
    await held(KS, "2026-12-31");
    await held(DEA, "2031-03-31");
    assert.deepEqual(brief(await renewals("2026-12-31")), ["ks_pharmacy_registration 2026 open 2026-12-31"]);
    // 2027 is uncovered as well, and the only date there is to measure it from is the one the certificate ran out on.
    assert.deepEqual(brief(await renewals("2027-01-01")), [
      "ks_pharmacy_registration 2026 missed 2026-12-31",
      "ks_pharmacy_registration 2027 missed 2026-12-31",
    ]);
  });

  test("the register reads the list's state for a period: a renewal that is late there is late there, and a covered period is not listed", async () => {
    await held(KS, "2027-06-30");
    await held(DEA, "2031-03-31");
    const ks = await db.query.obligations.findFirst({ where: eq(schema.obligations.seedKey, "ks_pharmacy_registration") });
    assert.ok(ks, "the Kansas registration duty exists");
    // Worked out from the filings alone, a period that has not ended is "open" whatever its certificate says; the list knows better.
    const states = openStates(await openItems("2027-07-02"));
    assert.equal(states.get(`${ks.id}|2027`), "missed");
    assert.equal(states.get(`${ks.id}|2026`), undefined);
  });

  test("Today's quiet list says what is on file for a renewal that is open, and does not promise that nothing counts until the year ends", async () => {
    await held(KS, "2027-06-30");
    await held(DEA, "2031-03-31");
    const [ks, ...rest] = await renewals("2027-03-01");
    assert.equal(rest.length, 0);
    assert.equal(`${ks.periodKey} ${ks.state} ${ks.dueOn}`, "2027 open 2027-06-30");
    // From 1 July the same period is late, nine months before its year ends.
    assert.equal(
      comingSentence(ks),
      "2027 — The Kansas pharmacy registration on file runs to June 30, 2027. It has to run past the end of 2027 before this closes: file the renewed certificate under Licences, with its new expiry date.",
    );
  });

  test("every other kind of open item keeps its sentence, because its date is the end of its period", () => {
    assert.equal(
      comingSentence({ kind: "attest", periodLabel: "October 2026", missing: null }),
      "October 2026. Not late, and will not count against you until the period ends.",
    );
  });

  test("after the date on the certificate with nothing renewed it is missed, by the days since that date", async () => {
    await held(KS, "2027-06-30");
    await held(DEA, "2031-03-31");
    const [late] = await renewals("2027-07-02");
    assert.equal(`${late.seedKey} ${late.periodKey} ${late.state} ${late.dueOn}`, "ks_pharmacy_registration 2027 missed 2027-06-30");
    assert.equal(late.daysLate, 2);
  });

  test("filing the renewed certificate as a new row, beside the old one, closes it", async () => {
    await held(KS, "2027-06-30");
    await held(KS, "2028-06-30");
    await held(DEA, "2031-03-31");
    assert.deepEqual(brief(await renewals("2027-07-02")), []);
  });

  test("a registration that ran out years ago is due since then, points to Licences and says what to file", async () => {
    await held(KS, "2020-06-30");
    await held(DEA, "2031-03-31");
    const [item, ...rest] = await renewals("2026-10-07");
    assert.equal(rest.length, 0);
    assert.equal(`${item.seedKey} ${item.periodKey} ${item.state} ${item.dueOn}`, "ks_pharmacy_registration 2026 missed 2020-06-30");
    assert.equal(item.href, "/licenses");
    assert.match(item.missing ?? "", /runs to June 30, 2020\. It has to run past the end of 2026/);
    assert.ok(item.daysLate > 2000, `late since 2020, got ${item.daysLate} days`);
  });

  test("a certificate with no date is not cover, and the sentence says no date is on it", async () => {
    await held(KS, null);
    await held(DEA, "2031-03-31");
    const [item] = await renewals("2026-10-07");
    assert.equal(`${item.seedKey} ${item.state}`, "ks_pharmacy_registration missed");
    assert.match(item.missing ?? "", /has no expiry date/);
  });

  // As above: no form on Licences makes a pharmacy certificate "does not expire", so this is the rule for a row set some other way.
  test("one marked as never expiring is cover", async () => {
    await held(KS, null, true);
    await held(DEA, "2031-03-31");
    assert.deepEqual(brief(await renewals("2026-10-07")), []);
  });

  test("nothing on file at all is a duty to file it: the KS date has gone, the DEA one has not", async () => {
    const found = await renewals("2026-10-07");
    assert.deepEqual(brief(found), ["ks_pharmacy_registration 2026 missed 2026-06-30", "dea_registration 2026 open 2026-12-31"]);
    assert.match(found[0].missing ?? "", /^No Kansas pharmacy registration is on file\./);
    assert.match(found[1].missing ?? "", /^No DEA registration is on file\./);
    assert.deepEqual(found.map((i) => i.href), ["/licenses", "/licenses"]);
  });

  test("a duty whose date is the end of its year is not made late early", async () => {
    const fwa = (await openItems("2026-10-07")).filter((i) => i.seedKey === "fwa_training");
    assert.deepEqual(fwa.map((i) => `${i.periodKey} ${i.state} ${i.dueOn}`), ["2026 open 2026-12-31"]);
  });

  test("a year part done stays part done once it has ended: only a duty still open past its own date is made late", async () => {
    // No seeded duty wants more than one a period, so the part-done year is made by hand here.
    const id = newId();
    await db.insert(schema.obligations).values({ id, seedKey: null, title: "A duty that wants two a year", cadence: "annual", expectedPerPeriod: 2, createdAt: "2026-09-03T12:00:00.000Z" });
    await db.insert(schema.obligationCompletions).values({ id: newId(), obligationId: id, periodKey: "2026", completedOn: "2026-10-01", completedBy: "the test" });
    try {
      const found = (await openItems("2027-01-02")).filter((i) => i.obligationId === id);
      assert.deepEqual(found.map((i) => `${i.periodKey} ${i.state} ${i.have}/${i.expected}`), ["2026 partial 1/2", "2027 open 0/2"]);
    } finally {
      await db.delete(schema.obligationCompletions).where(eq(schema.obligationCompletions.obligationId, id));
      await db.delete(schema.obligations).where(eq(schema.obligations.id, id));
    }
  });
});
