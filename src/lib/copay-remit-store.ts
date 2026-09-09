import "server-only";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { parseCopayRemit, COPAY_PAYER, COPAY_BIN, SITE_STARTS_ON, type CopayRemitNetLine } from "./copay-remit";

/**
 * Loads a copay-voucher remittance and records what it paid against the fills it names.
 *
 * RedSail is about to push these to the pharmacy's SFTP host automatically, so from now on they
 * arrive whether or not anybody is watching for them. Until they are read, money reaches the bank
 * and nothing here knows which dispensing it belongs to.
 *
 * ── What a matched line does, and why it is not new revenue ──
 *
 * These settle claims that adjudicated on BIN 028249. The claim already carries what the voucher
 * promised at adjudication, in its own remit — so the payment arriving is that promise being kept,
 * not a second payment. Recorded with `revenueCents` 0, which is the same treatment the RxRescue
 * credit memo gets and for the same reason: adding the whole amount would count one dispensing's
 * money twice, and it would look perfectly ordinary while doing it.
 *
 * A line whose payment differs from what the claim was promised is still recorded — the money did
 * arrive — and the difference is named, because that is the plan paying something other than what
 * it said it would and is the only thing on this path worth anybody's attention.
 *
 * ── Three ways a line can fail to find a claim, and only one is a problem ──
 *
 * The owner settled on 8 September 2026 that nothing before 1 September is being uploaded and the
 * site starts clean. So a voucher line for an August fill will never match a claim, however long
 * anybody waits. Calling that "unmatched" would put a permanent and growing number on a screen that
 * nobody can ever act on, which is how a real unmatched payment gets lost among them.
 *
 *   matched            the claim is on file and was paid; the payment settles it
 *   beforeTheStart     the fill predates 1 September 2026, so no claim exists or ever will
 *   reversed           the only claim for that fill was reversed. The voucher paid for a
 *                      dispensing that did not stand, which is a real event and not a settlement
 *   unmatched          a fill this site should have and does not. The one worth chasing
 *
 * ── The gate ──
 *
 * Nothing is stored from a statement whose rows do not add to the total it prints, and nothing is
 * stored from one that prints no total at all. The second is the harder call and it is deliberate:
 * a statement nobody can check is a statement whose figures are believed on the strength of having
 * parsed, and the whole reason this reader has three arithmetic gates is that a remittance which
 * reads plausibly and is wrong is worse than one that fails.
 */

