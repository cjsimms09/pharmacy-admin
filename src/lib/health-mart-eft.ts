/**
 * The Health Mart Atlas "EFT completed" email, read as the deposits it announces.
 *
 * The owner, 15 September 2026: *"I just forwarded an eft completion from proverpay to the inbox.. we
 * will get these daily to see what payments were sent to us from provider pay.. be sure we can handle
 * these properly, are getting everything we need to reconcile payments once we have bank account
 * statement, and they are being routed properly every day"*.
 *
 * McKesson's Health Mart Atlas network pays the pharmacy's third-party money through ProviderPay, and
 * sends one of these the day each transfer completes. It has nothing attached — the whole notice is in
 * the text — so the mail sweep, which files attachments, recorded the first one as "No attachment on
 * this message" and dropped it. Every one after it would have gone the same way. The layout:
 *
 *     The electronic funds transfer for 9/14/2026 is complete.
 *
 *     The following payments were made:
 *
 *        PMT          NCPDP             Amount Store Name
 *        EFT-31460993 9999999       $20,091.28 West Wichita Family Pharmacy
 *
 *     Deposit includes payments from the following third parties:
 *       Payers:
 *          MEDIMPACT
 *          OptumRx
 *
 * ── What it is, and what it is not ──
 *
 * A deposit notice: one ACH transfer, its total, its day, and which plans' money is inside it. That is
 * exactly what a bank statement line has to be matched against, and it is **the same money** the
 * portal's payer payment report records — the report already banks Health Mart Atlas deposits one per
 * EFT, keyed `payer-payment|health mart atlas|EFT-…`. So this reader produces the same `PayerPayment`
 * rows and they are banked through the same gate under the same key: whichever of the notice and the
 * report arrives second is recognised as the deposit already held, in either order.
 *
 * It does **not** say how much each plan put in, or which claims it pays. Those are in the portal's
 * detail and in the 835s, and nothing here pretends otherwise: the payer names are kept as the notice's
 * own words, never as amounts.
 *
 * ── What it refuses ──
 *
 * A notice with no transfer date it can read, a row whose amount will not parse, and a row for a
 * different store's NCPDP. A deposit to another pharmacy is not this pharmacy's money, and a notice
 * read half-way is worse than one left for a person — only the second is visibly missing.
 *
 * Pure.
 */

import type { PayerPayment } from "./payer-payments";

export const HEALTH_MART_ATLAS = "Health Mart Atlas";

export type EftNotice = {
  /** The day the transfer completed, ISO. Banked as the deposit day — see `depositedOn` below. */
  transferOn: string;
  payments: PayerPayment[];
  /** The third parties the notice names as inside the deposit, in its own words. No amounts. */
  payers: string[];
  /** Rows that looked like payments and were refused, with the reason. */
  refused: string[];
  says: string;
};

/**
 * Whether this is the notice at all — directly from McKesson, or forwarded.
 *
 * The subject is the stable part. A forwarded copy carries "Fw:" or "Fwd:" in front and comes from the
 * person who forwarded it, so the sender cannot be required; the notice's own opening sentence is
 * required instead, so a reply that merely quotes the subject is not read as a deposit.
 */
export function looksLikeEftNotice(subject: string, text: string): boolean {
  return /health\s*mart\s*atlas\s+eft\s+completed/i.test(subject) && /electronic funds transfer for\s+\d{1,2}\/\d{1,2}\/\d{4}\s+is complete/i.test(text);
}

const MONEY = /^\$?([\d,]+\.\d{2})$/;

export function readEftNotice(subject: string, text: string, ownNcpdp: string | null): EftNotice | null {
  if (!looksLikeEftNotice(subject, text)) return null;

  const when = /electronic funds transfer for\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+is complete/i.exec(text);
  if (!when) return null;
  const transferOn = `${when[3]}-${when[1].padStart(2, "0")}-${when[2].padStart(2, "0")}`;
  if (Number.isNaN(Date.parse(`${transferOn}T00:00:00Z`))) return null;

  const lines = text.replace(/\r/g, "").split("\n");
  const payments: PayerPayment[] = [];
  const refused: string[] = [];

  /*
   * One row per payment: the EFT number, the NCPDP, the amount, then the store name.
   *
   * Read from the fixed pieces rather than by column position, because the notice pads with spaces
   * and a forward can re-flow them. The EFT number, a seven-digit NCPDP and a money figure are each
   * unambiguous on their own.
   */
  for (const raw of lines) {
    const line = raw.trim();
    const row = /^(EFT-\d+)\s+(\d{7})\s+(\S+)\s*(.*)$/i.exec(line);
    if (!row) continue;
    const [, eft, ncpdp, amountText, store] = row;
    const amount = MONEY.exec(amountText);
    if (!amount) {
      refused.push(`${eft}: the amount "${amountText}" could not be read`);
      continue;
    }
    if (ownNcpdp && ncpdp !== ownNcpdp) {
      refused.push(`${eft}: paid to NCPDP ${ncpdp}${store ? ` (${store.trim()})` : ""}, not this pharmacy's ${ownNcpdp}`);
      continue;
    }
    payments.push({
      paymentNumber: eft.toUpperCase(),
      payerName: HEALTH_MART_ATLAS,
      /*
       * The transfer day, banked as the deposit day.
       *
       * The notice says the transfer "is complete" on this date; the portal's report calls the same
       * field the deposit date. Not yet proved to be the same day on the same EFT — no notice and
       * report row for one EFT have been set side by side — so a bank line a business day later is
       * still this deposit, and bank matching must allow for it.
       */
      depositedOn: transferOn,
      paidOn: transferOn,
      amountCents: Math.round(Number(amount[1].replace(/,/g, "")) * 100),
      method: "EFT",
      remitMatched: null,
      claimMatchCents: null,
      noClaimMatchCents: null,
      adjustmentsCents: null,
    });
  }

  const payers: string[] = [];
  const start = lines.findIndex((l) => /^\s*payers:\s*$/i.test(l));
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      const name = l.trim();
      if (!name) {
        if (payers.length) break;
        continue;
      }
      if (/please visit|confidentiality notice/i.test(name)) break;
      payers.push(name);
    }
  }

  if (payments.length === 0 && refused.length === 0) return null;

  const total = payments.reduce((n, p) => n + p.amountCents, 0);
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    transferOn,
    payments,
    payers,
    refused,
    says:
      payments.length === 0
        ? `A Health Mart Atlas EFT notice for ${transferOn} was read, and none of its payments could be taken: ${refused.join("; ")}.`
        : `Health Mart Atlas transferred ${money(total)} on ${transferOn} in ${payments.length} payment${payments.length === 1 ? "" : "s"} (${payments.map((p) => p.paymentNumber).join(", ")})` +
          (payers.length ? `, from ${payers.join(", ")}` : "") +
          `.${refused.length ? ` Refused: ${refused.join("; ")}.` : ""}`,
  };
}
