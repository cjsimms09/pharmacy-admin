import "server-only";
import { db, schema } from "@/db";
import { eq, isNull, and } from "drizzle-orm";
import { lineSchedule, directoryCodeOf } from "./line-schedule";

/**
 * Asks every stored invoice line what schedule it is, using the sources as they stand today.
 *
 * A line's schedule is written when the invoice is read, from three sources — the invoice's own
 * printed halves, the FDA directory entry for that NDC, and the delivery PioneerRx recorded. Two of
 * those three change after the reading. The directory gains rows on every refresh, and a delivery
 * is often booked in after its invoice arrives. A line read before either could answer keeps its
 * null for ever, because nothing ever asks again.
 *
 * Measured on 16 September 2026, which is why this exists: 588 lines on file, 1 carrying a
 * schedule, and 83 of them on NDCs the directory can answer for — 48 of those registered CII. The
 * code was correct and the rows were stale, so no code fix would have moved a single one of them.
 *
 * The cost of that was not the empty column. `filingDisagrees` asks the one question a regulator
 * cares about — a Schedule II line on an invoice filed as ordinary — and it was reported clean over
 * 588 lines of which 587 made no claim at all. A check asked of silence cannot fail, and it was
 * reported as though it had passed.
 *
 * Only nulls are filled. A line that already carries an answer keeps it: the strongest source is
 * the invoice's own printed halves, recorded at read time by a reader looking at the page, and
 * nothing here is better placed than that was.
 */
export async function fillLineSchedules(): Promise<{
  looked: number;
  filled: number;
  bySource: Record<string, number>;
  stillSilent: number;
}> {
  const { ndcSchedules } = await import("./drug-directory-store");
  const scheduleOf = await ndcSchedules();

  /* Only the lines that have never been answered; the rest are left exactly as they are. */
  const lines = await db.query.invoiceLines.findMany({
    where: and(isNull(schema.invoiceLines.deaSchedule), isNull(schema.invoiceLines.deaScheduleFrom)),
    columns: { id: true, invoiceId: true, ndc11: true, controlled: true },
  });

  /*
   * The deliveries, once, keyed by the wholesaler's own invoice number.
   *
   * A delivery can only ever prove a negative — it records what schedules arrived on the whole
   * order, not which line was which — so it is read for exactly that and nothing more. Fetching it
   * per line would be one query per row for an answer that is the same for all of them.
   */
  const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))];
  const invoices = await db.query.supplierInvoices.findMany({ columns: { id: true, invoiceNumber: true } });
  const numberOf = new Map(invoices.filter((i) => invoiceIds.includes(i.id)).map((i) => [i.id, i.invoiceNumber]));
  const deliveries = await db.query.pioneerPurchases.findMany({ columns: { invoiceNumber: true, deaSchedules: true } });
  const codesByNumber = new Map(
    deliveries.filter((d) => d.invoiceNumber).map((d) => [d.invoiceNumber as string, d.deaSchedules?.split(",") ?? null]),
  );

  const bySource: Record<string, number> = {};
  let filled = 0;

  for (const l of lines) {
    const number = numberOf.get(l.invoiceId) ?? null;
    const said = lineSchedule({
      sectionControlled: l.controlled,
      directoryCode: l.ndc11 ? directoryCodeOf(scheduleOf(l.ndc11)) : null,
      deliveryCodes: number ? codesByNumber.get(number) ?? null : null,
    });
    /* Nothing can answer for it yet. Left null, which is the honest state and not a failure. */
    if (!said.from) continue;

    await db
      .update(schema.invoiceLines)
      .set({ deaSchedule: said.schedule, deaScheduleFrom: said.from, controlled: said.controlled })
      .where(eq(schema.invoiceLines.id, l.id));
    filled++;
    bySource[said.from] = (bySource[said.from] ?? 0) + 1;
  }

  return { looked: lines.length, filled, bySource, stillSilent: lines.length - filled };
}
