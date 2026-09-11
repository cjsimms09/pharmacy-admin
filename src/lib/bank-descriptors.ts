/**
 * What each line on this pharmacy's bank statement actually is.
 *
 * The owner, sending August's statement as a reference before September's arrives: "we need to go
 * through each thing, make sure system knows where and how to match it, what it is, and make sure
 * its applying and tracking correctly."
 *
 * The generic matcher in `bank-statement.ts` looks for one open item with exactly the line's
 * amount and the counterparty's name in its description. That is the right rule and it answers
 * almost none of these lines, because the money does not arrive or leave one invoice at a time:
 *
 *   MCKESSON DRUG/AUTO ACH ACH07172717 — $121,429.15, which is twenty-seven invoices taken
 *                                        together. No invoice will ever equal it.
 *   HRTLAND PMT SYST TXNS/FEES         — on BOTH sides. Deposits are the card takings; the debits
 *                                        are the card fees, which every month's account has been
 *                                        reporting as missing.
 *   Purch STAMPS.COM                   — already on the books from Endicia's own emailed
 *                                        confirmation. Booking it again is the double count the
 *                                        owner has asked about more than any other thing.
 *
 * So this names the counterparties this pharmacy actually banks with, says what each line is,
 * where it belongs, what it should be matched against, and — the part that matters most — whether
 * the money is ALREADY counted somewhere else, so a statement can be read in without any figure
 * moving twice.
 *
 * ── On reading the statement at all ──
 *
 * August's arrived as a scan. Its text layer is optical-recognition guesswork: "HRTLAND" comes out
 * as "HRTI-AND" and "HRTTAN D", "FAMILY" as "TAMILY", "10689648" as "106896,48". Every pattern
 * below is therefore matched on squashed letters with the noise removed, and several deliberately
 * accept more than one spelling. That is enough to be useful and it is not enough to keep books on:
 * the bank's own CSV or QFX download has clean descriptors, and getting that instead is worth more
 * than any amount of cleverness here.
 *
 * Pure. Every pattern is tested against the real strings the scan produced.
 */

export type BankSide = "in" | "out";

export type BankLands =
  /** Money in that belongs on the cash account as revenue. */
  | "revenue"
  /** Money out for goods. */
  | "cost_of_goods"
  /** Money out for running the pharmacy. */
  | "operating"
  /** Loan principal, owner draws, tax — below the line, and not a cost. */
  | "balance_sheet"
  /** Money moving between the pharmacy's own accounts. Never a cost and never revenue. */
  | "transfer"
  | "unknown";

export type BankMeaning = {
  /** A short machine name for the kind of line. */
  kind: string;
  /** Who the money came from or went to, in the pharmacy's own words. */
  counterparty: string;
  lands: BankLands;
  /** For revenue, which receipt kind. For a cost, the expense category. Null where neither applies. */
  category: string | null;
  /**
   * What in the site this line should be tied to, and the key to tie it by.
   *
   * `reference` is the part of the description that identifies the counterparty's own record —
   * McKesson's ACH number, which is their check number with the CK taken off. Where a line carries
   * one, matching is exact and needs no guesswork about amounts at all.
   */
  matchTo: { feed: string; reference: string | null } | null;
  /**
   * Where this money is already counted, if it is.
   *
   * The cash account must not move when a statement is read in for money it already has. Postage is
   * booked from Endicia's emailed confirmation; McKesson's ACH is already the cash cost of goods,
   * taken from their own accounts-payable report. A statement reader that booked either again would
   * double the figure, which is the one failure the owner has asked about repeatedly.
   */
  alreadyCounted: string | null;
  /**
   * Where the same money MAY already be counted, depending on whether its own feed has arrived.
   *
   * Distinct from `alreadyCounted`, which is certain. The facilitator's deposits are already in
   * cash revenue wherever its remittance has been read, and are not where it has not — so this
   * is a caution to show beside the line, never a reason to refuse to book it. Treating it as
   * certain silently dropped real deposits.
   */
  mayAlreadyBeCounted: string | null;
  /** The sentence to put in front of a person. */
  says: string;
};

