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
 *   card                            banked from the emailed batch where there is one, and checked against the register.
 *                                   Where no batch was ever forwarded, the register banks it instead and says so —
 *                                   `registerCardReceipt` below, and the batch replaces that receipt if it ever comes.
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

/*
 * Shares a head with "Card batch" — the deposit gate compares payers on their first eight letters, so a batch that
 * arrives later for a day this banked is refused by the gate as well as by the replacement below. Two doors, because
 * this is card money and counting it twice is the fault that matters.
 */
export const REGISTER_CARD_PAYER = "Card batch, from the register";

/**
 * The card takings a day banks when no batch report was ever forwarded for it.
 *
 * ── Why this is allowed to bank at all ──
 *
 * The batch email is the settlement record and this is not it. But on all 8 September days where both exist, the
 * register's card total equals the batch to the cent (P-6, 15 September 2026) — the terminal and the till are the same
 * event recorded twice. Four days have no batch and never will: the owner, 16 September 2026, on 9/1, 9/2, 9/12 and
 * 9/15 — "stop asking, not sending". Money taken at the counter and sitting in the bank was therefore absent from the
 * books for ever, and the site's only response was to ask again every morning for an email nobody was going to send.
 *
 * So the register stands in, says in the receipt that it is standing in, and steps aside if the batch ever arrives
 * (`card-batch-store.ts` replaces this receipt rather than adding beside it). What it must never do is make the batch
 * unnecessary: the batch carries the card mix and the processor's own number, and this carries neither.
 */
export function registerCardReceipt(d: RegisterDay): { sourceKey: string; reference: string; amountCents: number; notes: string } | null {
  if (d.cardCents <= 0) return null;
  return {
    sourceKey: `register-card|${d.day}`,
    /*
     * The day and the amount, because there is no batch number to use. Digits, and deliberately not the day alone:
     * the drawer deposit for the same day is referenced by its digits, and the gate refuses a reference it has
     * already banked before it ever looks at which feed asked.
     */
    reference: `${d.day.replace(/-/g, "")}-${d.cardCents}`,
    amountCents: d.cardCents,
    notes:
      `Card takings at the counter on ${d.day}, from PioneerRx's drawer summary. No batch report for that day has ever ` +
      `reached the inbox, so the register stands in for it: on every day both exist the two agree to the cent. Copays and ` +
      `front of shop together, as the drawer does not split them, and the card mix is not known without the batch.`,
  };
}

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
