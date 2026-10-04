import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { SITE_STARTS_ON } from "./books-start";
import { claimsFeedStartsOn, claimsOnFile } from "./claims-on-file";
import { isProgrammePayment } from "./payer-owed";
import { CAUSES, classifyUntied, tallyUntied, untiedHeadline, type TallyRow, type UntiedCause, type UntiedPayment } from "./untied-payments";

/*
 * Every payment received since the books begin that ties to no claim, and why. Read-only: it changes nothing and decides
 * nothing. The cause is the matcher's own answer (untied-payments.ts), reached the way attaching a payment reaches it.
 */

/** A claim a payment is shown beside: enough to recognise it without opening it. */
export type ClaimBeside = {
  id: string;
  payerLabel: string | null;
  itemName: string | null;
  status: "paid" | "reversed";
  fillNumber: number | null;
  dateFilled: string;
  remitCents: number | null;
  soldOn: string | null;
};

export type UntiedLine = UntiedPayment & { cause: UntiedCause; claims: ClaimBeside[] };

/** Payments for fills from before the claims feed, counted by who paid and not listed line by line. */
export type BeforeFeedRow = { source: string; count: number; cents: number };

export type UntiedPayments = {
  booksFrom: string;
  feedFrom: string | null;
  total: { count: number; cents: number };
  tally: TallyRow[];
  beforeFeed: BeforeFeedRow[];
  /** Every payment but the before-feed ones, in the order of CAUSES and newest received first within a cause. */
  lines: UntiedLine[];
  headline: string;
};

const byNewest = (a: UntiedLine, b: UntiedLine): number =>
  CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause) || (b.receivedOn ?? "").localeCompare(a.receivedOn ?? "") || a.id.localeCompare(b.id);

export async function untiedPayments(): Promise<UntiedPayments> {
  const rows: UntiedPayment[] = await db.query.claimPayments.findMany({
    where: and(isNull(schema.claimPayments.claimId), eq(schema.claimPayments.outOfBooks, false)),
    columns: { id: true, source: true, payer: true, receivedOn: true, amountCents: true, rxNumber: true, fillNumber: true, dateFilled: true, ndc11: true, reference: true },
  });
  const feedFrom = await claimsFeedStartsOn();
  /* Every prescription, early fills included: a claim for a fill from before the feed can have come in a later report. */
  const onFile = await claimsOnFile(rows.map((p) => p.rxNumber));

  const lines: UntiedLine[] = [];
  const classified: { cause: UntiedCause; amountCents: number }[] = [];
  const before = new Map<string, BeforeFeedRow>();
  for (const p of rows) {
    const held = onFile.get(p.rxNumber) ?? [];
    const { cause, claimIds } = classifyUntied(p, held, feedFrom, isProgrammePayment(p));
    classified.push({ cause, amountCents: p.amountCents });
    if (cause === "before_feed") {
      const b = before.get(p.source) ?? { source: p.source, count: 0, cents: 0 };
      b.count++;
      b.cents += p.amountCents;
      before.set(p.source, b);
      continue;
    }
    const claims = held
      .filter((h) => claimIds.includes(h.id))
      .sort((a, b) => a.dateFilled.localeCompare(b.dateFilled) || (a.fillNumber ?? 0) - (b.fillNumber ?? 0))
      .map((h) => ({ id: h.id, payerLabel: h.payerLabel, itemName: h.itemName, status: h.status, fillNumber: h.fillNumber, dateFilled: h.dateFilled, remitCents: h.remitCents, soldOn: h.soldOn }));
    lines.push({ ...p, cause, claims });
  }

  const tally = tallyUntied(classified);
  return {
    booksFrom: SITE_STARTS_ON,
    feedFrom,
    total: { count: rows.length, cents: rows.reduce((n, p) => n + p.amountCents, 0) },
    tally,
    beforeFeed: [...before.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    lines: lines.sort(byNewest),
    headline: untiedHeadline(tally, SITE_STARTS_ON, feedFrom),
  };
}
