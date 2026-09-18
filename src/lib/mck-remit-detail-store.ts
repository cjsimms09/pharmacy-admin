import "server-only";
import { db, schema } from "@/db";
import { and, like, ne, eq, isNotNull } from "drizzle-orm";
import { readRemitDetail, detailAgreesWithSummary, type DetailRead } from "./mck-remit-detail";
import { readRemitSummary, type SummaryRow } from "./mck-remit-csv";
import { recordClaimPayment } from "./claim-payments";
import { newId } from "./crypto";

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
 * Put every remittance in the register, whether or not its claims were posted.
 *
 * Upserted on the remittance number, which is its identity: the same export downloaded twice, or
 * two overlapping date ranges, must leave one row. The payment number is refreshed each time
 * because it changes — ProviderPay writes "Not matched" until the deposit is tied to it, and the
 * day that becomes a number is the day cash should be expected.
 */
async function rememberRemittances(rows: SummaryRow[], source: string): Promise<void> {
  if (rows.length === 0) return;
  const at = new Date().toISOString();
  for (const r of rows) {
    const existing = await db
      .select({ id: schema.remittanceRegister.id })
      .from(schema.remittanceRegister)
      .where(eq(schema.remittanceRegister.remitNumber, r.remitNumber))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(schema.remittanceRegister)
        .set({ payerName: r.payerName, remitOn: r.remitOn, amountCents: r.amountCents, paymentNumber: r.paymentNumber, source, lastSeenAt: at })
        .where(eq(schema.remittanceRegister.remitNumber, r.remitNumber));
    } else {
      await db.insert(schema.remittanceRegister).values({
        id: newId(),
        remitNumber: r.remitNumber,
        payerName: r.payerName,
        remitOn: r.remitOn,
        amountCents: r.amountCents,
        paymentNumber: r.paymentNumber,
        source,
        firstSeenAt: at,
        lastSeenAt: at,
      });
    }
  }
}

/**
 * Fill the register from a summary export alone.
 *
 * The register was first written to only from the detail import, which was a mistake with a short
 * fuse: the detail files are deleted once read, so the register could never be filled again and
 * check 10 went blind within the hour of being built. The summary is the better source — one row
 * per remittance, carrying the payment number, and with no patient data in it at all.
 */
export async function rememberRemittancesFromSummary(text: string): Promise<{ remembered: number; withoutPayment: number; problems: string[] }> {
  const summary = readRemitSummary(text);
  if (summary.rows.length === 0) return { remembered: 0, withoutPayment: 0, problems: summary.problems.length > 0 ? summary.problems : ["No remittances could be read from it."] };
  await rememberRemittances(summary.rows, "providerpay remit summary");
  return {
    remembered: summary.rows.length,
    withoutPayment: summary.rows.filter((r) => r.paymentNumber === null).length,
    problems: summary.problems,
  };
}

/**
 * Fill an empty register from the summary exports already filed as documents.
 *
 * The register was built after the import that would have filled it, so it began life empty while
 * 1,346 payments from those very remittances sat on the books — and check 10 reported a clean bill
 * from no evidence at all. The files are not gone: every summary export read by the folder sweep
 * is kept as a document, which is exactly the copy this needs.
 *
 * Only when the register is empty. Once it holds anything, the imports keep it current and a
 * backfill re-reading old exports could only put back a payment number that has since changed.
 */
export async function fillRegisterFromFiledSummaries(): Promise<{ read: number; remembered: number }> {
  const already = await db.select({ id: schema.remittanceRegister.id }).from(schema.remittanceRegister).limit(1);
  if (already.length > 0) return { read: 0, remembered: 0 };

  const docs = await db
    .select({ storageKey: schema.documents.storageKey, title: schema.documents.title })
    .from(schema.documents)
    .where(eq(schema.documents.category, "report"));
  if (docs.length === 0) return { read: 0, remembered: 0 };

  const { readFile } = await import("./files");
  const { looksLikeRemitSummary } = await import("./mck-remit-csv");
  let read = 0;
  let remembered = 0;
  for (const d of docs) {
    if (!d.storageKey) continue;
    let text: string;
    try {
      text = (await readFile(d.storageKey)).toString("utf8");
    } catch {
      continue; // A document whose bytes are gone is not a reason to stop.
    }
    if (!looksLikeRemitSummary(text.slice(0, 4096))) continue;
    read += 1;
    const summary = readRemitSummary(text);
    if (summary.rows.length === 0) continue;
    await rememberRemittances(summary.rows, "providerpay remit summary (filed)");
    remembered += summary.rows.length;
  }
  return { read, remembered };
}

