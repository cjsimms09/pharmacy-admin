import "server-only";
import { db, schema } from "@/db";
import { and, asc, desc, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import { newId } from "./crypto";
import { audit } from "./audit";
import type { Check, Mark, Verdict, WrongAlarmCount } from "./daily-check";

/**
 * What the owner has said about the morning check's findings.
 *
 * On 6 October 2026 five of the morning's alarms were wrong, and the card had no way to be told so: it was put right only when somebody
 * noticed and changed the code. A press on the card is that way, and it is held here, in a table of its own, because every finding is
 * rebuilt from the data each time Today opens and a mark kept on the finding would go with it.
 *
 * Three rules.
 *   **A mark covers one finding as it stood.** It is keyed by the check and by the facts that made it fail (`Check.fingerprint`), and it
 *     ends when the check passes or the facts change, so a mark can silence the alarm he saw and no other.
 *   **Nothing is deleted.** The count of "wrong" presses is how many times he had to tell the card it was wrong; a mark that
 *     disappeared when it was put back would make that count lie.
 *   **A wrong alarm stays open until somebody answers it.** The press is a bug report, and the next session reads the open ones first.
 */

type Row = typeof schema.checkMarks.$inferSelect;

const toMark = (r: Row): Mark => ({ id: r.id, key: r.checkKey, fingerprint: r.fingerprint, verdict: r.verdict, note: r.note, by: r.markedBy, at: r.markedAt });

/** The marks that still apply, newest first. A handful of rows, read each time the check runs. */
export async function activeMarks(): Promise<Mark[]> {
  const rows = await db.select().from(schema.checkMarks).where(isNull(schema.checkMarks.endedAt)).orderBy(desc(schema.checkMarks.markedAt));
  return rows.map(toMark);
}

/**
 * Records his press on a failing check. A check that passes, or one that cannot be marked (no fingerprint), is refused rather than
 * recorded, because a mark with nothing to cover would silence whatever the check next said. The same finding already carrying the same
 * verdict is the press he already made (a double click, a page sent twice): the table holds one such mark at a time, so it is not recorded
 * or counted again, and `already` says so.
 */
export async function markCheck(
  check: Check,
  verdict: Verdict,
  note: string,
  user: { id: string; name: string },
): Promise<{ id: string; already: boolean }> {
  if (check.ok || check.fingerprint === null) throw new Error(`"${check.what}" is not failing, or cannot be set aside, so there is nothing to mark`);
  const at = new Date().toISOString();
  const id = newId();
  const kept = note.replace(/\s+/g, " ").trim().slice(0, 500);
  try {
    await db.insert(schema.checkMarks).values({
      id,
      checkKey: check.key,
      fingerprint: check.fingerprint,
      verdict,
      what: check.what,
      observed: check.observed,
      note: kept || null,
      markedBy: user.name,
      markedAt: at,
    });
  } catch (e) {
    // Only the standing mark of the same finding and verdict is the answer to a refused insert; any other failure is raised as it came.
    const standing = await db
      .select({ id: schema.checkMarks.id })
      .from(schema.checkMarks)
      .where(
        and(
          eq(schema.checkMarks.checkKey, check.key),
          eq(schema.checkMarks.fingerprint, check.fingerprint),
          eq(schema.checkMarks.verdict, verdict),
          isNull(schema.checkMarks.endedAt),
        ),
      )
      .limit(1);
    if (standing.length > 0) return { id: standing[0].id, already: true };
    throw e;
  }
  /*
   * One mark per check at a time: a second press replaces the first, so "settled" can be changed to "wrong" and the other way. The new
   * one is written first, so a failure part-way leaves two and never none, and the check's own reading takes the newest of two.
   */
  await db
    .update(schema.checkMarks)
    .set({ endedAt: at, endedHow: "replaced" })
    .where(and(eq(schema.checkMarks.checkKey, check.key), isNull(schema.checkMarks.endedAt), ne(schema.checkMarks.id, id)));
  await audit({
    action: "check.mark",
    userId: user.id,
    userName: user.name,
    entity: "check_marks",
    entityId: id,
    details: `${check.key} marked ${verdict}${kept ? `: ${kept}` : ""}`,
  });
  return { id, already: false };
}

/** Takes a mark off, so the alarm shows again. The row stays, ended, and still counts. */
export async function putBack(id: string, user: { id: string; name: string }): Promise<boolean> {
  const done = await db
    .update(schema.checkMarks)
    .set({ endedAt: new Date().toISOString(), endedHow: "put back", endedBy: user.name })
    .where(and(eq(schema.checkMarks.id, id), isNull(schema.checkMarks.endedAt)))
    .returning({ id: schema.checkMarks.id });
  if (done.length === 0) return false;
  await audit({ action: "check.put-back", userId: user.id, userName: user.name, entity: "check_marks", entityId: id, details: "mark taken off; the alarm shows again" });
  return true;
}

/** Ends marks that no longer cover anything: the check came right (`passed`), what it found changed (`changed`), or a later press took its place (`replaced`). */
export async function endMarks(ending: { id: string; how: "passed" | "changed" | "replaced" }[]): Promise<void> {
  if (ending.length === 0) return;
  const at = new Date().toISOString();
  for (const how of ["passed", "changed", "replaced"] as const) {
    const ids = ending.filter((e) => e.how === how).map((e) => e.id);
    if (ids.length === 0) continue;
    await db
      .update(schema.checkMarks)
      .set({ endedAt: at, endedHow: how })
      .where(and(inArray(schema.checkMarks.id, ids), isNull(schema.checkMarks.endedAt)));
  }
}

/** How many alarms he has had to tell the site were wrong: every "wrong" press ever made, and those in the last thirty days. */
export async function wrongAlarms(): Promise<WrongAlarmCount> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = await db.all<{ total: number | null; recent: number | null; first: string | null }>(
    sql`select count(*) as total, coalesce(sum(case when marked_at >= ${since30} then 1 else 0 end), 0) as recent, min(marked_at) as first
          from check_marks where verdict = 'wrong'`,
  );
  const r = rows[0];
  return { total: Number(r?.total ?? 0), lastThirtyDays: Number(r?.recent ?? 0), since: r?.first ?? null };
}

