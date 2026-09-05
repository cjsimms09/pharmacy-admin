import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getSettings, setSetting } from "./settings";
import { allSuppliers } from "./suppliers-registry";
import { saveRebateProgram } from "./supplier-terms-store";
import { parseRebateReport, termsFromReport, gprTermsFromReport, brandTermsFromReport, bandFor, looksLikeRebateReport, type RebateReport } from "./rebate-report";

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
  /** Where the pharmacy sits on each ladder, and what the next band up is worth. */
  standing?: Standing;
  message: string;
};

export type Standing = {
  lines: string[];
  /** What one more band on the compliance ladder would have been worth on this month's purchases. */
  nextBandWorthCents: number | null;
};

/**
 * Where this pharmacy sits on each ladder, in money rather than percentages.
 *
 * "You are at 20.64%" means nothing on its own. "Three and a half points more would have paid
 * another twenty-nine dollars this month" is a decision. And the ladder that pays nothing matters
 * most of all: a pharmacy earning zero from the purchase-ratio programme cannot see the gap unless
 * something names it.
 */
export function whereYouStand(r: RebateReport): Standing {
  const s = r.statement;
  const lines: string[] = [];
  let nextBandWorthCents: number | null = null;

  const here = s.scrubbedGcrPercent === null ? null : bandFor(r.ladder.gcr, s.scrubbedGcrPercent);
  if (here && s.scrubbedGcrPercent !== null) {
    lines.push(
      `Compliance rate ${s.scrubbedGcrPercent}%, which is the ${here.fromPercent}%${here.toPercent === null ? "+" : `–${here.toPercent}%`} band: ${here.genericPercent}% on contract generics and ${here.brandPercent}% on brand.`,
    );
    const next = r.ladder.gcr.filter((b) => b.fromPercent > s.scrubbedGcrPercent!).sort((a, b) => a.fromPercent - b.fromPercent)[0];
    if (next && s.oneStopPurchasedCents !== null) {
      const gain = Math.round((s.oneStopPurchasedCents * (next.genericPercent - here.genericPercent)) / 100);
      nextBandWorthCents = gain;
      lines.push(
        next.genericPercent > here.genericPercent
          ? `The next band starts at ${next.fromPercent}% and pays ${next.genericPercent}% — ${round2(next.fromPercent - s.scrubbedGcrPercent)} points away, worth ${money(gain)} more on this month's contract purchases.`
          : `The next band starts at ${next.fromPercent}% and pays the same ${next.genericPercent}% on generics, but ${next.brandPercent}% on brand rather than ${here.brandPercent}%.`,
      );
    }
  }

  const paysAt = r.ladder.gpr.filter((b) => b.rebatePercent > 0).sort((a, b) => a.fromPercent - b.fromPercent)[0];
  if (paysAt && s.gprPercent !== null) {
    lines.push(
      s.gprPercent >= paysAt.fromPercent
        ? `Purchase ratio ${s.gprPercent}%, which is earning on the second ladder.`
        : `Purchase ratio ${s.gprPercent}%. Nothing is paid on that ladder below ${paysAt.fromPercent}%, so it is contributing nothing — ${round2(paysAt.fromPercent - s.gprPercent)} points short of the first band that pays.`,
    );
  }
  return { lines, nextBandWorthCents };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
    parts.push(`${report.ladder.gcr.length} compliance tiers filed against ${supplier.name}`);

    /*
     * The second ladder, filed as a programme of its own.
     *
     * The purchase-ratio ladder pays nothing at this pharmacy — the ratio reads 0.00% and nothing
     * pays below 75% — which is exactly why it is worth recording rather than mentioning in a
     * footnote. Money not being earned is invisible unless something holds the shape of what would
     * earn it.
     */
    const gprTerms = gprTermsFromReport(report);
    if (gprTerms) {
      await saveRebateProgram(
        supplier.id,
        {
          name: "McKesson generic purchase ratio (GPR)",
          effectiveFrom: s.periodFrom ?? new Date().toISOString().slice(0, 10),
          notes: `Read from the same rebate breakdown for ${s.periodFrom ?? "an unnamed period"}.`,
          documentId: meta.documentId ?? null,
        },
        gprTerms,
        user,
      );
      parts.push(`${report.ladder.gpr.length} purchase-ratio tiers as well`);
    }

    const brandTerms = brandTermsFromReport(report);
    if (brandTerms) {
      await saveRebateProgram(
        supplier.id,
        {
          name: "McKesson brand factor",
          effectiveFrom: s.periodFrom ?? new Date().toISOString().slice(0, 10),
          notes: `Read from the same rebate breakdown for ${s.periodFrom ?? "an unnamed period"}.`,
          documentId: meta.documentId ?? null,
        },
        brandTerms,
        user,
      );
      parts.push(`${brandTerms.tiers.length} brand-factor tiers`);
    }
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

  /*
   * The statement, the checks it passed and where it leaves the pharmacy, kept together.
   *
   * The checks are the answer to "how do I know it read it right", and an answer nobody can see is
   * not an answer. Stored beside the figures so the supplier's own page can show the arithmetic
   * rather than asking anybody to take it on trust.
   */
  await setSetting(
    "mck_rebate_last_statement",
    JSON.stringify({
      ...s,
      filedAt: new Date().toISOString(),
      documentId: meta.documentId ?? null,
      checks: report.checks,
      standing: whereYouStand(report).lines,
      tierCount: report.ladder.gcr.length,
    }),
  );

  return {
    stored: true,
    supplier: supplier?.name ?? null,
    ratePercent: rate,
    periodFrom: s.periodFrom,
    report,
    standing: whereYouStand(report),
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
export type FiledStatement = RebateReport["statement"] & {
  filedAt?: string;
  documentId?: string | null;
  checks?: { what: string; ok: boolean; detail: string }[];
  standing?: string[];
  tierCount?: number;
};

export async function lastRebateStatement(): Promise<FiledStatement | null> {
  const raw = (await getSettings()).mck_rebate_last_statement;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FiledStatement;
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
