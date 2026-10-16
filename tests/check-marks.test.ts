import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { eq, sql } from "drizzle-orm";

/*
 * What he says of the morning check's findings, kept in a database (rule 4 of CLAUDE.md).
 *
 * The pure half (which marks cover which findings) is pinned in daily-check.test.ts. This is the half that writes and reads: that a press
 * is recorded against the finding he was shown and no other, that it comes off when the facts change or the check passes, that nothing is
 * ever deleted so the count of wrong alarms cannot shrink, and that a record that cannot be read never hides an alarm. A fresh database
 * fails two checks, and they are the ones used: the rebate statement (nothing standing) and the mailbox (never swept). Every name and
 * figure is invented.
 */
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let dailyCheck: typeof import("../src/lib/daily-check-store").dailyCheck;
let markShown: typeof import("../src/lib/daily-check-store").markShown;
let marks: typeof import("../src/lib/check-marks");
let cleanup: () => void;

const OWNER = { id: "user-invented", name: "Invented Owner" };
const NEVER = "never|clean|-|-";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  ({ dailyCheck, markShown } = await import("../src/lib/daily-check-store"));
  marks = await import("../src/lib/check-marks");
});
after(() => cleanup());
beforeEach(async () => {
  await db.delete(schema.checkMarks);
  await db.delete(schema.settings).where(eq(schema.settings.key, "mail_last_sweep"));
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const sweptAt = (iso: string) => db.insert(schema.settings).values({ key: "mail_last_sweep", value: iso });
const rows = () => db.select().from(schema.checkMarks);
const openKeys = async () => (await dailyCheck()).open.map((c) => c.key).sort();
const refused = async (p: Promise<unknown>, message: RegExp) => {
  await assert.rejects(p, message);
  assert.equal((await rows()).length, 0, "a refused press must leave nothing behind");
};

describe("a press covers the finding he was shown", () => {
  test("a fresh database fails the two checks this file uses, as it says it does", async () => {
    const r = await dailyCheck();
    assert.deepEqual(await openKeys(), ["mailbox-swept", "rebate-statement"]);
    assert.equal(r.checks.find((c) => c.key === "mailbox-swept")!.fingerprint, NEVER);
    assert.equal(r.failing, 2);
    assert.deepEqual(r.setAside, []);
  });

  test("settled sets the line aside, the count of failing lines falls, and the stored sentence still counts it as failing", async () => {
    await markShown("mailbox-swept", NEVER, "settled", "swept by hand this morning", OWNER);
    const r = await dailyCheck();
    assert.deepEqual(await openKeys(), ["rebate-statement"]);
    assert.deepEqual(r.setAside.map((s) => s.check.key), ["mailbox-swept"]);
    assert.equal(r.setAside[0].mark.verdict, "settled");
    assert.equal(r.setAside[0].mark.by, OWNER.name);
    assert.equal(r.failing, 1);
    assert.match(r.says, /^2 of 10 failing \(1 set aside\)\./);
    assert.ok(!("notMeasured" in r.wrongAlarms), "the count was read");
    assert.equal(r.wrongAlarms.total, 0, "settled is not a wrong alarm");
  });

  test("what he was shown is kept with the press: the rule, the finding, his note, who and when", async () => {
    await markShown("mailbox-swept", NEVER, "wrong", "  it was swept at six  ", OWNER);
    const [row] = await rows();
    assert.equal(row.what, "The mailbox is being swept");
    assert.equal(row.observed, "never swept");
    assert.equal(row.note, "it was swept at six");
    assert.equal(row.markedBy, OWNER.name);
    assert.equal(row.endedAt, null);
    assert.ok(Math.abs(Date.parse(row.markedAt) - Date.now()) < 60_000);
  });

  test("a note is kept to 500 characters, a blank one is kept as none, and its lines and runs of spaces become single spaces", async () => {
    await markShown("mailbox-swept", NEVER, "settled", "x".repeat(900), OWNER);
    assert.equal((await rows())[0].note!.length, 500);
    await markShown("mailbox-swept", NEVER, "wrong", "   ", OWNER);
    const [blank] = (await rows()).filter((r) => r.endedAt === null);
    assert.equal(blank.note, null);
    await markShown("mailbox-swept", NEVER, "settled", "  it was swept\n\nat six,   by hand\t", OWNER);
    const [typed] = (await rows()).filter((r) => r.endedAt === null);
    assert.equal(typed.note, "it was swept at six, by hand");
  });

  test("a press and a taking-back are each written to the audit log, by name", async () => {
    await markShown("mailbox-swept", NEVER, "wrong", "", OWNER);
    const [{ id }] = await rows();
    await marks.putBack(id, OWNER);
    const log = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, id));
    assert.deepEqual(log.map((e) => e.action).sort(), ["check.mark", "check.put-back"]);
    assert.ok(log.every((e) => e.entity === "check_marks" && e.userName === OWNER.name && e.userId === OWNER.id));
  });
});

