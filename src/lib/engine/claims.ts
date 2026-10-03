import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { SITE_STARTS_ON } from "../books-start";
import { payerCycles, cycleDays, type Cycles } from "./cycles";
import { payerNamer } from "./payers";
import { rules } from "./rules";

/**
 * Where every claim leg in the books stands: what the plan adjudicated, what has been paid (each payment once), by
 * what road, how long its plan group takes, and so whether it is paid, short, over, inside its cycle, past it,
 * never measured, a programme's, cash, a fee, or reversed after it was paid. One computation, written to
 * `claim_standing` on every engine pass and read by Claims, Today, the month's figures and Cash ahead, so the four
 * cannot disagree about what "owed" and "due" mean.
 *
 * The owner, 1 October 2026: "this new site need to be able to reconcile down to claim also. and show aged AR per
 * payor.. what scripts havent we been paid for". Fills before the books (books-start.ts) are not here at all.
 *
 * What settles a leg: a plan's payment, a secondary's, a copay card's and a hand-typed one in full; the RxRescue
 * credit less its top-off (the top-off is money the claim never carried). The facilitator's money is on top of the
 * plan's and is held against the claim's own facilitator expectation, never against the plan's. Tolerance is the
 * remit check's two cents. A leg the plan adjudicated nothing to itself on (the patient paid it all) is "none":
 * nothing owed, nothing paid, not a receivable and not a payment.
 */
export type StandingRow = typeof schema.claimStanding.$inferInsert;
export type ClaimState = (typeof schema.CLAIM_STATES)[number];

export const TOLERANCE_CENTS = 2;
/** Decisions that take a leg off every open list. */
export const TERMINAL_DECISIONS = new Set(["paid_elsewhere", "write_off", "settled", "not_ours"]);
/** States with money still open on them. */
export const OPEN_STATES = new Set<ClaimState>(["short", "unpaid", "due", "unmeasured", "programme"]);

export const legKey = (rx: string, fill: number | null | undefined, dateFilled: string, bin: string | null | undefined) => `${rx.trim()}|${fill ?? ""}|${dateFilled}|${bin ?? ""}`;

/**
 * A manufacturer programme is not a plan. The owner, 1 October 2026, of DST / ConnectiveRx (PCN CNRX, every claim
 * Wegovy): "dst IS a copay card!!!" It pays on its own terms and by its own route, which a programme_route rule
 * records once the first payment has shown them; until then its claims are a programme's, never a plan's late money.
 */
export const isProgramme = (payer: string, pcn: string | null | undefined) => /cnrx|connectiverx|copay|voucher|redsail|veridikal|dst pharmacy/i.test(`${payer} ${pcn ?? ""}`);

type ClaimRow = { id: string; rx_number: string; fill_number: number | null; date_filled: string; sold_on: string | null; ndc11: string | null; item_name: string | null; payer_raw: string | null; bin: string | null; pcn: string | null; group_number: string | null; status: string; cash_plan: number; remit_cents: number; expected_facilitator_cents: number | null };
type PaymentRow = { claim_id: string; source: string; amount_cents: number; revenue_cents: number | null; received_on: string | null; payer: string | null };
type AdjustmentRow = { claim_id: string; group_code: string; reason_code: string; amount_cents: number };
type DecisionRow = { leg_key: string; decision: string; note: string | null; revisit_on: string | null };

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** The part of a payment that settles the plan's adjudicated amount. */
export function settlingCents(p: { source: string; amount_cents: number; revenue_cents: number | null }): number {
  if (p.source === "mtf") return 0;
  if (p.source === "rxrescue") return p.amount_cents - (p.revenue_cents ?? 0);
  return p.amount_cents;
}

/** Pure: the standing of one leg from what is known about it. */
export function standingOf(
  c: ClaimRow,
  payments: PaymentRow[],
  adjustments: AdjustmentRow[],
  decision: DecisionRow | null,
  cycles: Cycles,
  canonical: (name: string | null | undefined) => string,
  programmeCycle: (payer: string, pcn: string | null) => number | null,
  today: string,
  now: string,
): StandingRow {
  const payer = canonical(c.payer_raw);
  const plan = payments.filter((p) => p.source !== "mtf");
  const paid = plan.reduce((n, p) => n + settlingCents(p), 0);
  const facilitatorPaid = payments.filter((p) => p.source === "mtf").reduce((n, p) => n + p.amount_cents, 0);
  const expected = c.remit_cents;
  const age = daysBetween(c.date_filled, today);
  const programme = isProgramme(payer, c.pcn);
  const route = [...new Set(payments.map((p) => p.payer).filter((x): x is string => !!x))].join(", ") || null;
  const days = payments.map((p) => p.received_on).filter((x): x is string => !!x).sort();
  const cycle = programme ? programmeCycle(payer, c.pcn) : cycleDays(cycles, payer, c.pcn, c.bin);
  const dueOn = cycle !== null ? addDays(c.date_filled, cycle) : null;

  let state: ClaimState;
  if (c.status === "reversed") state = paid > 0 ? "reversed_paid" : "reversed";
  else if (c.cash_plan) state = "cash";
  else if (expected < 0) state = "fee";
  else if (expected === 0) state = "none";
  else if (Math.abs(paid - expected) <= TOLERANCE_CENTS) state = "paid";
  else if (paid > expected) state = "over";
  else if (paid > 0) state = "short";
  else if (programme) state = cycle !== null && age > cycle ? "due" : "programme";
  else if (cycle === null) state = "unmeasured";
  else state = age > cycle ? "due" : "unpaid";

  /* A person said to wait: not due again until the day they named. */
  if (state === "due" && decision?.decision === "wait" && decision.revisit_on && decision.revisit_on > today) state = "unpaid";

  const reasons = adjustments.length
    ? JSON.stringify(
        [...adjustments.reduce((m, a) => m.set(`${a.group_code}-${a.reason_code}`, (m.get(`${a.group_code}-${a.reason_code}`) ?? 0) + a.amount_cents), new Map<string, number>())].map(([k, cents]) => ({ group: k.split("-")[0], reason: k.slice(k.indexOf("-") + 1), cents })),
      )
    : null;

  return {
    claimId: c.id,
    legKey: legKey(c.rx_number, c.fill_number, c.date_filled, c.bin),
    rxNumber: c.rx_number,
    fillNumber: c.fill_number,
    dateFilled: c.date_filled,
    soldOn: c.sold_on,
    ndc11: c.ndc11,
    itemName: c.item_name,
    payer,
    payerRaw: c.payer_raw,
    bin: c.bin,
    pcn: c.pcn,
    groupNumber: c.group_number,
    route,
    programme,
    expectedCents: expected,
    paidCents: paid,
    payments: plan.length,
    firstPaidOn: days[0] ?? null,
    lastPaidOn: days[days.length - 1] ?? null,
    facilitatorExpectedCents: c.expected_facilitator_cents ?? 0,
    facilitatorPaidCents: facilitatorPaid,
    state,
    ageDays: age,
    cycleDays: cycle,
    dueOn,
    shortCents: state === "reversed" || state === "reversed_paid" || state === "cash" || state === "fee" ? 0 : Math.max(0, expected - paid),
    reasons,
    decision: decision?.decision ?? null,
    decisionNote: decision ? [decision.note, decision.decision === "wait" && decision.revisit_on ? `until ${decision.revisit_on}` : null].filter(Boolean).join(" ") || null : null,
    computedAt: now,
  };
}

