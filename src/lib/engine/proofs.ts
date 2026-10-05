import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "../crypto";
import { SITE_STARTS_ON } from "../books-start";
import type { MonthFigures } from "./month";
import { fmt } from "../dates";
import { formatCents } from "../money";
import { causeInfo, groupsSay, sourceToDo, tallyUntied, type TallyRow, type UntiedCause } from "../untied-payments";
import type { UntiedReading } from "../untied-payments-store";

/**
 * The proofs: what has to be true about the books, checked against the sources, every night, and kept.
 *
 * A figure on a screen is only as good as the proof under it, and the old site ran several of these into a
 * settings row nobody read (claims completeness found 38 fills short on 11 September and no screen showed it).
 * Every run is a row here: what was checked, whether it passed, the figures, the failing rows. Today shows the
 * latest run of each; a failure is a Today line.
 *
 * None of these invents a tolerance. A proof passes exactly or it fails and says by how much.
 */

export type ProofKey = "bank_to_cent" | "receipts_to_bank" | "claims_eq_pioneer" | "reader_arithmetic" | "remit_to_claim" | "expected_arrived" | "payments_once";

export type ProofResult = { proof: ProofKey; scope: string | null; passed: boolean; figures: Record<string, unknown>; says: string };

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function bankToCent(m: MonthFigures): ProofResult {
  if (m.bankLines === 0) return { proof: "bank_to_cent", scope: m.month, passed: false, figures: { lines: 0 }, says: `${m.month}: no bank statement is on file, so the month's cash is not yet proven.` };
  if (m.bankOpeningCents === null || m.bankClosingCents === null) {
    return { proof: "bank_to_cent", scope: m.month, passed: false, figures: { lines: m.bankLines }, says: `${m.month}: ${m.bankLines} lines on file, but the statement's opening and closing balances were not recorded, so the lines cannot be proven against them.` };
  }
  const reaches = m.bankOpeningCents + m.bankInCents - m.bankOutCents;
  const diff = m.bankClosingCents - reaches;
  const passed = diff === 0;
  return {
    proof: "bank_to_cent",
    scope: m.month,
    passed,
    figures: { opening: m.bankOpeningCents, in: m.bankInCents, out: m.bankOutCents, closing: m.bankClosingCents, reaches, diff, lines: m.bankLines, open: m.bankOpenLines },
    says: passed
      ? `${m.month}: opening ${money(m.bankOpeningCents)} + ${money(m.bankInCents)} in − ${money(m.bankOutCents)} out = closing ${money(m.bankClosingCents)}, to the cent, ${m.bankLines} lines${m.bankOpenLines ? `, ${m.bankOpenLines} not yet placed` : ""}.`
      : `${m.month}: the lines reach ${money(reaches)} and the statement closes at ${money(m.bankClosingCents)}: ${money(diff)} apart.`,
  };
}

export function receiptsToBank(m: MonthFigures): ProofResult {
  if (m.bankLines === 0) return { proof: "receipts_to_bank", scope: m.month, passed: false, figures: {}, says: `${m.month}: no bank statement to reconcile the receipts against.` };
  const unnamed = /with no bank line/.test(m.receiptsGapSays ?? "");
  return {
    proof: "receipts_to_bank",
    scope: m.month,
    passed: !unnamed,
    figures: { receipts: m.receiptsCents, bankIn: m.bankInCents, gap: m.receiptsGapCents },
    says: `${m.month}: receipts ${money(m.receiptsCents)} against ${money(m.bankInCents)} banked, ${money(m.receiptsGapCents)} apart — ${m.receiptsGapSays ?? "unexplained"}.`,
  };
}

export async function claimsEqualPioneer(): Promise<ProofResult> {
  const { claimsCompleteness } = await import("../claims-completeness");
  const c = await claimsCompleteness();
  if (!c) return { proof: "claims_eq_pioneer", scope: null, passed: false, figures: {}, says: "The nightly comparison with PioneerRx has not run yet." };
  const passed = c.missingFills === 0 && c.notAddingUp === 0;
  return {
    proof: "claims_eq_pioneer",
    scope: c.coverTo,
    passed,
    figures: { pioneerFills: c.pioneerFills, siteFills: c.siteFills, missingFills: c.missingFills, missingCents: c.missingCents, notAddingUp: c.notAddingUp, readAt: c.readAt, missingByDay: c.missingByDay.slice(0, 10) },
    says: passed
      ? `Every fill PioneerRx holds through ${c.coverTo ?? "the last pull"} is on file: ${c.siteFills.toLocaleString("en-US")} fills.`
      : `PioneerRx holds ${c.missingFills} fill${c.missingFills === 1 ? "" : "s"} (${money(c.missingCents)}) the site does not${c.notAddingUp ? `, and ${c.notAddingUp} fill${c.notAddingUp === 1 ? "" : "s"} whose payers and patient do not add to the fill's price` : ""}.`,
  };
}