describe("the same press made twice is one press", () => {
  test("the same verdict on the same finding is recorded once, counted once, written to the audit log once, and said to be already there", async () => {
    assert.deepEqual(await markShown("mailbox-swept", NEVER, "wrong", "first", OWNER), { already: false });
    assert.deepEqual(await markShown("mailbox-swept", NEVER, "wrong", "second", OWNER), { already: true });
    const all = await rows();
    assert.equal(all.length, 1);
    assert.equal(all[0].note, "first");
    assert.equal((await marks.wrongAlarms()).total, 1, "a double click is one wrong alarm, not two");
    const log = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, all[0].id));
    assert.equal(log.length, 1);
  });

  test("two presses that arrive together are one press", async () => {
    const [a, b] = await Promise.all([
      markShown("mailbox-swept", NEVER, "wrong", "", OWNER),
      markShown("mailbox-swept", NEVER, "wrong", "", OWNER),
    ]);
    assert.deepEqual([a.already, b.already].sort(), [false, true]);
    assert.equal((await rows()).length, 1);
    assert.equal((await marks.wrongAlarms()).total, 1);
  });

  test("a press taken back and made again is a second press: the first row stays and both count", async () => {
    await markShown("mailbox-swept", NEVER, "wrong", "", OWNER);
    const [{ id }] = await rows();
    await marks.putBack(id, OWNER);
    assert.deepEqual(await markShown("mailbox-swept", NEVER, "wrong", "", OWNER), { already: false });
    assert.equal((await rows()).length, 2);
    assert.equal((await marks.wrongAlarms()).total, 2, "the screen counts presses, and he pressed twice");
  });
});

