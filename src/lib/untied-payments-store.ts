import "server-only";
import { and, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { SITE_STARTS_ON } from "./books-start";
import { claimsFeedStartsOn, claimsOnFile, type ClaimHeld } from "./claims-on-file";
import { isProgrammePayment } from "./payer-owed";
import { CAUSES, cancellingPairs, classifyUntied, takeBacksWithPartner, tallyUntied, untiedHeadline, type CancelPartner, type ClaimBeside, type TallyRow, type UntiedCause, type UntiedPayment } from "./untied-payments";

/*
 * Every payment received since the books begin that ties to no claim, and why, and the ones the owner tied by hand. Read-only: it changes
 * nothing and decides nothing (tie-by-hand.ts is what changes a payment). The cause is the matcher's own answer (untied-payments.ts),
 * reached the way attaching a payment reaches it.
 */

export type UntiedLine = UntiedPayment & { cause: UntiedCause; claims: ClaimBeside[]; partner: CancelPartner | null };

/** Payments for fills from before the claims feed, counted by who paid and not listed line by line. */
export type BeforeFeedRow = { source: string; count: number; cents: number };

/** One payment as a count by month needs it: when it came and for which day's fill, who paid, how much and why it is tied to no claim, and nothing that names a prescription. */
export type UntiedEach = { source: string; receivedOn: string | null; dateFilled: string | null; amountCents: number; cause: UntiedCause };

export type UntiedReading = {
  booksFrom: string;
  feedFrom: string | null;
  total: { count: number; cents: number };
  tally: TallyRow[];
  beforeFeed: BeforeFeedRow[];
  /** Every payment read, the before-feed ones too, each read among all the others so that a pair is a pair whichever month either half came in. */
  each: UntiedEach[];
  /** Every payment but the before-feed ones, in the order of CAUSES and newest received first within a cause. */
  lines: UntiedLine[];
};

export type UntiedPayments = UntiedReading & { headline: string };

const COLUMNS = { id: true, source: true, payer: true, receivedOn: true, amountCents: true, rxNumber: true, fillNumber: true, dateFilled: true, ndc11: true, reference: true } as const;

/** A claim as a person recognises it beside a payment: who it was billed to, the drug, the fill, its state and amount. */
const besideOf = (h: ClaimHeld): ClaimBeside => ({ id: h.id, payerLabel: h.payerLabel, itemName: h.itemName, status: h.status, fillNumber: h.fillNumber, dateFilled: h.dateFilled, remitCents: h.remitCents, soldOn: h.soldOn });

/* A pair is listed together: it sorts by the later of its two received dates and then by its own id, the payment before its take-back. */
const received = (l: UntiedLine): string => (l.partner && (l.partner.receivedOn ?? "") > (l.receivedOn ?? "") ? l.partner.receivedOn : l.receivedOn) ?? "";
const pairId = (l: UntiedLine): string => (l.partner && l.partner.id < l.id ? l.partner.id : l.id);

const byNewest = (a: UntiedLine, b: UntiedLine): number =>
  CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause) || received(b).localeCompare(received(a)) || pairId(a).localeCompare(pairId(b)) || b.amountCents - a.amountCents;

/** One payment read by the claims the site holds for its prescription, early fills' claims included: one can have come in a later report. */
function classifyOne(p: UntiedPayment, onFile: Map<string, ClaimHeld[]>, feedFrom: string | null, partnerWaiting = false) {
  const held = onFile.get(p.rxNumber) ?? [];
  return { held, ...classifyUntied(p, held, feedFrom, isProgrammePayment(p), partnerWaiting) };
}

/**
 * Each payment read by the claims the site holds for it, and then the payments that cancel one another set apart as such, each beside the one that cancels it.
 * `onFile` must say what is tied to each claim (`withTied`), or no take-back is read as belonging to one.
 */
function readEach(rows: UntiedPayment[], onFile: Map<string, ClaimHeld[]>, feedFrom: string | null) {
  const first = rows.map((p) => ({ p, ...classifyOne(p, onFile, feedFrom) }));
  /* A take-back with a payment of its own waiting beside it is that payment's to cancel, and is read so: attaching it reads it the same way (`partnerWaiting`). */
  const withPartner = takeBacksWithPartner(first.map((r) => ({ ...r.p, cause: r.cause })));
  const read = first.map((r) => (withPartner.has(r.p.id) ? { p: r.p, ...classifyOne(r.p, onFile, feedFrom, true) } : r));
  const partner = cancellingPairs(read.map((r) => ({ ...r.p, cause: r.cause })));
  const byId = new Map(rows.map((p) => [p.id, p]));
  return read.map((r) => {
    const other = byId.get(partner.get(r.p.id) ?? "");
    if (!other) return { ...r, partner: null };
    return { ...r, cause: "cancels_out" as UntiedCause, partner: { id: other.id, amountCents: other.amountCents, receivedOn: other.receivedOn } };
  });
}