/**
 * Remittances whose money the payer says it has sent and which no cash receipt carries.
 *
 * The question nothing could ask on 18 September, when $99,238.84 of deposits had reached the bank
 * and the cash account knew about none of them. A remittance with no payment number is left out:
 * that is ProviderPay saying the deposit has not happened, which is money not yet owed to the cash
 * account rather than money missing from it.
 *
 * Reads only. It judges nothing and changes nothing — it reports a disagreement between two feeds
 * that should agree.
 */
export async function remittancesNotBanked(): Promise<{ remitNumber: string; payerName: string; remitOn: string | null; amountCents: number; paymentNumber: string }[]> {
  const rows = await db
    .select()
    .from(schema.remittanceRegister)
    .where(isNotNull(schema.remittanceRegister.paymentNumber));
  if (rows.length === 0) return [];

  const banked = await db
    .select({ sourceKey: schema.cashReceipts.sourceKey })
    .from(schema.cashReceipts)
    .where(eq(schema.cashReceipts.outOfBooks, false));
  const keys = banked.map((b) => (b.sourceKey ?? "").toLowerCase());

  return rows
    .filter((r) => {
      const n = (r.paymentNumber ?? "").trim().toLowerCase();
      return n.length > 0 && !keys.some((k) => k.includes(n));
    })
    .map((r) => ({ remitNumber: r.remitNumber, payerName: r.payerName, remitOn: r.remitOn, amountCents: r.amountCents, paymentNumber: r.paymentNumber! }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * Take the phantom revenue back off the payments this importer posted before it knew better.
 *
 * The first run of it on 18 September 2026 let `revenueCents` default to the whole amount, which
 * is what every other payment source wants and what this one must never have. A fill's revenue is
 * `remitCents + patientPaidCents + laterPaymentsCents`; the remittance is the `remitCents`
 * arriving, so counting it again invented profit that had never existed. 496 of the payments were
 * *exactly* the claim's own `remitCents` — $28,645.57 of September that was not real.
 *
 * Sets the revenue part to nought and leaves the amount alone: the cash is right and was always
 * right, and `receivedCents` is what the cash account reads. A query when there is nothing to do.
 */
export async function stopDoubleCountingRemitRevenue(): Promise<{ changed: number; centsRemoved: number }> {
  const wrong = await db
    .select({ id: schema.claimPayments.id, revenueCents: schema.claimPayments.revenueCents })
    .from(schema.claimPayments)
    .where(and(like(schema.claimPayments.reference, "ProviderPay %"), ne(schema.claimPayments.revenueCents, 0)));
  if (wrong.length === 0) return { changed: 0, centsRemoved: 0 };

  const centsRemoved = wrong.reduce((n, w) => n + (w.revenueCents ?? 0), 0);
  await db
    .update(schema.claimPayments)
    .set({ revenueCents: 0 })
    .where(and(like(schema.claimPayments.reference, "ProviderPay %"), ne(schema.claimPayments.revenueCents, 0)));
  return { changed: wrong.length, centsRemoved };
}

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

  /*
   * The register first, and for every remittance in the summary rather than only the ones posted.
   *
   * Its whole purpose is to know about money that has NOT arrived, so recording only what was
   * imported would leave exactly the rows that matter out of it. Written before anything posts so
   * a failure half way through still leaves the register able to say what was expected.
   */
  await rememberRemittances(summary.rows, "providerpay remit summary");

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
            /*
             * Received, and not new revenue. This is the single most expensive line in the file.
             *
             * A fill's revenue is `remitCents + patientPaidCents + laterPaymentsCents`
             * (fills.ts), where `remitCents` is what the plan agreed to pay at adjudication —
             * already counted, on the day the prescription went out. A primary remittance is that
             * same money arriving. Letting it default to the whole amount counts it twice: once
             * as what was earned and again as what turned up.
             *
             * Measured after doing exactly that on 18 September 2026: 496 of the payments posted
             * were *exactly* the claim's own `remitCents`, $28,645.57 of September revenue that
             * existed only because the remittance had been read. The owner found it before the
             * audit did — "net profit is so fucking wrong and I have no faith left in this site".
             *
             * `laterPayments()` maps `amountCents: revenueCents ?? amountCents`, so a zero here
             * is what keeps it off the margin while `receivedCents` still carries the cash. This
             * is the same distinction the RxRescue credit memo already uses, and the comment
             * there says it plainly: they differ only where a payment settles something the claim
             * already carried. A primary plan remittance always does.
             */
            revenueCents: 0,
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