export type OpenWrongAlarm = { id: string; key: string; what: string; observed: string; note: string | null; by: string; at: string; stillStands: boolean };

/** The wrong alarms nobody has answered yet, oldest first: the first thing a session reads, before it builds anything new. */
export async function openWrongAlarms(): Promise<OpenWrongAlarm[]> {
  const rows = await db
    .select()
    .from(schema.checkMarks)
    .where(and(eq(schema.checkMarks.verdict, "wrong"), isNull(schema.checkMarks.answeredAt)))
    .orderBy(asc(schema.checkMarks.markedAt));
  return rows.map((r) => ({ id: r.id, key: r.checkKey, what: r.what, observed: r.observed, note: r.note, by: r.markedBy, at: r.markedAt, stillStands: r.endedAt === null }));
}

/** Says what was done about a wrong alarm. The id may be the first characters of it, as long as they name exactly one. */
export async function answerWrongAlarm(idStart: string, answer: string): Promise<{ id: string }> {
  // Wildcards are taken out before the length is judged: "%%%%" is four characters and would otherwise match every mark.
  const start = idStart.trim().replace(/[%_]/g, "");
  const text = answer.trim();
  if (start.length < 4) throw new Error("give at least the first four characters of the mark's id");
  if (!text) throw new Error("say what was done about it");
  const found = await db
    .select({ id: schema.checkMarks.id, verdict: schema.checkMarks.verdict, answeredAt: schema.checkMarks.answeredAt })
    .from(schema.checkMarks)
    .where(like(schema.checkMarks.id, `${start}%`));
  if (found.length !== 1) throw new Error(`${found.length} marks start with "${start}", and it has to be exactly one`);
  if (found[0].verdict !== "wrong") throw new Error("only a mark of \"wrong\" is answered; a \"settled\" one is his and needs nothing from anybody");
  if (found[0].answeredAt !== null) throw new Error("that one has already been answered");
  await db.update(schema.checkMarks).set({ answeredAt: new Date().toISOString(), answer: text.slice(0, 1000) }).where(eq(schema.checkMarks.id, found[0].id));
  return { id: found[0].id };
}