export async function computeClaimStanding(today: string, now = new Date().toISOString()): Promise<StandingRow[]> {
  const [cycles, canonical, routes, payments, adjustments, decisions] = await Promise.all([
    payerCycles(),
    payerNamer(),
    rules("programme_route"),
    db.all(sql`select claim_id, source, amount_cents, revenue_cents, received_on, payer from claim_payments where claim_id is not null and out_of_books = 0`) as Promise<PaymentRow[]>,
    db.all(sql`select p.claim_id, a.group_code, a.reason_code, a.amount_cents from payment_adjustments a join claim_payments p on p.id = a.payment_id where p.claim_id is not null and p.out_of_books = 0`) as Promise<AdjustmentRow[]>,
    db.all(sql`select leg_key, decision, note, revisit_on from claim_decisions where resolved_at is null`) as Promise<DecisionRow[]>,
  ]);
  const programmeCycle = (payer: string, pcn: string | null) => {
    const r = routes.find((x) => new RegExp(x.key, "i").test(`${payer} ${pcn ?? ""}`));
    return r && typeof r.value.cycleDays === "number" ? (r.value.cycleDays as number) : null;
  };
  const byClaim = new Map<string, PaymentRow[]>();
  for (const p of payments) byClaim.set(p.claim_id, [...(byClaim.get(p.claim_id) ?? []), p]);
  const adjByClaim = new Map<string, AdjustmentRow[]>();
  for (const a of adjustments) adjByClaim.set(a.claim_id, [...(adjByClaim.get(a.claim_id) ?? []), a]);
  const decByLeg = new Map(decisions.map((d) => [d.leg_key, d]));

  /* Every paid leg in the books, and the reversed legs a payment stands on (the rest of the reversals are nothing owed and nothing paid). */
  const claims = (await db.all(
    sql`select c.id, c.rx_number, c.fill_number, c.date_filled, c.sold_on, c.ndc11, c.item_name, coalesce(c.pbm_name, c.payer_label) payer_raw, c.bin, c.pcn, c.group_number, c.status, c.cash_plan, c.remit_cents, c.expected_facilitator_cents from claims c where c.date_filled >= ${SITE_STARTS_ON} and (c.status = 'paid' or (c.status = 'reversed' and c.id in (select claim_id from claim_payments where claim_id is not null and out_of_books = 0)))`,
  )) as ClaimRow[];
  return claims.map((c) => standingOf(c, byClaim.get(c.id) ?? [], adjByClaim.get(c.id) ?? [], decByLeg.get(legKey(c.rx_number, c.fill_number, c.date_filled, c.bin)) ?? null, cycles, canonical, programmeCycle, today, now));
}

export type StandingSummary = { rows: number; byState: Record<string, number>; owedCents: number; dueCents: number };

/** Rebuilt whole: the table is the engine's last answer, never a source of truth. */
export async function writeClaimStanding(rows: StandingRow[]): Promise<StandingSummary> {
  await db.delete(schema.claimStanding);
  for (let i = 0; i < rows.length; i += 200) await db.insert(schema.claimStanding).values(rows.slice(i, i + 200));
  const byState: Record<string, number> = {};
  let owedCents = 0;
  let dueCents = 0;
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    if (OPEN_STATES.has(r.state) && !TERMINAL_DECISIONS.has(r.decision ?? "")) owedCents += r.shortCents ?? 0;
    if (r.state === "due" && !TERMINAL_DECISIONS.has(r.decision ?? "")) dueCents += r.shortCents ?? 0;
  }
  return { rows: rows.length, byState, owedCents, dueCents };
}

export async function refreshClaimStanding(today: string, now = new Date().toISOString()): Promise<StandingSummary> {
  return writeClaimStanding(await computeClaimStanding(today, now));
}
