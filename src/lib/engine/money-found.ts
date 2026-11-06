import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { MoneyFound, MoneyRow } from "../money-found";

/**
 * The money list, computed when anything it depends on moves and stored; pages read rows.
 *
 * Measured 2 October 2026 on the pharmacy computer: the dashboard, the books and the money page each rebuilt the list
 * from cold — seventeen seconds and nine hundred megabytes held afterwards — and cold was most of the time, because
 * every file that arrives empties the held readings. The list depends on nearly every table the site has, so its
 * fingerprint is the one the held readings use (held.ts): any write moves it, and the next engine pass recomputes.
 * The ages and the owner's word on each line live in recommendation_log and are read live, which costs nothing.
 */

/** Pure: whether a stored run still stands for today's inputs. The day is a term because an age is "on the list since". */
export function shouldRecompute(stored: { fingerprint: string; computedOn: string } | null, fingerprint: string, today: string): boolean {
  if (!stored) return true;
  return stored.fingerprint !== fingerprint || stored.computedOn !== today;
}

export async function writeMoneyFound(today: string, now: string, opts: { force?: boolean } = {}): Promise<{ rows: number; computed: boolean; ms: number }> {
  const { fingerprint } = await import("../held");
  const fp = await fingerprint();
  const run = await db.query.moneyFoundRun.findFirst({ where: eq(schema.moneyFoundRun.id, "current") });
  if (!opts.force && run && !shouldRecompute({ fingerprint: run.fingerprint, computedOn: run.computedOn }, fp, today)) {
    return { rows: run.rows, computed: false, ms: 0 };
  }
  const started = Date.now();
  const { computeMoneyFound } = await import("../money-found");
  const view = await computeMoneyFound();
  const rows = view.rows.map((r, i) => ({
    key: r.key,
    rank: i,
    says: r.says,
    todo: r.todo,
    amountCents: r.amountCents,
    cadence: r.cadence,
    confidence: r.confidence,
    basis: r.basis,
    href: r.href,
    overlapsWith: r.overlapsWith ? JSON.stringify(r.overlapsWith) : null,
    computedAt: now,
  }));
  /* A key can repeat when two sources name the same money; the first keeps the key, the rest carry their rank. */
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) r.key = `${r.key}#${r.rank}`;
    seen.add(r.key);
  }
  await db.delete(schema.moneyFound);
  for (let i = 0; i < rows.length; i += 100) await db.insert(schema.moneyFound).values(rows.slice(i, i + 100));
  const ms = Date.now() - started;
  const values = { computedAt: now, computedOn: today, fingerprint: fp, rows: rows.length, blocked: JSON.stringify(view.blocked), watch: JSON.stringify(view.watch), ms };
  if (run) await db.update(schema.moneyFoundRun).set(values).where(eq(schema.moneyFoundRun.id, "current"));
  else await db.insert(schema.moneyFoundRun).values({ id: "current", ...values });
  return { rows: rows.length, computed: true, ms };
}

/** The list as last stored, with today's ages and the owner's word on each line from the log. Never computes. */
export async function readMoneyFound(today?: string): Promise<MoneyFound & { computedAt: string | null }> {
  const { totals } = await import("../money-found");
  const run = await db.query.moneyFoundRun.findFirst({ where: eq(schema.moneyFoundRun.id, "current") });
  if (!run) return { rows: [], firstYearCents: 0, recurringMonthlyCents: 0, oneOffCents: 0, blocked: [], watch: [], ages: {}, log: {}, computedAt: null };
  const stored = await db.query.moneyFound.findMany({ orderBy: (t, { asc }) => [asc(t.rank)] });
  const rows: MoneyRow[] = stored.map((r) => ({
    key: r.key.replace(/#\d+$/, ""),
    says: r.says,
    todo: r.todo,
    amountCents: r.amountCents,
    cadence: r.cadence as MoneyRow["cadence"],
    confidence: r.confidence as MoneyRow["confidence"],
    basis: r.basis,
    href: r.href,
    ...(r.overlapsWith ? { overlapsWith: JSON.parse(r.overlapsWith) as string[] } : {}),
  }));
  const ages: MoneyFound["ages"] = {};
  const log: MoneyFound["log"] = {};
  try {
    const { openEntries } = await import("../recommendation-store");
    const { identityOf } = await import("../recommendation-log");
    const { todayIso, daysBetween } = await import("../dates");
    const day = today ?? todayIso();
    const open = await openEntries();
    for (const r of rows) {
      const id = identityOf(r);
      const e = open.get(id.subject ? `${id.key}|${id.subject}` : id.key);
      if (!e) continue;
      ages[r.key] = daysBetween(e.firstSeenOn, day) + 1;
      log[r.key] = { id: e.id, firstSeenOn: e.firstSeenOn, status: e.status, note: e.note };
    }
  } catch {
    /* The log is a convenience over the list, never a condition of it. */
  }
  return { rows, ...totals(rows), blocked: JSON.parse(run.blocked) as MoneyFound["blocked"], watch: JSON.parse(run.watch) as MoneyFound["watch"], ages, log, computedAt: run.computedAt };
}
