import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "../crypto";
import { todayIso } from "../dates";

/**
 * The engine's passes.
 *
 *   refresh   after data lands or a person answers: feeds judged, the months recomputed, the list rebuilt.
 *             Seconds, and safe to run often: everything it writes is keyed, nothing is appended.
 *   rebuild   nightly: refresh, then every proof run and kept.
 *
 * Each pass is a row in engine_run with what it wrote and how long it took, so a silent engine is visible on Today
 * ("the engine last ran at …"). A pass that throws records the error and stops; it never takes the app down and
 * never leaves half a list — the list is rewritten whole on the next pass.
 */

export type EngineReport = { kind: "refresh" | "rebuild"; ms: number; wrote: Record<string, unknown>; error: string | null };

let running: Promise<EngineReport> | null = null;

export async function engineRefresh(reason: string, opts: { proofs?: boolean; today?: string } = {}): Promise<EngineReport> {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const now = new Date().toISOString();
    /* The pharmacy's own date, not UTC: at nine in the evening in Kansas, UTC is already tomorrow, and a feed due tomorrow is not late. */
    const today = opts.today ?? todayIso();
    const id = newId();
    const kind = opts.proofs ? "rebuild" : "refresh";
    await db.insert(schema.engineRun).values({ id, kind, startedAt: now, wrote: JSON.stringify({ reason }) });
    const wrote: Record<string, unknown> = { reason };
    try {
      const { writeFeedState } = await import("./feeds");
      wrote.feeds = await writeFeedState(now, today);
      const { monthsToKeep, writeMonth } = await import("./month");
      const months = monthsToKeep(today);
      const figures = [];
      for (const m of months) figures.push(await writeMonth(m, today, now));
      wrote.months = months;
      const { computeNeedsYou, writeNeedsYou } = await import("./needs-you");
      wrote.needsYou = await writeNeedsYou(await computeNeedsYou(today), now);
      if (opts.proofs) {
        const p = await import("./proofs");
        const results = [
          ...figures.map((f) => p.bankToCent(f)),
          ...figures.map((f) => p.receiptsToBank(f)),
          await p.claimsEqualPioneer(),
          await p.readerArithmetic(today),
          ...(await Promise.all(months.map((m) => p.remitToClaim(m)))),
          await p.expectedArrived(),
        ];
        wrote.proofs = await p.writeProofs(results, now);
        wrote.failed = results.filter((r) => !r.passed).map((r) => `${r.proof}${r.scope ? ` ${r.scope}` : ""}`);
        /* A failed proof is a line on Today; the list is rebuilt once more so it carries them. */
        if ((wrote.failed as string[]).length) wrote.needsYouAfterProofs = await writeNeedsYou(await computeNeedsYou(today), now);
      }
      const ms = Date.now() - started;
      await db.update(schema.engineRun).set({ finishedAt: new Date().toISOString(), ms, wrote: JSON.stringify(wrote) }).where(eq(schema.engineRun.id, id));
      return { kind, ms, wrote, error: null } as EngineReport;
    } catch (e) {
      const ms = Date.now() - started;
      const error = String(e).slice(0, 500);
      await db.update(schema.engineRun).set({ finishedAt: new Date().toISOString(), ms, wrote: JSON.stringify(wrote), error }).where(eq(schema.engineRun.id, id));
      return { kind, ms, wrote, error } as EngineReport;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Nightly, and the first run after a start: proofs included. */
export async function engineRebuild(reason = "nightly"): Promise<EngineReport> {
  return engineRefresh(reason, { proofs: true });
}

/** For the half-hourly beat: a refresh each time, and a rebuild once a day after two in the morning. */
export async function engineTick(): Promise<void> {
  const last = await db.query.engineRun.findFirst({ where: eq(schema.engineRun.kind, "rebuild"), orderBy: (r, { desc }) => [desc(r.startedAt)], columns: { startedAt: true, finishedAt: true } });
  const hour = new Date().getHours();
  const since = last?.startedAt ? Date.now() - Date.parse(last.startedAt) : Infinity;
  if (hour >= 2 && since > 20 * 60 * 60 * 1000) await engineRebuild("nightly");
  else await engineRefresh("tick");
}

/** After an ingest or an answer. Never awaited by the caller's request; its outcome is on Today either way. */
export function engineAfter(reason: string): void {
  void engineRefresh(reason).catch(() => undefined);
}