describe("a mark ends when it no longer covers anything, and nothing is ever deleted", () => {
  test("when the facts change the line comes back and the mark ends as changed", async () => {
    await markShown("mailbox-swept", NEVER, "settled", "", OWNER);
    assert.deepEqual(await openKeys(), ["rebate-statement"]);
    await sweptAt(hoursAgo(12));
    const r = await dailyCheck();
    const line = r.checks.find((c) => c.key === "mailbox-swept")!;
    assert.equal(line.ok, false);
    assert.equal(line.fingerprint, "stale|clean|0|-");
    assert.deepEqual(await openKeys(), ["mailbox-swept", "rebate-statement"]);
    assert.deepEqual(r.setAside, []);
    const [row] = await rows();
    assert.equal(row.endedHow, "changed");
    assert.ok(row.endedAt);
  });

  test("when the check passes the mark ends as passed, and a failure with the same facts later is not covered by it", async () => {
    await markShown("mailbox-swept", NEVER, "settled", "", OWNER);
    await sweptAt(hoursAgo(1));
    assert.deepEqual(await openKeys(), ["rebate-statement"]);
    assert.equal((await dailyCheck()).setAside.length, 0);
    assert.equal((await rows())[0].endedHow, "passed");
    await db.delete(schema.settings).where(eq(schema.settings.key, "mail_last_sweep"));
    assert.deepEqual(await openKeys(), ["mailbox-swept", "rebate-statement"], "never swept again: the old press must not cover it");
  });

  test("a second press on one check replaces the first, in either direction, and only one is ever in force", async () => {
    await markShown("mailbox-swept", NEVER, "settled", "first", OWNER);
    await markShown("mailbox-swept", NEVER, "wrong", "second", OWNER);
    const active = await marks.activeMarks();
    assert.equal(active.length, 1);
    assert.equal(active[0].verdict, "wrong");
    const all = await rows();
    assert.equal(all.length, 2);
    assert.equal(all.find((r) => r.note === "first")!.endedHow, "replaced");
    assert.equal((await dailyCheck()).setAside[0].mark.verdict, "wrong");
  });

  test("putting a mark back shows the line again, keeps the row, and a wrong alarm still counts", async () => {
    await markShown("mailbox-swept", NEVER, "wrong", "", OWNER);
    const [{ id }] = await rows();
    assert.equal(await marks.putBack(id, OWNER), true);
    assert.deepEqual(await openKeys(), ["mailbox-swept", "rebate-statement"]);
    const [row] = await rows();
    assert.equal(row.endedHow, "put back");
    assert.equal(row.endedBy, OWNER.name);
    assert.equal((await marks.wrongAlarms()).total, 1, "taking a press back must not make the alarm un-wrong");
    assert.equal((await marks.openWrongAlarms())[0].stillStands, false);
    assert.equal(await marks.putBack(id, OWNER), false, "a mark that has ended cannot be put back again");
    assert.equal(await marks.putBack("no-such-mark", OWNER), false);
  });

  test("a mark that ended because the check came right still counts as a wrong alarm and stays on the open list", async () => {
    await markShown("mailbox-swept", NEVER, "wrong", "", OWNER);
    await sweptAt(hoursAgo(1));
    await dailyCheck();
    assert.equal((await marks.wrongAlarms()).total, 1);
    const open = await marks.openWrongAlarms();
    assert.equal(open.length, 1);
    assert.equal(open[0].stillStands, false);
    assert.equal(open[0].what, "The mailbox is being swept");
    assert.equal(open[0].observed, "never swept");
  });
});

describe("a press that does not fit the line as it stands is refused in words and records nothing", () => {
  test("something other than wrong or settled", async () => {
    await refused(markShown("mailbox-swept", NEVER, "maybe", "", OWNER), /Say whether the line is wrong or settled/);
    await refused(markShown("mailbox-swept", NEVER, "", "", OWNER), /Say whether the line is wrong or settled/);
  });

  test("a check that is not there, including the one that says the check could not run", async () => {
    await refused(markShown("no-such-check", "x", "settled", "", OWNER), /not on the morning check any more/);
    await refused(markShown("check-ran", "", "settled", "", OWNER), /not on the morning check any more/);
  });

  test("a check that passes", async () => {
    await refused(markShown("inbox-rows", "0|0", "wrong", "", OWNER), /passes now/);
  });

  test("a line that has changed since he looked, by the facts and not by the clock", async () => {
    await sweptAt(hoursAgo(12));
    await refused(markShown("mailbox-swept", NEVER, "settled", "", OWNER), /has changed since you looked/);
    await markShown("mailbox-swept", "stale|clean|0|-", "settled", "", OWNER);
    assert.equal((await rows()).length, 1);
  });

  test("a finding that cannot be set aside, recorded directly", async () => {
    const { checkCouldNotRun } = await import("../src/lib/daily-check");
    const ran = checkCouldNotRun("no such table: invented_table").checks[0];
    await refused(marks.markCheck(ran, "settled", "", OWNER), /cannot be set aside/);
    const passing = (await dailyCheck()).checks.find((c) => c.key === "inbox-rows")!;
    await refused(marks.markCheck(passing, "settled", "", OWNER), /not failing/);
  });
});

/** Each planted row gets a fingerprint of its own: the table holds one standing mark of a verdict per finding, and these stand for presses on different findings. */
const plant = (id: string, verdict: "wrong" | "settled", markedAt: string = new Date().toISOString()) =>
  db.insert(schema.checkMarks).values({ id, checkKey: "mailbox-swept", fingerprint: `${NEVER}#${id}`, verdict, what: "The mailbox is being swept", observed: "never swept", markedBy: OWNER.name, markedAt });

