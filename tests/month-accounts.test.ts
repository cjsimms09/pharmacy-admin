import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { useScratchDb } from "./support/scratch-db";

/*
 * The month accounts are stored by the engine and read by the books. Measured 2 October 2026: one shared read was
 * 5.4 s and the books asked for four. These pin the rules: nothing stored means the caller computes as before; a pass
 * stores every in-books month on both bases; a second pass on the same inputs and day keeps the open month and every
 * closed month; a forced pass recomputes all; and what is read back is what was stored, with its "as of" sentence.
 */
describe("the month accounts are stored by the engine", () => {
  let done: () => void;
  before(async () => {
    done = await useScratchDb();
  });
  after(() => done());

  test("the in-books months through today, from the books' first month", async () => {
    const { inBooksMonthsThrough } = await import("../src/lib/engine/accounts");
    const { SITE_STARTS_ON } = await import("../src/lib/books-start");
    const first = SITE_STARTS_ON.slice(0, 7);
    assert.deepEqual(await inBooksMonthsThrough(`${first}-15`), [first]);
    const next = new Date(Date.parse(`${first}-01T00:00:00Z`));
    next.setUTCMonth(next.getUTCMonth() + 1);
    assert.deepEqual(await inBooksMonthsThrough(`${next.toISOString().slice(0, 7)}-02`), [first, next.toISOString().slice(0, 7)]);
  });

  test("nothing stored computes as before; a pass stores; the next pass keeps; a forced pass recomputes", async () => {
    const { readStoredAccounts, writeMonthAccounts } = await import("../src/lib/engine/accounts");
    const { accountsFor } = await import("../src/lib/profit-and-loss");
    const { SITE_STARTS_ON } = await import("../src/lib/books-start");
    const first = SITE_STARTS_ON.slice(0, 7);
    const today = `${first}-20`;
    assert.equal(await readStoredAccounts([first], "accrual"), null);
    const live = await accountsFor([first], "accrual");
    assert.equal((live as { stored?: unknown }).stored, undefined, "nothing stored: computed live, as before");

    const w1 = await writeMonthAccounts(today, `${today}T14:00:00.000Z`);
    assert.deepEqual(w1.computed.sort(), [`${first}|accrual`, `${first}|cash`]);
    const w2 = await writeMonthAccounts(today, `${today}T14:30:00.000Z`);
    assert.deepEqual(w2.computed, []);
    assert.equal(w2.kept.length, 2);
    const w3 = await writeMonthAccounts(today, `${today}T15:00:00.000Z`, { force: true });
    assert.equal(w3.computed.length, 2);

    const read = await readStoredAccounts([first], "cash");
    assert.ok(read);
    assert.equal(read.months.length, 1);
    assert.equal(read.months[0].basis, "cash");
    assert.match(read.months[0].caveats.join(" "), /as the engine computed them/);
    const viaAccounts = await accountsFor([first], "cash");
    assert.ok((viaAccounts as { stored?: { computedAt: string } }).stored, "the books now read the store");
  });
});

describe("a closed month follows a change at once, for the three most recent", () => {
  let done: () => void;
  before(async () => {
    done = await useScratchDb();
  });
  after(() => done());
  test("a bank line named in September on 2 October: the pass recomputes September, not only the open month", async () => {
    const { writeMonthAccounts } = await import("../src/lib/engine/accounts");
    const { SITE_STARTS_ON } = await import("../src/lib/books-start");
    const { audit } = await import("../src/lib/audit");
    const first = SITE_STARTS_ON.slice(0, 7);
    const next = new Date(Date.parse(`${first}-01T00:00:00Z`));
    next.setUTCMonth(next.getUTCMonth() + 1);
    const second = next.toISOString().slice(0, 7);
    const today = `${second}-02`;
    const w1 = await writeMonthAccounts(today, `${today}T14:00:00.000Z`);
    assert.ok(w1.computed.includes(`${second}|cash`), "the open month is stored");
    const w2 = await writeMonthAccounts(today, `${today}T14:10:00.000Z`);
    assert.deepEqual(w2.computed, [], "nothing moved: every month kept");
    /* The site's fingerprint is held for two seconds; a decision lands after that, as it would on the site. */
    await new Promise((r) => setTimeout(r, 2_100));
    await audit({ action: "bank.line_decided", userId: null, userName: "the test", entity: "bank_line", entityId: "x", details: "a cheque named as before the books" });
    const w3 = await writeMonthAccounts(today, `${today}T14:20:00.000Z`);
    assert.deepEqual(w3.computed.sort(), [`${first}|accrual`, `${first}|cash`, `${second}|accrual`, `${second}|cash`]);
  });
});
