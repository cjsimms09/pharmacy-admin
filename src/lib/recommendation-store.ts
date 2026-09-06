import "server-only";
import { eq, and, gte, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import type { MoneyRow } from "./money-found";
import { reconcile, switchOutcome, scorecard, type LogEntry } from "./recommendation-log";

/**
 * The recommendation log, read and written.
 *
 * `rememberRecommendations` is called with the money list each time it is built, and costs a
 * handful of writes a day: it starts entries for rows never seen, touches the ones still showing,
 * and closes the ones that went. Nothing on the list itself changes; the log sits beside it so the
 * page can say "on the list since 3 September" and the scorecard can say what became of it.
 *
 * `measureSwitch` judges one "buy this NDC instead" entry on the claims dispensed since the day it
 * first appeared. It is deliberately the caller's job to say which NDC was picked, which NDCs make
 * up the product and what gap per unit was promised — those are the recommendation's own terms,
 * and the score must be on the terms it was given, not on terms recomputed today.
 */

const todayIso = () => new Date().toISOString().slice(0, 10);

export async function logEntries(): Promise<LogEntry[]> {
  return db.query.recommendationLog.findMany({ orderBy: (t, { desc }) => [desc(t.lastSeenOn)] });
}

export async function rememberRecommendations(rows: MoneyRow[], on = todayIso()): Promise<{ ages: Map<string, number>; started: number; closed: number }> {
  const open = await db.query.recommendationLog.findMany({ where: isNull(schema.recommendationLog.resolvedOn) });
  const r = reconcile(open, rows, on);
  for (const e of r.insert) await db.insert(schema.recommendationLog).values({ id: newId(), ...e });
  for (const u of r.update) {
    await db.update(schema.recommendationLog).set({ lastSeenOn: u.lastSeenOn, amountCents: u.amountCents, says: u.says, todo: u.todo, confidence: u.confidence }).where(eq(schema.recommendationLog.id, u.id));
  }
  for (const x of r.resolve) {
    await db.update(schema.recommendationLog).set({ resolvedOn: x.resolvedOn, status: "resolved" }).where(and(eq(schema.recommendationLog.id, x.id), eq(schema.recommendationLog.status, "open")));
    await db.update(schema.recommendationLog).set({ resolvedOn: x.resolvedOn }).where(eq(schema.recommendationLog.id, x.id));
  }
  return { ages: r.ages, started: r.insert.length, closed: r.resolve.length };
}

/** The owner's word on an entry: acted on it, or not going to. */
export async function markRecommendation(id: string, status: "acted" | "dismissed" | "open", note: string | null): Promise<void> {
  await db.update(schema.recommendationLog).set({ status, note }).where(eq(schema.recommendationLog.id, id));
}

/** Scores a switch-NDC entry on the claims since it first appeared, and writes the result to it. */
export async function measureSwitch(entryId: string, pickNdc: string, productNdcs: string[], gapPerUnitMicros: number): Promise<ReturnType<typeof switchOutcome> | null> {
  const e = await db.query.recommendationLog.findFirst({ where: eq(schema.recommendationLog.id, entryId) });
  if (!e) return null;
  const since = await db.query.claims.findMany({
    where: gte(schema.claims.dateFilled, e.firstSeenOn),
    columns: { ndc11: true, quantityThousandths: true, status: true },
  });
  const o = switchOutcome(since, pickNdc, new Set(productNdcs), gapPerUnitMicros);
  if (o.verdict !== "too early") {
    await db.update(schema.recommendationLog).set({ outcomeCents: o.realisedCents, outcomeBasis: o.says, measuredOn: todayIso() }).where(eq(schema.recommendationLog.id, entryId));
  }
  return o;
}

export async function recommendationScorecard() {
  return scorecard(await logEntries());
}