describe("how many alarms were wrong is counted from the record, and never shrinks", () => {
  test("none pressed is none, with no first day", async () => {
    assert.deepEqual(await marks.wrongAlarms(), { total: 0, lastThirtyDays: 0, since: null });
  });

  test("wrong presses are counted in all and in the last thirty days; settled ones are not counted at all", async () => {
    const oldest = hoursAgo(24 * 40);
    await plant("w-old-0001", "wrong", oldest);
    await plant("w-new-0001", "wrong", hoursAgo(24 * 2));
    await plant("s-new-0001", "settled", hoursAgo(1));
    assert.deepEqual(await marks.wrongAlarms(), { total: 2, lastThirtyDays: 1, since: oldest });
    assert.deepEqual((await marks.openWrongAlarms()).map((a) => a.id), ["w-old-0001", "w-new-0001"], "oldest first");
  });
});

describe("a wrong alarm stays open until somebody says what was done about it", () => {
  test("an answer needs the start of an id that names exactly one wrong alarm, and a word on what was done", async () => {
    await plant("aaaa-one", "wrong");
    await plant("aaaa-two", "wrong");
    await plant("bbbb-set", "settled");
    const bad: [string, string, RegExp][] = [
      ["aaa", "x", /at least the first four characters/],
      ["%%%%", "x", /at least the first four characters/],
      ["a_a%", "x", /at least the first four characters/],
      ["aaaa", "x", /2 marks start with "aaaa"/],
      ["zzzz", "x", /0 marks start with "zzzz"/],
      ["aaaa-one", "   ", /say what was done/],
      ["bbbb-set", "x", /only a mark of "wrong" is answered/],
    ];
    for (const [start, answer, why] of bad) await assert.rejects(marks.answerWrongAlarm(start, answer), why, `answering ${start}`);
    assert.ok((await rows()).every((r) => r.answeredAt === null), "a refused answer must not answer anything, a wildcard least of all");
  });

  test("an answer is kept, to 1000 characters, once; the alarm leaves the open list and still counts", async () => {
    await plant("aaaa-one", "wrong");
    await plant("aaaa-two", "wrong");
    await marks.answerWrongAlarm("aaaa-one", "y".repeat(1500));
    const one = (await rows()).find((r) => r.id === "aaaa-one")!;
    assert.equal(one.answer!.length, 1000);
    assert.ok(one.answeredAt);
    await assert.rejects(marks.answerWrongAlarm("aaaa-one", "again"), /already been answered/);
    assert.deepEqual((await marks.openWrongAlarms()).map((a) => a.id), ["aaaa-two"]);
    assert.equal((await marks.wrongAlarms()).total, 2);
  });
});

describe("a record that cannot be read never hides an alarm", () => {
  test("with the table unreadable every failing line is shown, and the count is not measured rather than none", async () => {
    await markShown("mailbox-swept", NEVER, "settled", "", OWNER);
    assert.deepEqual(await openKeys(), ["rebate-statement"]);
    await db.run(sql`alter table check_marks rename to check_marks_held`);
    try {
      const r = await dailyCheck();
      assert.deepEqual(r.open.map((c) => c.key).sort(), ["mailbox-swept", "rebate-statement"]);
      assert.deepEqual(r.setAside, []);
      assert.deepEqual(r.wrongAlarms, { notMeasured: "record unreadable" });
      assert.doesNotMatch(r.says, /set aside/);
    } finally {
      await db.run(sql`alter table check_marks_held rename to check_marks`);
    }
    assert.deepEqual((await dailyCheck()).setAside.map((s) => s.check.key), ["mailbox-swept"], "readable again, the press covers its line again");
  });

  test("if ending a mark that no longer covers anything fails, the card still says what the check found", async () => {
    await markShown("mailbox-swept", NEVER, "settled", "", OWNER);
    await sweptAt(hoursAgo(12));
    await db.run(sql`create trigger refuse_mark_updates before update on check_marks begin select raise(abort, 'invented failure'); end`);
    try {
      const r = await dailyCheck();
      assert.deepEqual(r.open.map((c) => c.key).sort(), ["mailbox-swept", "rebate-statement"]);
      assert.deepEqual(r.setAside, []);
    } finally {
      await db.run(sql`drop trigger refuse_mark_updates`);
    }
    assert.equal((await rows())[0].endedAt, null, "the update was refused, so the mark is as it was");
    assert.deepEqual(await openKeys(), ["mailbox-swept", "rebate-statement"], "and it still does not cover the changed line");
  });
});

