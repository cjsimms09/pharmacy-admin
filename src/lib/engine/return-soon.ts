import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ReturnSoonRow, ReturnSoonView } from "../return-soon";

/**
 * The return-soon list, computed when its inputs move and stored; pages read rows.
 *
 * Measured 2 October 2026 on the pharmacy computer: the dashboard, the return-soon page and the daily digest each
 * rebuilt this list from cold — fifteen seconds, and six hundred megabytes held afterwards — and "cold" was most of
 * the time, because every file that arrives empties the held readings. The list depends on a handful of tables that
 * change a few times a day, so the engine recomputes it only when one of them has (or the day has, since the
 * deadlines are counted in days from today) and the rest of the time a page reads 1,700 rows in a few milliseconds.
 */

/** What the list depends on, in one cheap statement. A term moves, the list is recomputed on the next pass. */
export async function returnSoonFingerprint(): Promise<string> {
  const [r] = await db.all<{ o: string | null; l: number; c: number; cm: string | null; si: number; sm: string | null; p: number; f: number; d: string | null }>(sql`
    select (select max(counted_on) from on_hand_imports) o, (select count(*) from invoice_lines) l,
      (select count(*) from claims) c, (select max(date_filled) from claims) cm,
      (select count(*) from supplier_imports) si, (select max(created_at) from supplier_imports) sm,
      (select count(*) from supplier_return_policies) p, (select count(*) from ndc_pack_fixes) f,
      (select max(loaded_at) from drug_directory_loads) d`);
  return [r.o, r.l, r.c, r.cm, r.si, r.sm, r.p, r.f, r.d].map((v) => v ?? "-").join("|");
}

/** Pure: whether a stored run still stands for today's inputs. The day is a term because every deadline is "in N days". */
export function shouldRecompute(stored: { fingerprint: string; computedOn: string } | null, fingerprint: string, today: string): boolean {
  if (!stored) return true;
  return stored.fingerprint !== fingerprint || stored.computedOn !== today;
}

const EMPTY_TOTALS: ReturnSoonView["totals"] = { lines: 0, sittingCents: 0, thisWeek: 0, withoutSupplier: 0 };

export async function writeReturnSoon(today: string, now: string, opts: { force?: boolean } = {}): Promise<{ rows: number; computed: boolean; ms: number }> {
  const fingerprint = await returnSoonFingerprint();
  const run = await db.query.returnSoonRun.findFirst({ where: eq(schema.returnSoonRun.id, "current") });
  if (!opts.force && run && !shouldRecompute({ fingerprint: run.fingerprint, computedOn: run.computedOn }, fingerprint, today)) {
    return { rows: run.rows, computed: false, ms: 0 };
  }
  const started = Date.now();
  const { computeReturnSoon } = await import("../return-soon");
  const view = await computeReturnSoon();
  const seen = new Map<string, number>();
  const rows = view.rows.map((r, i) => {
    const base = `${r.ndc11}|${r.invoiceDate ?? "-"}|${r.why}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      key: n === 1 ? base : `${base}#${n}`,
      rank: i,
      ndc11: r.ndc11,
      name: r.name,
      onHandThousandths: r.onHandThousandths,
      worthCents: r.worthCents,
      sendBackThousandths: r.sendBackThousandths,
      sendBackWorthCents: r.sendBackWorthCents,
      why: r.why,
      reasons: JSON.stringify(r.reasons),
      deadlineDays: r.deadlineDays,
      supplier: r.supplier,
      invoiceDate: r.invoiceDate,
      creditPercentNow: r.creditPercentNow,
      dropsToPercent: r.dropsToPercent,
      atRiskCents: r.atRiskCents,
      urgency: r.urgency,
      says: r.says,
      todo: r.todo,
      computedAt: now,
    };
  });
  await db.delete(schema.returnSoon);
  for (let i = 0; i < rows.length; i += 100) await db.insert(schema.returnSoon).values(rows.slice(i, i + 100));
  const ms = Date.now() - started;
  const values = { computedAt: now, computedOn: today, fingerprint, rows: rows.length, totals: JSON.stringify(view.totals), notes: JSON.stringify(view.notes), ms };
  if (run) await db.update(schema.returnSoonRun).set(values).where(eq(schema.returnSoonRun.id, "current"));
  else await db.insert(schema.returnSoonRun).values({ id: "current", ...values });
  return { rows: rows.length, computed: true, ms };
}

/** The list as last stored. Never computes: a page that finds nothing stored says so, and the engine's next pass fills it. */
export async function readReturnSoon(): Promise<ReturnSoonView & { computedAt: string | null }> {
  const run = await db.query.returnSoonRun.findFirst({ where: eq(schema.returnSoonRun.id, "current") });
  if (!run) {
    return {
      rows: [],
      totals: EMPTY_TOTALS,
      notes: ["Not computed yet. The engine builds this list on its next pass — within half an hour of a start, and after every count, invoice or claims file."],
      computedAt: null,
    };
  }
  const stored = await db.query.returnSoon.findMany({ orderBy: (t, { asc }) => [asc(t.rank)] });
  const rows: ReturnSoonRow[] = stored.map((r) => ({
    ndc11: r.ndc11,
    name: r.name,
    onHandThousandths: r.onHandThousandths,
    worthCents: r.worthCents,
    sendBackThousandths: r.sendBackThousandths,
    sendBackWorthCents: r.sendBackWorthCents,
    why: r.why as ReturnSoonRow["why"],
    reasons: JSON.parse(r.reasons) as string[],
    deadlineDays: r.deadlineDays,
    supplier: r.supplier,
    invoiceDate: r.invoiceDate,
    creditPercentNow: r.creditPercentNow,
    dropsToPercent: r.dropsToPercent,
    atRiskCents: r.atRiskCents,
    urgency: r.urgency as ReturnSoonRow["urgency"],
    says: r.says,
    todo: r.todo,
  }));
  const when = new Date(run.computedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const notes = [...(JSON.parse(run.notes) as string[]), `Computed ${when}; it is recomputed after every count, invoice, claims file or price file, and every night.`];
  return { rows, totals: JSON.parse(run.totals) as ReturnSoonView["totals"], notes, computedAt: run.computedAt };
}