export async function readerArithmetic(today: string): Promise<ProofResult> {
  const since = `${new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10)}T00:00:00`;
  const rows = await db.query.inboxItems.findMany({ where: and(eq(schema.inboxItems.status, "stored"), gte(schema.inboxItems.receivedAt, since)), columns: { id: true, imported: true, routedAs: true, routeResult: true } });
  const held = rows.filter((r) => r.imported === false && !/needs the model/i.test(r.routeResult ?? ""));
  const unrecognised = rows.filter((r) => r.routedAs === "unrecognised");
  const passed = held.length === 0 && unrecognised.length === 0;
  return {
    proof: "reader_arithmetic",
    scope: null,
    passed,
    figures: { arrived: rows.length, held: held.length, unrecognised: unrecognised.length },
    says: passed
      ? `${rows.length} documents in 30 days, every one read and counted.`
      : `${rows.length} documents in 30 days: ${held.length} held by a reader that could not prove them${unrecognised.length ? `, ${unrecognised.length} not recognised at all` : ""}.`,
  };
}

/** What the proof reads of one month: the payments received in it for fills inside the books, with nothing that names a prescription. */
export type RemitMonth = {
  /** Tied to the claim each paid. */
  tied: { count: number; cents: number };
  /** Tied to no claim, each with the reason the Payments page gives it. */
  untied: { cause: UntiedCause; amountCents: number }[];
  /** Received that month for fills from before the books begin, tied or not: cash, never receivable, and not judged here. */
  beforeBooks: { count: number; cents: number };
  /** The first day the claims feed covers; the Payments page's words for each group depend on it. */
  feedFrom: string | null;
};

const paymentsOf = (n: number) => `${n.toLocaleString("en-US")} payment${n === 1 ? "" : "s"}`;
/* "net" over more than one payment, because a take-back is a payment of less than nothing. */
const sumOf = (n: number, cents: number) => `${n === 1 ? "" : "net "}${formatCents(cents)}`;
const isAre = (n: number) => (n === 1 ? "is" : "are");
const addUp = (rows: TallyRow[]) => rows.reduce((t, r) => ({ count: t.count + r.count, cents: t.cents + r.cents }), { count: 0, cents: 0 });

/**
 * Money received for a fill inside the books is applied to the claim it paid or explained, and the explanation is the Payments page's
 * (untied-payments.ts), so no screen can say of a payment what this does not. It passes when every payment is tied to a claim or is one that page
 * says needs nothing: a payment and its exact take-back, one on a claim that was reversed and never sold, one for a fill from before the claims feed.
 * It fails, saying which and how much, when any needs a decision, a look, or the next claims load.
 */
export function judgeRemitToClaim(month: string, m: RemitMonth): ProofResult {
  const by = tallyUntied(m.untied);
  const open = by.filter((r) => causeInfo(r.cause, m.feedFrom).needs !== "nothing");
  const idle = by.filter((r) => causeInfo(r.cause, m.feedFrom).needs === "nothing");
  const o = addUp(open);
  const i = addUp(idle);
  const passed = open.length === 0;
  /* A month nothing came in for is measured and none, which is not "every payment is tied". */
  const noneIn = m.tied.count === 0 && by.length === 0;
  const says = [
    passed
      ? noneIn
        ? "no payment for a fill inside the books was received."
        : `every payment received for a fill inside the books is tied to a claim${idle.length > 0 ? " or needs nothing" : ""}.`
      : `${paymentsOf(o.count)} (${sumOf(o.count, o.cents)}) received for ${o.count === 1 ? "a fill" : "fills"} inside the books ${isAre(o.count)} tied to no claim and still open. ${sourceToDo(open, m.feedFrom)}`,
    m.tied.count > 0 ? `${paymentsOf(m.tied.count)} (${sumOf(m.tied.count, m.tied.cents)}) ${isAre(m.tied.count)} tied to the claim ${m.tied.count === 1 ? "it" : "each"} paid.` : "",
    idle.length > 0 ? `Tied to no claim and needing nothing: ${groupsSay(idle, m.feedFrom)}.` : "",
    m.beforeBooks.count > 0 ? `Separately, ${paymentsOf(m.beforeBooks.count)} (${sumOf(m.beforeBooks.count, m.beforeBooks.cents)}) ${isAre(m.beforeBooks.count)} for ${m.beforeBooks.count === 1 ? "a fill" : "fills"} from before ${fmt(SITE_STARTS_ON)}: cash received, never receivable, and not judged here.` : "",
  ]
    .filter((s) => s !== "")
    .join(" ");
  return {
    proof: "remit_to_claim",
    scope: month,
    passed,
    figures: { tied: m.tied.count, tiedCents: m.tied.cents, untied: o.count + i.count, untiedCents: o.cents + i.cents, open: o.count, openCents: o.cents, byCause: by, beforeBooks: m.beforeBooks.count, beforeBooksCents: m.beforeBooks.cents },
    says: `${month}: ${says}`,
  };
}