/*
 * The script a session reads the open wrong alarms with, run as it is run (a child process under tsx, with the same path mapping). It is
 * pointed at the scratch database by name, and refuses to run at all if that is not what it was given: the answer verb writes.
 */
const runScript = (...args: string[]) => {
  const dbPath = process.env.DATABASE_PATH ?? "";
  assert.ok(dbPath.includes("pharmacy-admin-test-"), "the script must be pointed at the scratch database, never the live one");
  const r = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "--tsconfig", "tsconfig.script.json", "scripts/wrong-alarms.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: dbPath, TZ: "America/Chicago" },
    encoding: "utf8",
    timeout: 180_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

describe("the script that lists the open wrong alarms", () => {
  test("it says so when nobody has pressed, and lists a press with what he was shown and his note, long digit runs masked", { timeout: 300_000 }, async () => {
    const none = runScript();
    assert.equal(none.code, 0, none.err);
    assert.match(none.out, /Nobody has pressed "This is wrong" on the morning check yet\./);

    await markShown("mailbox-swept", NEVER, "wrong", "swept at six, ref 999000000000123", OWNER);
    const [{ id }] = await rows();
    const one = runScript();
    assert.equal(one.code, 0, one.err);
    assert.match(one.out, /^1 time "This is wrong" has been pressed since \d{4}-\d{2}-\d{2}; 1 in the last 30 days; 1 not yet answered\./);
    assert.ok(one.out.includes(`${id.slice(0, 8)}  `) && one.out.includes("mailbox-swept") && one.out.includes("(still set aside)"));
    assert.ok(one.out.includes("Should be: The mailbox is being swept") && one.out.includes("Found:     never swept"));
    assert.ok(one.out.includes("He wrote:  swept at six, ref #########"));
    assert.ok(!one.out.includes("999000000000123"), "a long digit run must not be printed");
  });

  test("it answers by the start of an id, and the next listing says nothing is waiting; a bad answer exits 1 and says why", { timeout: 300_000 }, async () => {
    await markShown("mailbox-swept", NEVER, "wrong", "", OWNER);
    const [{ id }] = await rows();
    const done = runScript("answer", id.slice(0, 8), "the", "sweep", "now", "stamps", "itself");
    assert.equal(done.code, 0, done.err);
    assert.equal(done.out.trim(), `answered ${id}`);
    assert.equal((await marks.openWrongAlarms()).length, 0);
    assert.equal((await rows())[0].answer, "the sweep now stamps itself");
    assert.match(runScript().out, /^1 time "This is wrong" has been pressed since \d{4}-\d{2}-\d{2}; 1 in the last 30 days; 0 not yet answered\./);

    const bad = runScript("answer", "%%%%", "x");
    assert.equal(bad.code, 1);
    assert.match(bad.err.split("\n")[0], /at least the first four characters/);
    assert.equal(bad.out, "");
  });

  test("it names days as he saw them and not as the stamps are stored: a press at 8:30 in the evening on 6 October is the 6th", { timeout: 300_000 }, async () => {
    await plant("w-late-0001", "wrong", "2026-10-07T01:30:00.000Z");
    const r = runScript();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /pressed since 2026-10-06;/);
    assert.match(r.out, /\nw-late-0  2026-10-06  mailbox-swept /);
  });

  test("on a database without the check_marks table it says so, and why, and not only the query that failed", { timeout: 300_000 }, async () => {
    await db.run(sql`alter table check_marks rename to check_marks_held`);
    try {
      const listing = runScript();
      assert.equal(listing.code, 1);
      assert.match(listing.err.split("\n")[0], /^This database has no check_marks table, because the migration that adds it has not been applied here/);
      assert.equal(listing.out, "");
      const answering = runScript("answer", "abcd1234", "x");
      assert.equal(answering.code, 1);
      assert.match(answering.err.split("\n")[0], /^This database has no check_marks table/);
    } finally {
      await db.run(sql`alter table check_marks_held rename to check_marks`);
    }
  });
});
