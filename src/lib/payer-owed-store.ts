import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { owedByPayer, type Receivable, type Received, type OwedSummary } from "./payer-owed";

/**
 * Loads what each payer owes: its own receivables from the fills, and what has actually arrived.
 *
 * ── Scoped on the fill date, and the column says so ──
 *
 * There are two dates a claim can be counted on now, and since the evening of 9 September they give
 * different answers: revenue is recognised when the patient collects the prescription, so the
 * month's takings are scoped on `soldOn`. This page is deliberately **not**.
 *
 * A payer's obligation begins when the claim adjudicates. It does not wait for the patient to walk
 * in, and 494 September fills are still sitting in the will-call bin — scoping this on the sold date
 * would hide every one of their payers' receivables behind an event the payer has nothing to do
 * with. So the period here means "filled in", the page says which basis it is on rather than
 * leaving it to be inferred, and the two figures are allowed to differ because they answer
 * different questions.
 *
 * ── Which payer a payment belongs to ──
 *
 * Through the claim it settled, and not through the remittance's own naming. `claim_payments` holds
 * no BIN of its own — the `bin` on `RecordPayment` is a hint the matcher uses to pick between two
 * payers on one fill, and it is not stored — so the claim's BIN is the answer, and it is the better
 * one anyway: it is what the pharmacy billed rather than what the payer called itself.
 *
 * A payment with no claim behind it therefore has no payer here, which is correct. It is money
 * received for a prescription this site does not hold, and `payer-owed.ts` counts it apart.
 *
 * ── Two matchers for one thing, avoided ──
 *
 * The receivable is `payerShares`, the site's one answer to "what did this payer say it would pay".
 * Nothing is recomputed from remit columns here; if that convention changes, this changes with it.
 */

/**
 * The two lists the answer is made of, loaded once.
 *
 * Split out from `owedNow` so the month-end report (`ar-report.ts`) can ask its own questions of the
 * same rows rather than rebuild them. It has to: a report as at 30 September must not be settled by
 * a payment that arrived in October, and it ages the balance claim by claim, neither of which can be
 * done from a summary that has already added everything up. The alternative was a second loader
 * beside this one, which is the exact mistake the note above this function warns against — two
 * matchers for one thing, disagreeing quietly.
 */
export async function owedRows(range?: { from?: string; to?: string }): Promise<{ receivables: Receivable[]; received: Received[]; from: string; to: string }> {
  const { addDays, todayIso } = await import("./dates");
  const today = todayIso();
  const from = range?.from ?? addDays(today, -400).slice(0, 7) + "-01";
  const to = range?.to ?? "9999-12-31";

  const [fills, plans, payments] = await Promise.all([
    (await import("./claims")).allFills({ from, to }),
    db.query.cashPlans.findMany({ columns: { bin: true, pcn: true, name: true } }),
    /*
     * Every payment, with the BIN of the claim it settled. Left join: a payment matching nothing
     * still has to be counted, as its own fact, rather than dropped by the join that was looking
     * for its payer.
     */
    db
      .select({
        amountCents: schema.claimPayments.amountCents,
        receivedOn: schema.claimPayments.receivedOn,
        claimId: schema.claimPayments.claimId,
        payer: schema.claimPayments.payer,
        claimBin: schema.claims.bin,
        claimPayer: schema.claims.pbmName,
      })
      .from(schema.claimPayments)
      .leftJoin(schema.claims, eq(schema.claimPayments.claimId, schema.claims.id))
      /*
       * Never test money. This is the receivables list — what payers still owe — and it is the
       * report the owner named: "these are test only and should not show up on any AR reports or
       * anything." A payment from before the books begin settles nothing here, because the fill it
       * settled is not in here either.
       */
      .where(eq(schema.claimPayments.outOfBooks, false)),
  ]);

  const { payerShares } = await import("./fills");
  const { cashPlanFor } = await import("./cash-plans");

  const receivables: Receivable[] = [];
  for (const f of fills) {
    // Once per fill, not once per payer: this loop runs over every fill the pharmacy has.
    const shares = payerShares(f);
    for (let i = 0; i < f.payers.length; i++) {
      const p = f.payers[i];
      receivables.push({
        bin: p.bin,
        name: p.name ?? null,
        dateFilled: f.dateFilled,
        /*
         * `payerShares` returns one share per payer in the same order, so the index is the join.
         * Matching on bin and name instead would merge two rows of a fill billed twice to one BIN.
         */
        cents: shares[i]?.receivableCents ?? p.remitCents,
        /*
         * Asked of the plan register rather than taken off the fill. `Fill.cashPlan` is true when
         * the whole fill was cash-priced; a coordinated fill can carry one cash plan and one that
         * really pays, and only the plan itself knows which is which.
         */
        cashPlan: cashPlanFor(p.bin, p.pcn, plans) !== null,
      });
    }
  }

  const received: Received[] = payments.map((p) => ({
    bin: p.claimBin,
    payer: p.claimPayer ?? p.payer,
    cents: p.amountCents,
    receivedOn: p.receivedOn,
    /*
     * Matched means it found a claim, which is what makes it somebody's settled receivable. The 24
     * facilitator payments on file are all unmatched and correctly so: they are for fills between
     * January and August, and this site's records begin on 1 September.
     */
    matched: p.claimId !== null,
  }));

  return { receivables, received, from, to };
}

/** What arrived and what was billed, for the payer page. `from`/`to` are fill dates. */
export async function owedNow(range?: { from?: string; to?: string }): Promise<OwedSummary & { from: string; to: string; basis: "filled" }> {
  const { todayIso } = await import("./dates");
  const { receivables, received, from, to } = await owedRows(range);
  return { ...owedByPayer(receivables, received, todayIso()), from, to, basis: "filled" };
}
