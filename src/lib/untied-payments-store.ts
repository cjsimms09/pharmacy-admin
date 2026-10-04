import "server-only";
import { and, eq, gte, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { SITE_STARTS_ON } from "./books-start";
import { claimsFeedStartsOn, claimsOnFile, type ClaimHeld } from "./claims-on-file";
import { isProgrammePayment } from "./payer-owed";
import { CAUSES, classifyUntied, tallyUntied, untiedHeadline, type ClaimBeside, type TallyRow, type UntiedCause, type UntiedPayment } from "./untied-payments";

/*
 * Every payment received since the books begin that ties to no claim, and why. Read-only: it changes nothing and decides
 * nothing. The cause is the matcher's own answer (untied-payments.ts), reached the way attaching a payment reaches it.
 */

export type UntiedLine = UntiedPayment & { cause: UntiedCause; claims: ClaimBeside[] };

/** Payments for fills from before the claims feed, counted by who paid and not listed line by line. */
export type BeforeFeedRow = { source: string; count: number; cents: number };

export type UntiedReading = {
  booksFrom: string;
  feedFrom: string | null;
  total: { count: number; cents: number };
  tally: TallyRow[];
  beforeFeed: BeforeFeedRow[];
  /** Every payment but the before-feed ones, in the order of CAUSES and newest received first within a cause. */
  lines: UntiedLine[];
};

export type UntiedPayments = UntiedReading & { headline: string };

const COLUMNS = { id: true, source: true, payer: true, receivedOn: true, amountCents: true, rxNumber: true, fillNumber: true, dateFilled: true, ndc11: true, reference: true } as const;

const byNewest = (a: UntiedLine, b: UntiedLine): number =>
  CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause) || (b.receivedOn ?? "").localeCompare(a.receivedOn ?? "") || a.id.localeCompare(b.id);

/** One payment read by the claims the site holds for its prescription, early fills' claims included: one can have come in a later report. */
function classifyOne(p: UntiedPayment, onFile: Map<string, ClaimHeld[]>, feedFrom: string | null) {
  const held = onFile.get(p.rxNumber) ?? [];
  return { held, ...classifyUntied(p, held, feedFrom, isProgrammePayment(p)) };
}

async function classifyAll(rows: UntiedPayment[], feedFrom: string | null) {
  const onFile = await claimsOnFile(rows.map((p) => p.rxNumber));
  const lines: UntiedLine[] = [];
  const classified: { cause: UntiedCause; amountCents: number }[] = [];
  const before = new Map<string, BeforeFeedRow>();
  for (const p of rows) {
    const { held, cause, claimIds } = classifyOne(p, onFile, feedFrom);
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
  return { lines: lines.sort(byNewest), classified, before };
}

/** The cause of each of these payments, read the way the payments-with-no-claim page reads them, so a page that counts them names the same causes. */
export async function causesOf(rows: UntiedPayment[]): Promise<{ feedFrom: string | null; causes: Map<string, UntiedCause> }> {
  const feedFrom = await claimsFeedStartsOn();
  const onFile = await claimsOnFile(rows.map((p) => p.rxNumber));
  return { feedFrom, causes: new Map(rows.map((p) => [p.id, classifyOne(p, onFile, feedFrom).cause])) };
}

async function readUntied(source: string | null): Promise<UntiedReading> {
  const rows: UntiedPayment[] = await db.query.claimPayments.findMany({
    where: and(isNull(schema.claimPayments.claimId), eq(schema.claimPayments.outOfBooks, false), source === null ? undefined : eq(schema.claimPayments.source, source)),
    columns: COLUMNS,
  });
  const feedFrom = await claimsFeedStartsOn();
  const { lines, classified, before } = await classifyAll(rows, feedFrom);
  return {
    booksFrom: SITE_STARTS_ON,
    feedFrom,
    total: { count: rows.length, cents: rows.reduce((n, p) => n + p.amountCents, 0) },
    tally: tallyUntied(classified),
    beforeFeed: [...before.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    lines,
  };
}

export async function untiedPayments(): Promise<UntiedPayments> {
  const r = await readUntied(null);
  return { ...r, headline: untiedHeadline(r.tally, r.booksFrom, r.feedFrom) };
}

/** The same reading for the payments of one source alone. It has no headline: "every payment is tied" would be said of one source and read as all. */
export const untiedPaymentsFrom = (source: string): Promise<UntiedReading> => readUntied(source);

/**
 * The two groups the morning list speaks of, the payments for a prescription the site holds no claim for at all, read without the thousands
 * of payments for fills from before the claims feed. Those can be in neither group: one for a fill from before the feed is for a fill the site
 * holds a claim for (a group of its own) or for none (counted apart), so the same classifier, over fewer rows, gives the same two groups.
 */
export async function paymentsWithNoClaimOnFile(): Promise<{ feedFrom: string | null; stranded: UntiedLine[]; notAFill: UntiedLine[] }> {
  const feedFrom = await claimsFeedStartsOn();
  const rows: UntiedPayment[] = await db.query.claimPayments.findMany({
    where: and(
      isNull(schema.claimPayments.claimId),
      eq(schema.claimPayments.outOfBooks, false),
      feedFrom === null ? undefined : or(isNull(schema.claimPayments.dateFilled), gte(schema.claimPayments.dateFilled, feedFrom)),
    ),
    columns: COLUMNS,
  });
  const { lines } = await classifyAll(rows, feedFrom);
  return { feedFrom, stranded: lines.filter((l) => l.cause === "no_claim_yet"), notAFill: lines.filter((l) => l.cause === "not_a_fill") };
}