/** Every payment received in the month, of every source, for a fill inside the books or naming no fill date. `reading` is the Payments page's, read once for all the months. */
export async function remitToClaim(month: string, reading?: Pick<UntiedReading, "each" | "feedFrom">): Promise<ProofResult> {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const read = reading ?? (await (await import("../untied-payments-store")).untiedPayments());
  const r = (await db.all(
    sql`select sum(case when claim_id is not null and (date_filled is null or date_filled >= ${SITE_STARTS_ON}) then 1 else 0 end) tied, sum(case when claim_id is not null and (date_filled is null or date_filled >= ${SITE_STARTS_ON}) then amount_cents else 0 end) tied_cents, sum(case when date_filled < ${SITE_STARTS_ON} then 1 else 0 end) before_books, sum(case when date_filled < ${SITE_STARTS_ON} then amount_cents else 0 end) before_books_cents from claim_payments where out_of_books = 0 and received_on >= ${from} and received_on <= ${to}`,
  )) as { tied: number | null; tied_cents: number | null; before_books: number | null; before_books_cents: number | null }[];
  const f = r[0];
  return judgeRemitToClaim(month, {
    tied: { count: f?.tied ?? 0, cents: f?.tied_cents ?? 0 },
    untied: read.each.filter((e) => e.receivedOn !== null && e.receivedOn >= from && e.receivedOn <= to && (e.dateFilled === null || e.dateFilled >= SITE_STARTS_ON)),
    beforeBooks: { count: f?.before_books ?? 0, cents: f?.before_books_cents ?? 0 },
    feedFrom: read.feedFrom,
  });
}

/**
 * Every payment stands once. The same money recorded from two kinds of document (the 835 and a report) read as an
 * over-payment on 752 claims on 1 October 2026; recordClaimPayment now refuses the second, and this is the check that
 * the refusal holds. Two rows from the same kind of document are the reader's own double lines and are not counted.
 */
export async function paymentsOnce(): Promise<ProofResult> {
  const { originClass, legacyOrigin } = await import("../payment-origin");
  const pairs = (await db.all(
    sql`select a.amount_cents cents, a.notes na, a.reference ra, a.source sa, a.payer pa, a.origin oa, b.notes nb, b.reference rb, b.source sb, b.payer pb, b.origin ob from claim_payments a join claim_payments b on b.claim_id = a.claim_id and b.id > a.id and b.amount_cents = a.amount_cents and b.received_on = a.received_on and b.source = a.source where a.claim_id is not null and a.out_of_books = 0`,
  )) as { cents: number; na: string | null; ra: string | null; sa: string; pa: string | null; oa: string | null; nb: string | null; rb: string | null; sb: string; pb: string | null; ob: string | null }[];
  const twice = pairs.filter((p) => originClass(p.oa ?? legacyOrigin({ notes: p.na, reference: p.ra, source: p.sa, payer: p.pa })) !== originClass(p.ob ?? legacyOrigin({ notes: p.nb, reference: p.rb, source: p.sb, payer: p.pb })));
  const cents = twice.reduce((n, p) => n + p.cents, 0);
  const passed = twice.length === 0;
  return {
    proof: "payments_once",
    scope: null,
    passed,
    figures: { pairs: pairs.length, twice: twice.length, cents },
    says: passed
      ? `Every payment stands once against its claim${pairs.length ? ` (${pairs.length} same-day pairs on file are one document's own double lines)` : ""}.`
      : `${twice.length} payments stand twice against their claim (${money(cents)}): the same money from two kinds of document. scripts/support/dedup-payments.ts removes the second.`,
  };
}

export async function expectedArrived(): Promise<ProofResult> {
  const rows = await db.query.feedState.findMany();
  const overdue = rows.filter((r) => r.state === "overdue");
  const never = rows.filter((r) => r.state === "never_arrived");
  const passed = overdue.length === 0;
  return {
    proof: "expected_arrived",
    scope: null,
    passed,
    figures: { judged: rows.length, overdue: overdue.map((r) => r.key), never: never.map((r) => r.key) },
    says: passed
      ? `${rows.length} expectations judged; nothing is overdue${never.length ? ` (${never.length} expected and never seen)` : ""}.`
      : `${overdue.length} feed${overdue.length === 1 ? " is" : "s are"} overdue: ${overdue.map((r) => r.name).join(", ")}.`,
  };
}

export async function writeProofs(results: ProofResult[], now: string): Promise<number> {
  for (const r of results) {
    await db.insert(schema.proofRun).values({ id: newId(), proof: r.proof, scope: r.scope, runAt: now, passed: r.passed, figures: JSON.stringify(r.figures), says: r.says });
  }
  return results.length;
}
