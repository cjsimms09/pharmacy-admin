/**
 * Postage bought by card, read out of the confirmation email's own words.
 *
 * The owner: "will get email on mail postage charges", and then "Read from body". Endicia sends a
 * Purchase Confirmation with nothing attached — the whole transaction is four fields in the text —
 * so the mail sweep, which files attachments, recorded it as "No attachment on this message" and
 * dropped it. Two purchases of $100.00 each arrived that way in September and neither reached the
 * books. Nothing was broken; there was simply no path for a bill that is not a document.
 *
 * The message is one line of labelled fields:
 *
 *   Date: 09-08-2026 17:24 Description: Purchase Order Number: 625063610
 *   Payment Method: Mastercard Amount: $100.00 Surcharge:
 *
 * Both figures are required and neither is inferred. A confirmation with no amount, or a date this
 * cannot read, returns nothing and is left for a person — a postage charge invented from a
 * half-read email is worse than one nobody entered, because only the second is visibly missing.
 *
 * ── What this is, in accounting terms ──
 *
 * Buying postage is topping up a prepaid balance, and strictly the expense falls when the postage
 * is used rather than when it is bought. Nothing here records postage used — the email says the
 * balance is available, not what went out on parcels — so the purchase is booked as the expense on
 * the day the card was charged, which is the ordinary treatment at this size and errs towards
 * recognising the cost sooner rather than later. The note on every one says so, so that an
 * accountant reading the account can see the choice rather than having to infer it.
 */

export type PostagePurchase = {
  vendor: string;
  /** The day the card was charged, ISO. */
  purchasedOn: string;
  amountCents: number;
  /** A card surcharge where the email prints one. Nought where it prints the label and no figure. */
  surchargeCents: number;
  orderNumber: string | null;
  paymentMethod: string | null;
  /** The whole thing in one sentence, for the bill's description. */
  says: string;
};

const money = (s: string): number => Math.round(Number(s.replace(/[$,\s]/g, "")) * 100);

/**
 * Senders whose confirmations this knows how to read.
 *
 * Kept as a list rather than a single test so a second postage account — a franking meter, a
 * carrier's own portal — is one line rather than a second copy of this file.
 */
const POSTAGE_SENDERS: { match: RegExp; vendor: string }[] = [
  { match: /(^|[@.])endicia\.com$/i, vendor: "Endicia" },
  { match: /(^|[@.])stamps\.com$/i, vendor: "Stamps.com" },
];

function vendorFor(from: string): string | null {
  const address = (from.match(/[^\s<>]+@[^\s<>]+/)?.[0] ?? from).trim().toLowerCase();
  const domain = address.split("@").pop() ?? "";
  return POSTAGE_SENDERS.find((s) => s.match.test(domain))?.vendor ?? null;
}

export function readPostageEmail(from: string, subject: string, body: string): PostagePurchase | null {
  const vendor = vendorFor(from);
  if (!vendor) return null;
  /* Their confirmations are the only message of theirs that carries a charge. A balance warning is not one. */
  if (!/purchase confirmation/i.test(subject)) return null;

  const text = body.replace(/\r/g, " ").replace(/\s+/g, " ");

  /*
   * The amount, and only from its own label.
   *
   * The message carries other money-shaped text — the available balance prints on the same line —
   * so a pattern that took the first figure it found would sometimes book the balance as the
   * charge. The label is what makes it the charge.
   */
  const amount = /\bAmount:\s*\$?([\d,]+\.\d{2})/i.exec(text);
  if (!amount) return null;
  const amountCents = money(amount[1]);
  if (amountCents <= 0) return null;

  const date = /\bDate:\s*(\d{2})-(\d{2})-(\d{4})/.exec(text);
  if (!date) return null;
  const [, mm, dd, yyyy] = date;
  const purchasedOn = `${yyyy}-${mm}-${dd}`;
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(purchasedOn)) return null;

  /* Printed as a label with nothing after it when there is none, which is a nought and not a gap. */
  const surcharge = /\bSurcharge:\s*\$?([\d,]+\.\d{2})/i.exec(text);
  const surchargeCents = surcharge ? money(surcharge[1]) : 0;

  const order = /\bOrder Number:\s*(\S+?)(?=\s+[A-Z][a-z]+(?: [A-Z][a-z]+)*:|\s*$)/i.exec(text);
  const method = /\bPayment Method:\s*(.+?)(?=\s+[A-Z][a-z]+(?: [A-Z][a-z]+)*:|\s*$)/i.exec(text);

  const total = amountCents + surchargeCents;
  return {
    vendor,
    purchasedOn,
    amountCents: total,
    surchargeCents,
    orderNumber: order?.[1]?.trim() || null,
    paymentMethod: method?.[1]?.trim() || null,
    says:
      `${vendor} postage bought ${purchasedOn}` +
      `${order?.[1] ? `, order ${order[1].trim()}` : ""}` +
      `${method?.[1] ? `, on ${method[1].trim()}` : ""}` +
      `${surchargeCents ? ` (${(amount[1] ? money(amount[1]) / 100 : 0).toFixed(2)} plus ${(surchargeCents / 100).toFixed(2)} surcharge)` : ""}`,
  };
}

/**
 * The identity of a postage purchase, so the same confirmation cannot be booked twice.
 *
 * Their order number where there is one — it is theirs, it is unique, and a message re-read or
 * arriving twice carries the same one. Where there is none, the vendor, the day and the amount
 * together: two identical postage purchases on one day would be indistinguishable, and booking the
 * second is the error this must not make. A real second purchase that same day for the same amount
 * is entered by hand, which the note on the first one tells whoever is looking.
 */
export function postageKey(p: PostagePurchase): string {
  return p.orderNumber ? `POSTAGE|${p.vendor}|${p.orderNumber}` : `POSTAGE|${p.vendor}|${p.purchasedOn}|${p.amountCents}`;
}