/** Letters and digits only, upper case: the only form two spellings of one name reliably share. */
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The counterparties this pharmacy actually banks with.
 *
 * Ordered, and the first match wins, because some lines name two things — a Heartland debit and a
 * Heartland deposit share every word, and only the direction separates them.
 */
type Rule = {
  kind: string;
  counterparty: string;
  /** Matched against the squashed description. Several alternatives where the scan is unreliable. */
  test: RegExp;
  /** Which direction this rule is about. Omitted where it applies to both. */
  side?: BankSide;
  lands: BankLands;
  category: string | null;
  feed: string | null;
  /** Pulls the counterparty's own reference out of the ORIGINAL description, where there is one. */
  reference?: (description: string) => string | null;
  alreadyCounted?: string | null;
  mayAlreadyBeCounted?: string | null;
  why: string;
};

const RULES: Rule[] = [
  /* ── Money out: the wholesalers ─────────────────────────────────── */
  {
    kind: "wholesaler_ach",
    counterparty: "Mckesson",
    test: /MCKESSON/,
    side: "out",
    lands: "cost_of_goods",
    category: null,
    feed: "McKesson accounts payable report",
    /*
     * Their ACH number, which is their own check number with the CK taken off.
     *
     * The bank prints ACH07172717; the accounts-payable report calls the same payment CKACH07172717.
     * That is an exact tie between one bank debit and the twenty-seven invoices inside it, and it
     * removes every guess about amounts.
     */
    reference: (d) => {
      /*
       * The scan's letters are undone BEFORE the digits are counted, not after.
       *
       * "ACHO71886O5" is how it renders ACH07188605. Matching first and correcting afterwards read
       * the leading O as no digit at all and then put a zero back in front of it, giving
       * CKACH007188605 — a reference that matches nothing, from a line that was perfectly readable.
       */
      const squashed = d.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const m = /ACH([0-9OQIL]{8})/.exec(squashed);
      if (!m) return null;
      return `CKACH${m[1].replace(/[OQ]/g, "0").replace(/[IL]/g, "1")}`;
    },
    /*
     * Not `alreadyCounted`, because it is only true once their accounts-payable report has
     * arrived. Where it has, the ACH match says so and books nothing; where it has not, their
     * invoices are counted from their own dates and this debit legitimately settles one.
     */
    mayAlreadyBeCounted: "the cash cost of goods, wherever their accounts-payable report has been read",
    why: "McKesson take a fortnight of invoices in one ACH. The reference names which.",
  },
  {
    kind: "wholesaler_payment",
    counterparty: "IPC",
    /* "Independent Phar/WAREHOUSE", which the scan also renders WAREHOU S[ and WAREH0U SE. */
    test: /INDEPENDENTPHAR|INDEPENDENTPHARMACY/,
    side: "out",
    lands: "cost_of_goods",
    category: null,
    feed: "the IPC invoices on file",
    why: "IPC take each invoice separately, so a debit should match one invoice by amount.",
  },
  { kind: "wholesaler_payment", counterparty: "Parmed", test: /PARMED/, side: "out", lands: "cost_of_goods", category: null, feed: "the ParMed invoices on file", why: "A ParMed payment." },
  {
    kind: "wholesaler_payment",
    counterparty: "Anda",
    test: /ANDAINC/,
    side: "out",
    lands: "cost_of_goods",
    category: null,
    feed: null,
    why: "Anda is a wholesaler this pharmacy pays and has no invoices from on file at all.",
  },
  {
    kind: "wholesaler_payment",
    counterparty: "IN Pharma Solutions",
    test: /INPHARMASOLUTIO/,
    side: "out",
    lands: "cost_of_goods",
    category: null,
    feed: null,
    why: "A supplier this pharmacy buys from with nothing on file.",
  },

  /* ── Money out: running the pharmacy ────────────────────────────── */
  {
    kind: "card_fees",
    counterparty: "Heartland",
    /* HRTLAND, HRTI-AND, HRTTAN D, HRTIAND — the scan is worst on this one. */
    test: /HRT[A-Z]?[LIT]?AND|HEARTLAND/,
    side: "out",
    lands: "operating",
    category: "Card processing and bank fees",
    feed: null,
    why: "The card processor taking its fees. Every month's account has reported this line missing, and this is it.",
  },
  {
    kind: "postage",
    counterparty: "Stamps.com",
    test: /STAMPSCOM|ENDICIA/,
    side: "out",
    lands: "operating",
    category: "Postage and shipping",
    feed: "the Endicia purchase confirmations",
    alreadyCounted: "Postage and shipping, booked from Endicia's own emailed confirmation",
    why: "Postage bought by card. The confirmation email already books it, so the bank line is the same money.",
  },
  { kind: "software", counterparty: "PioneerRx", test: /PIONEERRX/, side: "out", lands: "operating", category: "Software and systems", feed: "the PioneerRx invoices", why: "The pharmacy system's own charge." },
  {
    /*
     * Not the PSAO fee, which is a separate standing cost of its own.
     *
     * The owner: "cpesn is a pharmacy network we are a part of". Two different things leave the
     * bank for two different arrangements, and calling this one the PSAO fee would have hidden the
     * PSAO fee entirely — its $619.25 would have looked like it had been paid when it had not.
     */
    kind: "network_fee",
    counterparty: "CPESN",
    test: /CPESN/,
    side: "out",
    lands: "operating",
    category: "Professional fees",
    feed: null,
    why: "Membership of the CPESN pharmacy network. A separate arrangement from the PSAO, and a separate cost.",
  },
  { kind: "security", counterparty: "Alert 360", test: /ALERT360/, side: "out", lands: "operating", category: "Software and systems", feed: "the Alert 360 standing cost", why: "The alarm monitoring contract." },
  { kind: "software", counterparty: "Square", test: /SQUAREUP/, side: "out", lands: "operating", category: "Software and systems", feed: null, why: "A Square charge." },
  { kind: "software", counterparty: "Jotform", test: /JOTFORM/, side: "out", lands: "operating", category: "Software and systems", feed: null, why: "A Jotform subscription." },

  /* ── Money out: not a cost at all ───────────────────────────────── */
  {
    kind: "loan_payment",
    counterparty: "the loan",
    test: /\bLN[0-9]|LOANPMT|LNPMT/,
    side: "out",
    lands: "balance_sheet",
    category: "Loan principal",
    feed: null,
    why: "A loan payment. Principal is not a cost and profit is stated before it; only the interest is.",
  },
  {
    kind: "internal_transfer",
    counterparty: "another account of the pharmacy",
    /*
     * "Ref AMEILHA To X6728 PSA" — a transfer between the pharmacy's own accounts.
     *
     * Not every line of this shape is one. "Ref AMIDQSP To *6728 Medications" looks identical and is
     * a different thing entirely: drugs sold on to the practice at cost, which has a cost side
     * already in the books and a money side in none of them. So medications are excluded here and
     * matched on their own terms below; without the exclusion this rule would swallow them and call
     * $15,912.81 a month of real trade "neither a cost nor revenue".
     */
    test: /^REF[A-Z0-9]{6,8}TO(?!.*MEDICATION)/,
    side: "out",
    lands: "transfer",
    category: null,
    feed: null,
    alreadyCounted: "nothing — a transfer between the pharmacy's own accounts is neither a cost nor revenue",
    why: "Money moved to another account of the pharmacy. Whatever it pays for is a cost when THAT account pays it, not here.",
  },

  /* ── Money in ───────────────────────────────────────────────────── */
  {
    kind: "card_settlement",
    counterparty: "Heartland",
    test: /HRT[A-Z]?[LIT]?AND|HEARTLAND/,
    side: "in",
    lands: "revenue",
    category: "patient",
    feed: "the till",
    why: "The card processor settling the day's takings. Net of their fees, which arrive as their own debits.",
  },
  {
    kind: "facilitator",
    counterparty: "Medicare Transaction Facilitator",
    test: /MTFPM|TRANSACTIONFACILITATOR/,
    side: "in",
    lands: "revenue",
    category: "facilitator",
    feed: "the MTF remittances the site already reads",
    mayAlreadyBeCounted: "facilitator revenue, where an MTF remittance for the same money has been read",
    why: "The Medicare facilitator paying. The site already reads these remittances, so the deposit is the same money.",
  },
  {
    kind: "copay_card",
    counterparty: "RedSail copay vouchers",
    test: /REDSAILCLAIMSCOPAY|REDSAIL/,
    side: "in",
    lands: "revenue",
    category: "third_party",
    feed: "the copay-card remittances the site already reads",
    mayAlreadyBeCounted: "third-party revenue, where the voucher remittance for the same money has been read",
    why: "Copay-card money. The remittance is already read, so the deposit is the same money arriving.",
  },
  /*
   * The PSAO, which is where nearly all of this pharmacy's prescription money arrives.
   *
   * The owner: "acess help i believe is our remits from our psao, provider pay is our PSAO". So
   * ProviderPay is the organisation and Access Health is the money coming through it — two names
   * for one relationship, and between them the largest deposits on the statement by a wide margin.
   *
   * ── Why these cannot be matched by amount, ever ──
   *
   * A PSAO remittance is consolidated: one deposit settles hundreds of claims from many plans at
   * once, exactly as a McKesson ACH settles dozens of invoices. $40,084.14 will never equal a
   * claim, a day's claims, or any figure the site can derive — so no amount of matching logic will
   * place it. The remittance detail behind it is the only thing that can, and for a PSAO that
   * detail is the 835.
   *
   * That is the same 835 the owner cannot get forwarded and has to download one at a time. It is
   * worth saying plainly what it buys: it is not a nicety, it is the only route by which the
   * biggest number on the bank statement becomes attributable to the claims that earned it.
   */
  {
    kind: "psao_remittance",
    counterparty: "the PSAO (Access Health)",
    test: /ACCESSHEAL/,
    side: "in",
    lands: "revenue",
    category: "third_party",
    feed: "the PSAO's 835 remittances",
    why:
      "Remits from the PSAO — the largest deposits here. One covers many claims across many plans, so it will never equal any single figure the site holds; " +
      "the 835 behind it is what says which claims it paid.",
  },
  {
    kind: "psao_remittance",
    counterparty: "the PSAO (ProviderPay)",
    test: /PROVIDERPAY/,
    side: "in",
    lands: "revenue",
    category: "third_party",
    feed: "the PSAO's 835 remittances",
    why: "The PSAO paying. Consolidated across many claims, so only its 835 can break it down.",
  },
  {
    kind: "psao_recoupment",
    counterparty: "the PSAO (ProviderPay)",
    test: /PROVIDERPAY/,
    side: "out",
    lands: "revenue",
    category: "third_party",
    feed: "the PSAO's 835 remittances",
    why:
      "The PSAO taking money back — a reversal, a clawback or a fee withheld. It reduces revenue rather than adding a cost, " +
      "so it lands on the revenue side negative and never inflates what the pharmacy appears to spend.",
  },
  {
    /*
     * Drugs bought by the pharmacy and passed to the practice next door at cost.
     *
     * The owner: "the transfer is drugs we sell to the doctor office at cost". It matters more than
     * its size suggests, because at the moment only one half of it reaches the books. The drugs are
     * bought on a wholesaler invoice, so their cost is in the cash cost of goods like any other
     * purchase — but they are never dispensed on a claim and never rung through the till, so the
     * money coming back for them is counted nowhere at all.
     *
     * Sold at cost, the two halves should cancel exactly. Counting one and not the other makes the
     * pharmacy look as though it spent the money and got nothing, every month.
     */
    kind: "practice_medications",
    counterparty: "the doctor's office",
    test: /MEDICATION/,
    side: "out",
    lands: "cost_of_goods",
    category: null,
    feed: null,
    why:
      "Drugs sold to the practice at cost. Their purchase is already in cost of goods; what is missing is the money back for them, " +
      "which is counted nowhere. Sold at cost the two cancel, so counting one half alone understates the month by the whole amount.",
  },
  {
    kind: "transfer_in",
    counterparty: "a prescription transfer",
    test: /PRESCRIPTION.?TRAN|PRESCRIPTIONTRANSFER/,
    side: "in",
    lands: "revenue",
    category: "other",
    feed: null,
    why: "A prescription transfer payment.",
  },
  { kind: "other_receipt", counterparty: "Veridian", test: /VERIDI/, side: "in", lands: "revenue", category: "other", feed: null, why: "A Veridian payment." },
  { kind: "other_receipt", counterparty: "POC Network", test: /POCNETWORK/, side: "in", lands: "revenue", category: "other", feed: null, why: "A POC Network handling payment." },
  {
    kind: "counter_deposit",
    counterparty: "the counter",
    /* A bare "Deposit" with nothing else on it: cash and cheques banked from the till. */
    test: /^DEPOSIT$/,
    side: "in",
    lands: "revenue",
    category: "patient",
    feed: "the till",
    why: "Cash and cheques banked from the counter.",
  },
];