async function classifyAll(rows: UntiedPayment[], feedFrom: string | null) {
  const onFile = await claimsOnFile(rows.map((p) => p.rxNumber), { withTied: true });
  const lines: UntiedLine[] = [];
  const classified: UntiedEach[] = [];
  const before = new Map<string, BeforeFeedRow>();
  for (const { p, held, cause, claimIds, partner } of readEach(rows, onFile, feedFrom)) {
    classified.push({ cause, amountCents: p.amountCents, source: p.source, receivedOn: p.receivedOn, dateFilled: p.dateFilled });
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
      .map(besideOf);
    lines.push({ ...p, cause, claims, partner });
  }
  return { lines: lines.sort(byNewest), classified, before };
}

/** The cause of each of these payments, read the way the payments-with-no-claim page reads them, so a page that counts them names the same causes. */
export async function causesOf(rows: UntiedPayment[]): Promise<{ feedFrom: string | null; causes: Map<string, UntiedCause> }> {
  const feedFrom = await claimsFeedStartsOn();
  const onFile = await claimsOnFile(rows.map((p) => p.rxNumber), { withTied: true });
  /*
   * The payment that cancels one is nearly always on another remittance than its own, so the pairs are read among every payment in the books
   * that is tied to no claim for these prescriptions, the ones given and the ones not.
   */
  const wanted = new Set(rows.map((p) => p.rxNumber));
  const everyone: UntiedPayment[] = (
    await db.query.claimPayments.findMany({ where: and(isNull(schema.claimPayments.claimId), eq(schema.claimPayments.outOfBooks, false)), columns: COLUMNS })
  ).filter((p) => wanted.has(p.rxNumber));
  const causes = new Map<string, UntiedCause>(readEach(everyone, onFile, feedFrom).map((r) => [r.p.id, r.cause]));
  /* A payment from before the books begin, or tied since it was read, is read on its own: only payments in the books are paired. */
  for (const p of rows) if (!causes.has(p.id)) causes.set(p.id, classifyOne(p, onFile, feedFrom).cause);
  return { feedFrom, causes };
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
    each: classified,
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

/**
 * What one payment fits, read the way the page reads it, among every payment of its prescription that is tied to no claim, so that a pair is a
 * pair. Null where the payment is not waiting for a claim: it was tied since the page was drawn, or it was received before the books begin.
 * The press that acts on one payment asks this at the press and acts on what is true then, not on what the page said when it was drawn.
 */
export async function whatItFits(paymentId: string): Promise<{ payment: UntiedPayment; cause: UntiedCause; claimIds: string[] } | null> {
  const payment: UntiedPayment | undefined = await db.query.claimPayments.findFirst({
    where: and(eq(schema.claimPayments.id, paymentId), isNull(schema.claimPayments.claimId), eq(schema.claimPayments.outOfBooks, false)),
    columns: COLUMNS,
  });
  if (!payment) return null;
  const siblings: UntiedPayment[] = await db.query.claimPayments.findMany({
    where: and(isNull(schema.claimPayments.claimId), eq(schema.claimPayments.outOfBooks, false), eq(schema.claimPayments.rxNumber, payment.rxNumber)),
    columns: COLUMNS,
  });
  const onFile = await claimsOnFile([payment.rxNumber], { withTied: true });
  const read = readEach(siblings, onFile, await claimsFeedStartsOn()).find((r) => r.p.id === payment.id);
  return read ? { payment, cause: read.cause, claimIds: read.claimIds } : null;
}

/** A payment the owner tied to a claim by hand, beside the claim he chose: what the page lists so that a choice can be taken back. */
export type HandTied = UntiedPayment & { tiedBy: string; claim: ClaimBeside | null };

/** Every payment tied by hand, newest received first. Read-only. */
export async function handTied(): Promise<HandTied[]> {
  const rows = await db.query.claimPayments.findMany({
    where: and(isNotNull(schema.claimPayments.tiedBy), isNotNull(schema.claimPayments.claimId)),
    columns: { ...COLUMNS, claimId: true, tiedBy: true },
  });
  if (rows.length === 0) return [];
  const onFile = await claimsOnFile(rows.map((r) => r.rxNumber));
  const claims = new Map([...onFile.values()].flat().map((c) => [c.id, c]));
  return rows
    .map(({ claimId, tiedBy, ...p }) => {
      const held = claimId === null ? undefined : claims.get(claimId);
      return { ...p, tiedBy: tiedBy ?? "", claim: held ? besideOf(held) : null };
    })
    .sort((a, b) => (b.receivedOn ?? "").localeCompare(a.receivedOn ?? "") || a.id.localeCompare(b.id));
}
