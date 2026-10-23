import "server-only";
import { db, schema } from "@/db";
import { desc } from "drizzle-orm";
import { parseSystemSales, type SalesRow } from "./system-sales";

/**
 * Filing a month's takings, and reading them back.
 *
 * A month is replaced rather than appended. These reports are restatements: the same August, re-run
 * after a correction, is still one August, and holding both copies would report the pharmacy as
 * having taken twice what it did — the single most damaging arithmetic error available here.
 */

export type FiledSalesMonth = {
  month: string;
  periodFrom: string;
  periodTo: string;
  retailCents: number | null;
  retailTaxCents: number | null;
  /** What the retail goods cost to buy, where the source carries it. */
  retailCostCents: number | null;
  rxPatientCents: number | null;
  rxRemitCents: number | null;
  rxCents: number | null;
  totalCents: number | null;
  rows: SalesRow[];
  fileName: string | null;
  printedOn: string | null;
};

export async function fileSystemSales(
  buf: Buffer,
  fileName: string,
  userId: string,
  documentId?: string | null,
): Promise<{ month: string | null; totalCents: number | null; replaced: boolean; problems: string[] }> {
  const parsed = parseSystemSales(buf.toString("utf8"));
  if (parsed.problems.length > 0 || parsed.month === null || parsed.period === null) {
    return {
      month: parsed.month,
      totalCents: parsed.totalCents,
      replaced: false,
      problems: parsed.problems.length
        ? parsed.problems
        : ["The report covers no single calendar month, so there is nothing to file it against."],
    };
  }

  const existing = await db.query.salesMonths.findFirst({ where: (m, { eq }) => eq(m.month, parsed.month!) });
  const values = {
    month: parsed.month,
    periodFrom: parsed.period.from,
    periodTo: parsed.period.to,
    retailCents: parsed.retailCents,
    retailTaxCents: parsed.retailTaxCents,
    rxPatientCents: parsed.rxPatientCents,
    rxRemitCents: parsed.rxRemitCents,
    rxCents: parsed.rxCents,
    totalCents: parsed.totalCents,
    rowsJson: JSON.stringify(parsed.rows),
    fileName,
    printedOn: parsed.printedOn,
    documentId: documentId ?? null,
    createdBy: userId,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    const { eq } = await import("drizzle-orm");
    await db.update(schema.salesMonths).set(values).where(eq(schema.salesMonths.month, parsed.month));
  } else {
    await db.insert(schema.salesMonths).values(values);
  }
  return { month: parsed.month, totalCents: parsed.totalCents, replaced: Boolean(existing), problems: [] };
}

const read = (r: typeof schema.salesMonths.$inferSelect): FiledSalesMonth => ({
  month: r.month,
  periodFrom: r.periodFrom,
  periodTo: r.periodTo,
  retailCents: r.retailCents,
  retailTaxCents: r.retailTaxCents ?? null,
  retailCostCents: r.retailCostCents,
  rxPatientCents: r.rxPatientCents,
  rxRemitCents: r.rxRemitCents,
  rxCents: r.rxCents,
  totalCents: r.totalCents,
  rows: (() => {
    try {
      return JSON.parse(r.rowsJson) as SalesRow[];
    } catch {
      return [];
    }
  })(),
  fileName: r.fileName,
  printedOn: r.printedOn,
});

/** Every month on file, most recent first. */
export async function salesMonths(): Promise<FiledSalesMonth[]> {
  return (await db.query.salesMonths.findMany({ orderBy: [desc(schema.salesMonths.month)] })).map(read);
}

/** The most recent month filed, which is the one the scoreboard reports. */
export async function latestSalesMonth(): Promise<FiledSalesMonth | null> {
  const rows = await db.query.salesMonths.findMany({ orderBy: [desc(schema.salesMonths.month)], limit: 1 });
  return rows[0] ? read(rows[0]) : null;
}