/**
 * What a bank line is.
 *
 * `amountCents` is positive for money in and negative for money out, as `bank-statement.ts` writes
 * them. The direction is part of the answer, not a detail: Heartland's name appears on the takings
 * and on the fees, and only the sign tells them apart.
 */
export function readBankDescriptor(description: string, amountCents: number): BankMeaning {
  const side: BankSide = amountCents >= 0 ? "in" : "out";
  const s = squash(description);

  for (const r of RULES) {
    if (r.side && r.side !== side) continue;
    if (!r.test.test(s)) continue;
    const reference = r.reference?.(description) ?? null;
    return {
      kind: r.kind,
      counterparty: r.counterparty,
      lands: r.lands,
      category: r.category,
      matchTo: r.feed ? { feed: r.feed, reference } : null,
      alreadyCounted: r.alreadyCounted ?? null,
      mayAlreadyBeCounted: r.mayAlreadyBeCounted ?? null,
      says:
        `${side === "in" ? "In from" : "Out to"} ${r.counterparty}. ${r.why}` +
        (reference ? ` Reference ${reference}.` : "") +
        (r.alreadyCounted ? ` Already counted in ${r.alreadyCounted}, so reading this in must not add it again.` : "") +
        (r.mayAlreadyBeCounted ? ` The same money may already be in ${r.mayAlreadyBeCounted} — check before banking it again.` : ""),
    };
  }

  return {
    kind: "unknown",
    counterparty: "somebody the site does not know",
    lands: "unknown",
    category: null,
    matchTo: null,
    alreadyCounted: null,
    mayAlreadyBeCounted: null,
    says:
      side === "in"
        ? "A deposit from nobody the site recognises. It needs a person to say who paid it before it can be banked."
        : "A payment the site cannot name. It needs a person to say what it was before it can be placed.",
  };
}

/**
 * Whether reading this line into the books would count money the books already have.
 *
 * The owner: "make sure we are not duplicating!!!!! cant stress this enough". Three of the
 * pharmacy's regular lines are money the site learns about twice — postage from Endicia's email,
 * McKesson's ACH from their accounts-payable report, the facilitator from its own remittance — and
 * every one of them would double a figure if a statement reader simply booked what it saw.
 */
export function wouldDoubleCount(description: string, amountCents: number): boolean {
  return readBankDescriptor(description, amountCents).alreadyCounted !== null;
}
