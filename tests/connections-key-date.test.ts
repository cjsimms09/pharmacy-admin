import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keyMadeOnProblem } from "../src/lib/feed-rules";

/*
 * The day a facilitator (MTF) key was made, and who can write it.
 *
 * Found 7 October 2026 reading what the live site holds: a key is stored and no day is on record for it, so nothing could count
 * how long the key has left, and CMS ends a key 90 days after it is made without telling anyone. The site stamps the day when a key
 * is stored here, but a key stored before that stamp existed has none. The Connections page therefore takes the day by hand, and
 * these pin the three places it can go wrong: what the form accepts, what storing and removing a key do to the day, and whether
 * the card the feed sends him to is on the page.
 *
 * Every key and date here is invented.
 */
let connections: typeof import("../src/lib/connections");
let getSettings: typeof import("../src/lib/settings").getSettings;
let setSetting: typeof import("../src/lib/settings").setSetting;
let cleanUpDb: (() => void) | null = null;
let hadEncryptionKey: string | undefined;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  hadEncryptionKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  connections = await import("../src/lib/connections");
  ({ getSettings, setSetting } = await import("../src/lib/settings"));
});

after(() => {
  if (hadEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = hadEncryptionKey;
  cleanUpDb?.();
});

const utcToday = () => new Date().toISOString().slice(0, 10);
const hasMtfCard = async () => (await connections.connectionState()).some((c) => c.id === "mtf");

describe("the day a key was made, as the Connections page keeps it", () => {
  test("storing a key records today as the day it was made, over any day left from an older key", async () => {
    await setSetting("mtf_key_set_on", "2026-01-15");
    const from = utcToday();
    await connections.saveSecret("mtf", "invented-key-0001");
    const to = utcToday();
    const stamped = (await getSettings()).mtf_key_set_on;
    assert.ok(stamped === from || stamped === to, `stamped ${stamped}, not the day from the older key`);
  });

  test("removing the key removes its day, so a key stored later is not counted from the old one", async () => {
    await connections.saveSecret("mtf", "invented-key-0002");
    await connections.clearSecret("mtf");
    const s = await getSettings();
    assert.equal(s.mtf_api_key_enc ?? "", "");
    assert.equal(s.mtf_key_set_on ?? "", "");
  });

  test("the form is filled in with the day on record, so saving another field does not blank it", async () => {
    await setSetting("mtf_key_set_on", "2026-08-15");
    await setSetting("feature_reimbursement", "yes");
    const card = (await connections.connectionState()).find((c) => c.id === "mtf");
    assert.ok(card, "the facilitator's card is listed");
    assert.equal(card.values.mtf_key_set_on, "2026-08-15");
  });

  test("the day's field is the one the feed counts with: what it refuses, the feed could not count from", () => {
    const field = connections.CONNECTIONS.find((c) => c.id === "mtf")?.fields.find((f) => f.key === "mtf_key_set_on");
    assert.ok(field, "the facilitator has a field for the day its key was made");
    assert.equal(field.check, keyMadeOnProblem);
  });
});

describe("the facilitator's card is on the page whenever the feed's sentence can send him to it", () => {
  test("hidden with the reimbursement work off and no key stored", async () => {
    await connections.clearSecret("mtf");
    await setSetting("feature_reimbursement", "no");
    assert.equal(await hasMtfCard(), false);
  });

  test("shown with the reimbursement work on", async () => {
    await setSetting("feature_reimbursement", "yes");
    assert.equal(await hasMtfCard(), true);
  });

  test("REGRESSION: shown with the reimbursement work off and a key stored, because the feed says how old that key is and where to fix it", async () => {
    await setSetting("feature_reimbursement", "no");
    await connections.saveSecret("mtf", "invented-key-0003");
    assert.equal(await hasMtfCard(), true);
  });
});

describe("the page's save, read from its source", () => {
  const source = fs.readFileSync(new URL("../src/app/(app)/settings/connections/page.tsx", import.meta.url), "utf8");

  test("every field is checked before any is saved, so one bad entry does not leave the form half saved", () => {
    const checked = source.indexOf(".check?.(");
    const firstSaved = source.indexOf("await setSetting(");
    assert.ok(checked > 0, "the page asks each field's check");
    assert.ok(firstSaved > 0, "the page saves the plain fields");
    assert.ok(checked < firstSaved, "the check comes first");
  });

  test("the plain fields save before a pasted key, so a key pasted with a typed day is counted from today", () => {
    const fields = source.indexOf("await setSetting(");
    const key = source.indexOf("await saveSecret(");
    assert.ok(key > 0, "the page stores a pasted key");
    assert.ok(fields < key, "plain fields first, then the key, which stamps today");
  });

  test("a box is checked as it will be saved, with stray spaces taken off, so a day pasted with a space after it is not refused", () => {
    const checkedAs = /\.check\?\.\((v(?:\.trim\(\))?)\)/.exec(source)?.[1];
    const savedAs = /await setSetting\(f\.key as SettingKey, (v(?:\.trim\(\))?)\)/.exec(source)?.[1];
    assert.equal(savedAs, "v.trim()", "the page saves a box with its stray spaces taken off");
    assert.equal(checkedAs, savedAs, "the page checks what it will save, not what was typed");
  });
});
