/**
 * RedSail's copay voucher remittance: money the pharmacy has already been paid, on a scan.
 *
 * The document is RedSail Technologies' "Remittance Advice — RAS Copay Voucher Reimbursement": a
 * payment date, a check or ACH number, an amount and the pharmacy's NPI at the top; a row per fill
 * carrying the prescription number, the date of service, the NDC, the drug, the quantity, what was
 * submitted, what the patient paid and what the voucher paid; and a footer of Total Claims, Total
 * Fee, Balance Forward and Total Amount Paid. Reversals are the same row negated, so the rows net
 * to the printed total — on the one statement read so far, $177.25 to the cent.
 *
 * The claims it settles adjudicate on BIN 028249 / PCN RXLOCAL, the one BIN the PSAO listing does
 * not name, so these are the copay-assistance secondaries. What arrives is what the voucher
 * already promised the claim, which is why a line settles a receivable rather than adding revenue.
 *
 * ── Why this file exists, and what it deliberately does not do ──
 *
 * BACKLOG item 24: "the recogniser side is B's", the reading and posting 2's. This answers one
 * question — *is this document a copay voucher remittance* — and nothing else. It stores nothing,
 * reads no rows and knows no money.
 *
 * It is asked of text pulled out of a PDF, which arrives fragmented and out of order, so only the
 * markers that survive that are worth testing: the programme's own name, which appears on no other
 * document this pharmacy receives, and one of the footer labels, which no covering email carries.
 * Both are required. The title alone is a phrase somebody could write in a message; the footer
 * labels alone are ordinary accounting words.
 *
 * A scan with no text layer answers **false** rather than guessing. That is the same rule the rest
 * of the recogniser follows: a document nothing can read is a document to ask a person about, not
 * one to file on a hunch. The statement that prompted this item is a scan whose second page
 * happens to carry a text layer; if a future one does not, this says so by saying nothing.
 */

/** The programme's own name, allowing for the fragmenting a PDF extractor does to a heading. */
const PROGRAMME = /r\.?\s*a\.?\s*s\.?[\s-]*copay[\s-]*voucher|copay[\s-]*voucher[\s-]*reimbursement/i;

/**
 * The footer labels, any one of which corroborates the heading.
 *
 * "Balance Forward" beside "Total Amount Paid" is a remittance's own arithmetic being shown, and
 * it is what makes this a statement of money rather than a letter about one.
 */
const FOOTER = /balance[\s-]*forward|total[\s-]*amount[\s-]*paid|total[\s-]*claims/i;

/** The issuer, which corroborates on its own where the heading came out shredded. */
const ISSUER = /red\s*sail|redsail/i;

/**
 * Whether this text is a copay voucher remittance.
 *
 * Deliberately narrow, and false for anything it cannot be sure of: the cost of a wrong yes is a
 * payment filed against the wrong programme, and the cost of a wrong no is a line on the inbox
 * asking the owner what the document is — which is the question that page exists to ask.
 */
export function looksLikeCopayRemittance(text: string, fileName = ""): boolean {
  const t = (text ?? "").slice(0, 20000);
  // Nothing to read is not a reason to conclude anything. A scan answers false.
  if (t.replace(/\s+/g, "").length < 40) return false;
  const named = PROGRAMME.test(t);
  const issuer = ISSUER.test(t);
  const footer = FOOTER.test(t);
  /*
   * The name of the file is never enough on its own and is not consulted for the decision. It is
   * accepted here only as a parameter so this reads like every other detector in the site; a
   * document called "copay voucher remittance.pdf" whose words say otherwise is not one.
   */
  void fileName;
  return (named && footer) || (named && issuer);
}

/** What the inbox says it saw, in the words a person would use. */
export function whyCopayRemittance(): string {
  return "A copay voucher remittance: RedSail's RAS reimbursement statement, which settles what the voucher already promised the claim.";
}