export type CopayRemitImport = {
  payer: string;
  paidOn: string | null;
  reference: string | null;
  /** Net payments recorded. Reversed pairs are not among them. */
  payments: number;
  matched: number;
  beforeTheStart: number;
  unmatched: number;
  alreadyHeld: number;
  /** Prescriptions paid and taken back in the same statement. Recorded as nothing, counted here. */
  reversedPairs: number;
  amountCents: number;
  banked: boolean;
  /** Anything a person should read, in words. A gate refusal is the first of them. */
  problems: string[];
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function importCopayRemit(
  text: string,
  fileName: string,
  user: { name: string; id?: string },
  opts: { bank?: boolean; documentId?: string | null } = {},
): Promise<CopayRemitImport> {
  const r = parseCopayRemit(text);
  const empty: CopayRemitImport = {
    payer: r.payer,
    paidOn: r.paidOn,
    reference: r.reference,
    payments: 0,
    matched: 0,
    beforeTheStart: 0,
    unmatched: 0,
    alreadyHeld: 0,
    reversedPairs: r.net.filter((n) => n.reversed).length,
    amountCents: 0,
    banked: false,
    problems: [],
  };

  if (r.lines.length === 0) {
    return { ...empty, problems: ["No item row could be read from this statement, so there was nothing to record."] };
  }
  /*
   * The gate, worded so the mailbox's own check finds it. Both remittance paths say "does not
   * balance" for the same condition, so one routing rule reads either.
   */
  if (r.reconciles === false) {
    return {
      ...empty,
      problems: [
        `Held, nothing stored: the statement does not balance — its rows net to ${money(r.netCents)} and it says it paid ${money(r.totals.paidCents ?? r.totals.claimsCents ?? 0)}.`,
      ],
    };
  }
  if (r.reconciles === null) {
    return {
      ...empty,
      problems: [
        "Held, nothing stored: the statement prints no total, so its rows cannot be checked against anything. A figure believed only because it parsed is the thing this reader exists to refuse.",
      ],
    };
  }

  const toRecord = r.net.filter((n) => !n.reversed && n.paidCents !== 0);
  if (toRecord.length === 0) {
    return {
      ...empty,
      problems: [
        `Every prescription on this statement was paid and reversed in the same period, so there is nothing to record. ${r.lines.length} rows, ${empty.reversedPairs} pairs.`,
      ],
    };
  }

  /*
   * The claims these settle, read once by prescription number rather than one query per line.
   *
   * Restricted to the BIN the vouchers adjudicate on. A prescription number is not unique across
   * payers — the same fill carries a primary claim and this secondary one — and matching without
   * the BIN would settle the wrong one, which would show the primary as paid by a voucher and
   * leave the voucher's own claim looking unpaid for ever.
   */
  const rxNumbers = [...new Set(toRecord.map((n) => n.rxNumber))];
  const claims = rxNumbers.length
    ? await db
        .select({
          id: schema.claims.id,
          rxNumber: schema.claims.rxNumber,
          fillNumber: schema.claims.fillNumber,
          dateFilled: schema.claims.dateFilled,
          ndc11: schema.claims.ndc11,
          remitCents: schema.claims.remitCents,
          status: schema.claims.status,
        })
        .from(schema.claims)
        .where(and(inArray(schema.claims.rxNumber, rxNumbers), eq(schema.claims.bin, COPAY_BIN)))
    : [];
  /*
   * A paid claim and a reversed one are not the same kind of thing, and only one of them can be
   * settled.
   *
   * `status` was selected here and never used: the first match won, so a voucher payment could
   * settle a claim the pharmacy had reversed — recorded at revenue zero against a claim that
   * carries no revenue either, which makes the money disappear from every figure on the site while
   * looking like an ordinary settlement. A reversed fill that a voucher paid for anyway is a real
   * event and worth saying out loud; it is not a claim to settle.
   *
   * The same family as the backtest measuring MAC-priced claims against an AWP discount: the
   * comparison is only meaningful where the two sides are the same quantity.
   */
  const matchesOn = (c: (typeof claims)[number], n: CopayRemitNetLine) =>
    c.rxNumber === n.rxNumber && c.dateFilled === n.dateOfService && (n.fillNumber === null || c.fillNumber === n.fillNumber || c.fillNumber === null);
  const claimFor = (n: CopayRemitNetLine) => {
    const paid = claims.filter((c) => c.status === "paid");
    return (
      paid.find((c) => matchesOn(c, n)) ??
      paid.find((c) => c.rxNumber === n.rxNumber && c.dateFilled === n.dateOfService) ??
      null
    );
  };
  const reversedFor = (n: CopayRemitNetLine) =>
    claims.find((c) => c.status === "reversed" && c.rxNumber === n.rxNumber && c.dateFilled === n.dateOfService) ?? null;

  /*
   * What is already held, so a statement pushed twice is banked once.
   *
   * RedSail pushing to an SFTP host means the same file can arrive again — a retry, a re-sync, a
   * folder swept twice — and the check number with the prescription and the amount is what makes
   * two copies of one payment recognisable as one payment.
   */
  const held = r.reference
    ? await db
        .select({ rxNumber: schema.claimPayments.rxNumber, amountCents: schema.claimPayments.amountCents })
        .from(schema.claimPayments)
        .where(and(eq(schema.claimPayments.reference, r.reference), eq(schema.claimPayments.source, "copay_card")))
    : [];
  const heldKeys = new Set(held.map((h) => `${h.rxNumber}|${h.amountCents}`));

  const { recordClaimPayment } = await import("./claim-payments");
  const problems: string[] = [];
  let payments = 0;
  let matched = 0;
  let beforeTheStart = 0;
  let unmatched = 0;
  let alreadyHeld = 0;
  let amountCents = 0;

  for (const n of toRecord) {
    if (heldKeys.has(`${n.rxNumber}|${n.paidCents}`)) {
      alreadyHeld++;
      continue;
    }
    const claim = claimFor(n);
    const reversed = claim ? null : reversedFor(n);
    const early = !claim && !reversed && n.dateOfService < SITE_STARTS_ON;

    if (reversed) {
      problems.push(
        `Rx ${n.rxNumber} on ${n.dateOfService}: the voucher paid ${money(n.paidCents)} for a fill this pharmacy reversed. The payment is recorded as money received rather than as settling that claim, because a reversed claim has nothing to settle. Worth asking the plan about.`,
      );
    }

    if (claim && claim.remitCents !== null && claim.remitCents !== n.paidCents) {
      problems.push(
        `Rx ${n.rxNumber} on ${n.dateOfService}: the claim was promised ${money(claim.remitCents)} at adjudication and the voucher paid ${money(n.paidCents)}, a difference of ${money(Math.abs(n.paidCents - claim.remitCents))}. The payment is recorded; the difference is the plan paying something other than what it said.`,
      );
    }
    if (!claim && !reversed && !early) {
      problems.push(
        `Rx ${n.rxNumber} on ${n.dateOfService}, ${money(n.paidCents)} for ${n.drug}: no claim on BIN ${COPAY_BIN} matches it. The payment is recorded and held against the prescription number so it is not lost.`,
      );
    }

    await recordClaimPayment(
      {
        rxNumber: n.rxNumber,
        fillNumber: n.fillNumber,
        dateFilled: n.dateOfService,
        ndc11: n.ndc11,
        source: "copay_card",
        payer: COPAY_PAYER,
        amountCents: n.paidCents,
        /*
         * A matched line settles what the claim already carries, so none of it is new revenue. A
         * line with no claim behind it has never been counted anywhere, so all of it is.
         */
        revenueCents: claim ? 0 : n.paidCents,
        receivedOn: r.paidOn,
        reference: r.reference,
        // The handle an undo is keyed on. Accepted here since this reader was written and, until now, dropped.
        documentId: opts.documentId ?? null,
        notes:
          `From ${fileName}${r.reference ? `, check/ACH ${r.reference}` : ""}. ${n.drug}, ${n.rows > 1 ? `${n.rows} rows netted` : "one row"}.` +
          (early ? " The fill predates 1 September 2026, when this site's records begin, so no claim for it exists." : ""),
      },
      user,
    );

    payments++;
    amountCents += n.paidCents;
    if (claim) matched++;
    else if (early) beforeTheStart++;
    // A payment against a reversed fill is not matched and is not unexplained: it is named above.
    else if (!reversed) unmatched++;
  }

  if (beforeTheStart > 0) {
    problems.push(
      `${beforeTheStart} payment${beforeTheStart === 1 ? "" : "s"} ${beforeTheStart === 1 ? "is" : "are"} for fills before 1 September 2026, when this site's records begin. ${beforeTheStart === 1 ? "It has" : "They have"} no claim to settle and never will; the money is recorded as received.`,
    );
  }

  /*
   * The deposit, where the caller asked for it. The statement's own payment amount rather than the
   * sum of what was recorded: they differ whenever a payment was already held, and what reached the
   * bank is what the payer says it sent.
   */
  let banked = false;
  if (opts.bank && r.paidOn && payments > 0) {
    const { addCashReceipt } = await import("./expenses");
    await addCashReceipt({
      month: r.paidOn.slice(0, 7),
      /*
       * Not "facilitator", which is the Medicare Transaction Facilitator and nothing else, and
       * there is no copay_card kind on the receipts table. A voucher administrator paying for a
       * dispensing is a third party paying for a dispensing; the payer names which one.
       */
      kind: "third_party",
      amountCents: r.paymentAmountCents ?? r.totals.paidCents ?? amountCents,
      payer: COPAY_PAYER,
      documentId: opts.documentId ?? null,
      notes: `From ${fileName}${r.reference ? `, check/ACH ${r.reference}` : ""}, ${payments} payment${payments === 1 ? "" : "s"}${empty.reversedPairs ? `, ${empty.reversedPairs} paid and reversed in the same period` : ""}.`,
      createdBy: user.id ?? user.name,
      // See expenses.ts: a statement read twice is one deposit, and a voucher payment the payer
      // payment report already banked is the same money arriving by a second road.
      sourceKey: `copay|${r.reference ?? fileName}|${r.paidOn}`,
      receivedOn: r.paidOn,
      reference: r.reference ?? null,
    });
    banked = true;
  }

  return {
    payer: r.payer,
    paidOn: r.paidOn,
    reference: r.reference,
    payments,
    matched,
    beforeTheStart,
    unmatched,
    alreadyHeld,
    reversedPairs: empty.reversedPairs,
    amountCents,
    banked,
    problems,
  };
}
