/**
 * The register's day, read from PioneerRx's point of sale: what went to the bank from the drawers, and what the card
 * terminal took.
 *
 * ── Why ──
 *
 * Cash and cheque copays never reached the cash account (claim-lifecycle.md, G-LC-3): card batches are emailed and
 * banked, but the drawers' cash and cheques arrive only as bare "Deposit" lines on a bank statement a month later, which
 * nothing could place. PioneerRx's drawer summaries hold both, per drawer, per posting day. P-6, measured 15 September
 * 2026 against the site's own card batches: the register's card takings equal the batch received that day to the cent on
 * all 8 days a batch was on file — and name three days whose batch was never forwarded ($12,029.63).
 *
 * ── What is money ──
 *
 *   cash deposit + cheque deposit   the drawers' takings for the bank, after change and paid-outs. Banked as one
 *                                   patient receipt per posting day, which is how the bank deposit is made up.
 *   card                            already banked from the emailed batch. Only checked here, never banked: the batch is
 *                                   the settlement record and banking both would count the card money twice.
 *   Signature Only                  a pickup of a prescription already paid for. The owner, 15 September: "nothing is
 *                                   actually charged and they are normally for scripts that have already been paid
 *                                   for". Not money, never banked.
 *   charged to an account           owed, not taken. Not banked; it is cash when the account is paid, and an account
 *                                   payment in cash or by cheque is in that day's drawer deposit already.
 *
 * Like the card batch, the drawers carry the front of shop as well as copays; the receipt says so rather than pretending
 * to be copays alone. Pure: `register-store.ts` reads and books.
 */

export type RegisterDay = {
  day: string;
  cashDepositCents: number;
  checkDepositCents: number;
  cardCents: number;
  signatureOnlyCents: number;
  chargedToAccountsCents: number;
  accountPaymentsCents: number;
};

export const REGISTER_PAYER = "Register cash and cheques";

/** The receipt a register day banks, or null where the drawers took no cash or cheques for the bank. */
export function registerReceipt(d: RegisterDay): { sourceKey: string; reference: string; amountCents: number; notes: string } | null {
  const amountCents = d.cashDepositCents + d.checkDepositCents;
  if (amountCents <= 0) return null;
  const parts = [
    d.cashDepositCents ? `cash ${money(d.cashDepositCents)}` : null,
    d.checkDepositCents ? `cheques ${money(d.checkDepositCents)}` : null,
  ].filter(Boolean);
  return {
    sourceKey: `register|${d.day}`,
    // Digits, so two days that happen to deposit the same amount are two deposits (deposit-gate `numberedApart`).
    reference: d.day.replace(/-/g, ""),
    amountCents,
    notes:
      `The drawers' deposit for ${d.day} from PioneerRx: ${parts.join(" and ")}. Copays and front of shop together, as the ` +
      `drawer does not split them. Card takings are banked from the card batch, and Signature Only pickups took no money.`,
  };
}

/**
 * Each day's card takings against the batch received that day.
 *
 * `missing`: the register took cards and no batch is on file for the day — a batch not forwarded. `differs`: both exist
 * and disagree, which has not happened on any measured day and is named if it does. A day the register took no cards is
 * neither.
 */
export function checkCardBatches(days: RegisterDay[], batchCentsByDay: Map<string, number>): { missing: { day: string; cents: number }[]; differs: { day: string; registerCents: number; batchCents: number }[]; agree: number } {
  const missing: { day: string; cents: number }[] = [];
  const differs: { day: string; registerCents: number; batchCents: number }[] = [];
  let agree = 0;
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    if (d.cardCents <= 0) continue;
    const batch = batchCentsByDay.get(d.day);
    if (batch === undefined) missing.push({ day: d.day, cents: d.cardCents });
    else if (batch !== d.cardCents) differs.push({ day: d.day, registerCents: d.cardCents, batchCents: batch });
    else agree++;
  }
  return { missing, differs, agree };
}

function money(c: number): string {
  return `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
