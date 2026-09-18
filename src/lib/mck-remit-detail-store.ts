import "server-only";
import { db, schema } from "@/db";
import { readRemitDetail, detailAgreesWithSummary, type DetailRead } from "./mck-remit-detail";
import { readRemitSummary, type SummaryRow } from "./mck-remit-csv";
import { recordClaimPayment } from "./claim-payments";

/**
 * Posting the ProviderPay remit detail export, one whole remittance at a time.
 *
 * The push feed went quiet around 14 September 2026 and the portal is the only route left. The
 * detail export holds every claim line of every remittance in a date range in one file, which is
 * what makes this worth having: recovering a fortnight otherwise means "Export Modified 835"
 * twenty times, because that button only enables for a single remittance at a time.
 *
 * ── Whole remittances, or none ──
 *
 * The export overlaps weeks the 835 feed did deliver, so most of what is in it is already in the
 * books. Topping a remittance up line by line is how the same money gets counted twice: the lines
 * that look missing from a remittance the site already holds are the $0.00 denials the 835
 * importer had no reason to record, plus the handful the natural key cannot see through. So each
 * remittance is judged as a unit against the summary export's own figure for it, and lands in one
 * of three states:
 *
 *   held    the site already has essentially all of it. Nothing is posted.
 *   fresh   the site has essentially none of it. Every line is posted.
 *   unsure  somewhere in between. Nothing is posted and it is named, because a remittance that is
 *           half there is a question, not an arithmetic problem to round away.
 *
 * Measured on the real pair on 18 September 2026 — 9,107 lines, 51 remittances: 21 fresh worth
 * $153,939.35, 30 already held, and none unsure.
 *
 * ── The patient column ──
 *
 * The file has one. Nothing here ever sees it: `readRemitDetail` locates the columns it wants by
 * name and the patient column's index is never among them, the same way the 835 parser handles
 * nine segment types and NM1 is not one of them. This store writes what that reader returns and
 * the reader's shape has nowhere to put a name.
 */

export type DetailImport = {
  ok: boolean;
  /** Remittances whose lines were posted, with what each came to. */
  posted: { remitNumber: string; payer: string; lines: number; amountCents: number }[];
  /** Remittances the site already had. Named so the run can be checked, not silently dropped. */
  alreadyHeld: string[];
  /** Remittances neither clearly held nor clearly missing. Nothing was posted for these. */
  unsure: { remitNumber: string; summaryCents: number; heldCents: number; unpostedCents: number }[];
  /** Lines that could not be posted, and why. */
  problems: string[];
  postedCents: number;
};

/** The key a detail line and an existing payment can both be reduced to. */
const keyOf = (rx: string, on: string | null, cents: number) => `${rx.trim()}|${on ?? ""}|${cents}`;

/**
 * Import a detail export, using its summary twin to know what each remittance should come to.
 *
 * Both files are required. Without the summary there is no independent figure for a remittance,
 * and "how much of this remittance does the site already have" is the whole question — answering it
 * from the detail file alone would be reading the same number twice and calling it agreement.
 */
export async function importRemitDetail(
  detailText: string,
  summaryText: string,
  user: { id?: string; name: string },
  opts: { documentId?: string | null } = {},
): Promise<DetailImport> {
  const out: DetailImport = { ok: false, posted: [], alreadyHeld: [], unsure: [], problems: [], postedCents: 0 };

  const detail: DetailRead = readRemitDetail(detailText);
  if (detail.problems.length > 0) {
    out.problems.push(...detail.problems);
    return out;
  }
  const summary = readRemitSummary(summaryText);
  if (summary.rows.length === 0) {
    out.problems.push("The summary export could not be read, so there is nothing to check the detail against.");
    return out;
  }

  /*
   * The two files come out of the same table minutes apart. If they disagree about what a
   * remittance came to, one of them was read wrongly and neither is safe for that remittance —
   * so the whole import stops rather than posting the ones that happen to agree.
   */
  const off = detailAgreesWithSummary(detail, summary.rows);
  if (off.length > 0) {
    out.problems.push(
      `The detail and summary exports disagree on ${off.length} remittance${off.length === 1 ? "" : "s"} ` +
        `(${off.slice(0, 3).map((o) => `${o.remitNumber}: detail ${o.detailCents}c, summary ${o.summaryCents}c`).join("; ")}). ` +
        `Nothing was posted. Download both again from the same search.`,
    );
    return out;
  }

  const byNumber = new Map<string, SummaryRow>(summary.rows.map((r) => [r.remitNumber, r]));

  const existing = await db
    .select({ rx: schema.claimPayments.rxNumber, on: schema.claimPayments.dateFilled, cents: schema.claimPayments.amountCents })
    .from(schema.claimPayments);
  const held = new Set(existing.map((e) => keyOf(e.rx ?? "", e.on, e.cents)));

  /* Group the lines by remittance so each can be judged whole. */
  const lines = new Map<string, DetailRead["lines"]>();
  for (const l of detail.lines) {
    const at = lines.get(l.remitNumber) ?? [];
    at.push(l);
    lines.set(l.remitNumber, at);
  }

  for (const [remitNumber, group] of lines) {
    const row = byNumber.get(remitNumber);
    if (!row) {
      out.unsure.push({ remitNumber, summaryCents: 0, heldCents: 0, unpostedCents: group.reduce((n, l) => n + l.amountCents, 0) });
      continue;
    }

    let heldCents = 0;
    let unpostedCents = 0;
    for (const l of group) {
      if (l.rxNumber === null) continue;
      if (held.has(keyOf(l.rxNumber, l.dispensedOn, l.amountCents))) heldCents += l.amountCents;
      else unpostedCents += l.amountCents;
    }

    /*
     * Judged as a share of what the summary says the remittance came to, not as a count of lines:
     * a remittance can be 300 lines of which 290 are $0.00 denials, and a count would call that
     * mostly-missing when the money is all there.
     */
    const share = row.amountCents === 0 ? (heldCents === 0 ? 0 : 1) : heldCents / row.amountCents;
    if (share >= 0.99) {
      out.alreadyHeld.push(remitNumber);
      continue;
    }
    if (share > 0.01) {
      out.unsure.push({ remitNumber, summaryCents: row.amountCents, heldCents, unpostedCents });
      continue;
    }

    let posted = 0;
    let postedCents = 0;
    for (const l of group) {
      /* An adjustment is not a claim payment, and a zero is not money. Both are skipped, not failed. */
      if (l.rxNumber === null || l.amountCents === 0) continue;
      try {
        await recordClaimPayment(
          {
            rxNumber: l.rxNumber,
            dateFilled: l.dispensedOn ?? null,
            source: "plan",
            payer: row.payerName || null,
            amountCents: l.amountCents,
            receivedOn: l.remitOn ?? row.remitOn ?? null,
            reference: `ProviderPay ${row.payerName} ${remitNumber}`,
            documentId: opts.documentId ?? null,
          },
          user,
        );
        posted += 1;
        postedCents += l.amountCents;
      } catch (e) {
        out.problems.push(`${remitNumber}, Rx ${l.rxNumber}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (posted > 0) {
      out.posted.push({ remitNumber, payer: row.payerName, lines: posted, amountCents: postedCents });
      out.postedCents += postedCents;
    }
  }

  out.ok = true;
  return out;
}
