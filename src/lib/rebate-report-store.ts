import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getSettings, setSetting } from "./settings";
import { allSuppliers } from "./suppliers-registry";
import { saveRebateProgram } from "./supplier-terms-store";
import { parseRebateReport, termsFromReport, looksLikeRebateReport, type RebateReport } from "./rebate-report";

/**
 * Filing a rebate breakdown: the ladder as terms, and the month's rate as the one the comparison uses.
 *
 * Two different lifetimes come out of one document. The ladder is the agreement and changes rarely,
 * so it is stored as a versioned rebate programme against the supplier — the same place a ladder
 * typed by hand would go, so nothing downstream cares which way it arrived. The achieved rate is
 * one month's fact, and it is what the purchasing comparison must use today: a generic bought on
 * the contract this month earns 29%, whatever the ladder says the pharmacy might earn at a better
 * compliance rate.
 *
 * Nothing is stored from a report whose own figures do not agree with its own ladder. The whole
 * value of the document is that it checks itself; a report that fails its checks has either changed
 * layout or changed terms, and either way a wrong tier ladder would silently misprice every generic
 * in the purchasing comparison with nothing to notice.
 */

export type FiledRebateReport = {
  stored: boolean;
  supplier: string | null;
  /** The rate the purchasing comparison will now use, as a percentage. */
  ratePercent: number | null;
  periodFrom: string | null;
  report: RebateReport;
  message: string;
};

/** Which register row this report belongs to. McKesson prints no supplier name on it. */
async function mckesson(): Promise<{ id: string; name: string } | null> {
  const rows = await allSuppliers(true);
  const hit =
    rows.find((s) => /mckesson/i.test(s.name)) ??
    rows.find((s) => /mckesson/i.test(s.catalogName ?? "")) ??
    null;
  return hit ? { id: hit.id, name: hit.name } : null;
}

export async function fileRebateReport(
  text: string,
  meta: { documentId?: string | null },
  user: { name: string },
): Promise<FiledRebateReport> {
  const report = parseRebateReport(text);
  const s = report.statement;
  const rate = s.gcrRatePercent;

  if (!report.trustworthy) {
    return {
      stored: false,
      supplier: null,
      ratePercent: null,
      periodFrom: s.periodFrom,
      report,
      message:
        report.problems.join(" ") ||
        "This looks like a rebate breakdown but its tier table could not be read, so nothing was stored.",
    };
  }

  const supplier = await mckesson();
  const parts: string[] = [];

  if (supplier) {
    await saveRebateProgram(
      supplier.id,
      {
        name: "McKesson generics (OneStop) rebate",
        // The ladder is in force for the month the statement covers; without a period, today.
        effectiveFrom: s.periodFrom ?? new Date().toISOString().slice(0, 10),
        notes: `Read from the rebate breakdown for ${s.periodFrom ?? "an unnamed period"}, which checked out against its own figures.`,
        documentId: meta.documentId ?? null,
      },
      termsFromReport(report),
      user,
    );
    parts.push(`${report.ladder.gcr.length} tiers filed against ${supplier.name}`);
  } else {
    parts.push(
      "No McKesson row exists on the Suppliers page yet, so the tier ladder has nowhere to be filed — " +
        "add them and load this again",
    );
  }

  /*
   * The rate the comparison uses, kept as a setting.
   *
   * A setting rather than something derived from the ladder, because the ladder alone cannot say
   * it: the rate depends on a scrubbed compliance ratio whose exclusions McKesson does not publish.
   * Only the statement knows what was actually achieved, so the statement is what sets it.
   */
  if (rate !== null) {
    const before = (await getSettings()).mck_generic_rebate_rate;
    await setSetting("mck_generic_rebate_rate", String(rate));
    parts.push(
      before && before !== String(rate)
        ? `the rate the purchasing comparison uses moved from ${before}% to ${rate}%`
        : `the purchasing comparison will take ${rate}% off contract generics`,
    );
  }

  await setSetting("mck_rebate_last_statement", JSON.stringify({ ...s, filedAt: new Date().toISOString() }));

  return {
    stored: true,
    supplier: supplier?.name ?? null,
    ratePercent: rate,
    periodFrom: s.periodFrom,
    report,
    message:
      `Rebate breakdown for ${s.periodFrom ?? "an unnamed period"} read and checked: ` +
      `a scrubbed GCR of ${s.scrubbedGcrPercent}% earned ${rate}% on ${dollarsOf(s.oneStopPurchasedCents)} of contract generics. ` +
      parts.join(", ") +
      ".",
  };
}

const dollarsOf = (c: number | null) =>
  c === null ? "an unread figure" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The last statement filed, for the page that shows where the rate came from. */
export async function lastRebateStatement(): Promise<(RebateReport["statement"] & { filedAt?: string }) | null> {
  const raw = (await getSettings()).mck_rebate_last_statement;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RebateReport["statement"] & { filedAt: string };
  } catch {
    return null;
  }
}

export { looksLikeRebateReport };

/** Reads a rebate breakdown out of a document already filed, for the ones that arrived before this existed. */
export async function fileRebateReportFromDocument(documentId: string, user: { name: string }): Promise<FiledRebateReport> {
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc) throw new Error("That document no longer exists.");
  const { readFile } = await import("./files");
  const { pdfText } = await import("./pdf-text");
  const text = pdfText(await readFile(doc.storageKey));
  if (!looksLikeRebateReport(text)) throw new Error("That document does not look like a McKesson rebate breakdown.");
  return fileRebateReport(text, { documentId }, user);
}
