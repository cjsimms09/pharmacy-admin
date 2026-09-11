import type { MonthlyPL, PLInputs, PLLine } from "./profit-and-loss";
import type { PeriodPL } from "./ledger";

/**
 * The three questions the owner asked of his books, answered by arithmetic rather than by eye.
 *
 * *"The money tab needs to have sound logic, needs to not forget about expenses or revenue it
 * knows, needs to not double count things. This is how I will track financials of pharmacy. It
 * should be able to operate on a cash and accrual basis."*
 *
 * Those are three testable claims, and this file is where each one is tested:
 *
 * - **Nothing counted twice.** Six figures in this pharmacy are reachable by two routes — the till
 *   report and the claims both know what the prescriptions took, the wholesaler's statement and
 *   the ladder both know the rebate, and so on. `monthlyPL` already picks one route for each and
 *   drops the other. `countedTwice` is that decision written down where it can be read: what the
 *   money is, the two places it lives, which one wins, and — when both routes carried a figure this
 *   month — how much the rule actually kept out of the account.
 * - **Nothing forgotten.** `feedsInTheBooks` lists every feed the site holds that carries money and
 *   says, per feed, which basis it reaches and what is not in the books because of it. A feed that
 *   reaches neither basis is not an oversight to be discovered by reading code; it is a line on the
 *   page.
 * - **Both bases, and the difference explained.** `basisDifference` decomposes the gap between the
 *   accrual bottom line and the cash one into four named parts that add to exactly the gap. If they
 *   do not add up the decomposition is wrong, and it says so rather than rounding.
 *
 * And underneath all three, `booksBalance`: every total is the sum of its own lines and every
 * subtotal follows from the one above it. A statement that does not add up is not a statement.
 *
 * Pure, so all of it can be checked against a fixture by hand.
 */

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sumLines = (lines: PLLine[]) => lines.reduce((n, l) => n + l.amountCents, 0);
/*
 * Negative nought is not a figure a person can read.
 *
 * Subtracting a figure from itself and negating the result gives `-0` in JavaScript, which formats
 * as "−$0.00" — a minus sign in front of nothing, on a books page, which reads as a rounding the
 * account is hiding. It also compares unequal to `0`, so a decomposition that is exactly right can
 * report that it does not add up. Settled here rather than in each caller.
 */
const flat = (c: number) => (c === 0 ? 0 : c);

/* ── Nothing counted twice ──────────────────────────────────────────────────────── */

export type CountedTwice = {
  /** The money, named the way the pharmacist would name it. */
  what: string;
  /** The two records that both know about it. */
  routes: [string, string];
  /** Which record the account believes, and what becomes of the other. */
  rule: string;
  /** True where both routes carried a figure this month, so the rule had to actually fire. */
  bothPresent: boolean;
  /** What the rule kept out of the account this month. Null where there was nothing to keep out. */
  keptOutCents: number | null;
  says: string;
};

/**
 * Every figure in this pharmacy that two records both know, and what the account did about it.
 *
 * The risk is not that somebody adds a number twice on purpose. It is that two feeds arrive
 * carrying the same money in different words — the till report's prescription line and the claims;
 * the wholesaler's rebate statement and the estimate from the ladder — and both are true, and
 * adding both is the natural thing for a program to do. So each pair is decided once, in
 * `monthlyPL`, and listed here so the decision is visible on the page instead of buried in a
 * branch. Where both routes carried a figure, the amount that was kept out is stated: that is the
 * money the books would have counted twice.
 */
/**
 * What makes two rows the same bill.
 *
 * The number where there is one, and the document's own fingerprint where there is not. The
 * supplier name is never part of it: the two systems spell the same wholesaler three ways and
 * keying on the name is how the last matching bug hid.
 *
 * Exported because the screen that removes a duplicate has to agree with the register that found
 * it, to the row. Two copies of this rule would drift, and the drift would show up as a page
 * offering to delete something the books do not think is there.
 */
export function duplicateKey(v: { invoiceNumber: string | null; fingerprint?: string | null }): string {
  return (v.invoiceNumber ?? "").trim().toUpperCase() || (v.fingerprint ?? "").trim().toLowerCase();
}

/**
 * The same bill on file twice.
 *
 * Every other rule in this module is about two *feeds* carrying one dollar. This one is about a
 * single feed carrying it twice, which is the version nothing was watching for — and the version
 * that actually happened: an IPC invoice appeared on file twice at \$1,530.89 while a credit from
 * the same wholesaler was being filed, and by the time anyone looked it was gone again. Something
 * removed it and nothing recorded what.
 *
 * A question about money that cannot be answered afterwards has to be answerable continuously, so
 * this runs on every draw of the account. A wholesaler issues one number once; two rows carrying
 * it are one purchase counted twice, and the second is not evidence of anything.
 *
 * Matched on the number, and failing that on the document itself. The two systems spell the same
 * wholesaler three ways — 'IPC', 'Independent Pharmacy Cooperative', 'Independent Pharmacy
 * Cooperative (IPC)' — and keying on the name is how the last matching bug hid, so the name is
 * never part of the key.
 *
 * This used to skip anything with no number, on the reasoning that a document nothing can match is
 * not a duplicate. That was wrong, and IPD is the proof: both of its invoices on file carry no
 * number this reader can find, and the two rows are the same PDF byte for byte — same SHA-256,
 * same eight item lines, $3,255.70 each. The check that exists to catch one bill counted twice
 * could not see the one instance of it in the file, and the cash account added both.
 *
 * So where there is no number, the document's own fingerprint is the number. Two rows pointing at
 * identical bytes are one invoice, whatever the reader could or could not read off the front.
 */
export function invoicesFiledTwice(invoices: { invoiceNumber: string | null; totalCents: number | null; invoiceDate: string | null; fingerprint?: string | null }[]): {
  number: string;
  copies: number;
  overCents: number;
}[] {
  const by = new Map<string, typeof invoices>();
  for (const v of invoices) {
    const n = (v.invoiceNumber ?? "").trim().toUpperCase();
    /*
     * The number where there is one, and the document's fingerprint where there is not. A row with
     * neither is genuinely unmatchable and is named on the invoice page instead.
     */
    const key = duplicateKey(v);
    if (!key) continue;
    by.set(key, [...(by.get(key) ?? []), v]);
  }
  const out: { number: string; copies: number; overCents: number }[] = [];
  for (const [key, rows] of by) {
    if (rows.length < 2) continue;
    /*
     * The first is the bill; every further copy is money the month is carrying twice. Named by its
     * number where it has one — a fingerprint means nothing to anybody, so a row matched that way
     * is described by what he can actually see on it.
     */
    const number = (rows[0].invoiceNumber ?? "").trim().toUpperCase() || `the same document, ${rows[0].invoiceDate ?? "undated"}, with no number on it`;
    out.push({ number, copies: rows.length, overCents: rows.slice(1).reduce((sum, r) => sum + (r.totalCents ?? 0), 0) });
  }
  return out.sort((a, b) => Math.abs(b.overCents) - Math.abs(a.overCents));
}

export function countedTwice(i: PLInputs, pl: MonthlyPL): CountedTwice[] {
  const out: CountedTwice[] = [];
  const line = (label: string) => pl.revenue.concat(pl.costOfGoods, pl.operating, pl.offsets).find((l) => l.label === label) ?? null;

  /*
   * Prescription revenue. The System Sales Summary carries the whole till including the front of
   * shop; the claims carry every fill exactly. Both know what the prescriptions took.
   */
  const twice = invoicesFiledTwice(i.invoicesInMonth ?? []);
  const twiceOver = twice.reduce((n, t) => n + t.overCents, 0);
  out.push({
    what: "A wholesaler's bill, filed twice",
    routes: ["The invoice as it arrived", "The same invoice on a second row"],
    rule: "A wholesaler issues one number once, and the same PDF is the same bill however it arrived. Two rows carrying either are one purchase counted twice, and the cash account adds both.",
    bothPresent: twice.length > 0,
    keptOutCents: null,
    says:
      twice.length === 0
        ? "No invoice is on file more than once."
        : `${twice.length} invoice${twice.length === 1 ? " is" : "s are"} on file more than once — ${twice.map((t) => `${t.number} (${t.copies} copies)`).join(", ")} — carrying ${dollars(twiceOver)} the month counts twice.`,
  });

  const tillRx = i.sales ? (i.sales.rxRemitCents ?? 0) + (i.sales.rxPatientCents ?? 0) : 0;
  const claimsRx = i.claimsRevenueCents ?? 0;
  out.push({
    what: "What the prescriptions took",
    routes: ["The System Sales Summary's prescription lines", "The claims: every plan's remittance plus what the patient paid"],
    rule: "The summary wins, because it is drawn by the calendar month and is the only report that also carries the front of shop. The claims stand in for the prescription side when no summary has been loaded, and are never added to it.",
    bothPresent: i.basis === "accrual" && tillRx > 0 && claimsRx > 0,
    keptOutCents: i.basis === "accrual" && tillRx > 0 && claimsRx > 0 ? claimsRx : null,
    says:
      i.basis === "cash"
        ? "Neither is on the cash account: a September sale is October's money, so cash revenue comes from what was banked."
        : tillRx > 0 && claimsRx > 0
          ? `The summary's ${dollars(tillRx)} is counted; the claims' ${dollars(claimsRx)} is not added to it.`
          : tillRx > 0
            ? "Only the summary has a figure, and it is counted."
            : claimsRx > 0
              ? "No summary is loaded, so the claims stand in and say so on the line."
              : "Neither has a figure for this month.",
  });

  /*
   * The wholesalers' money. It arrives as supplier invoices and is counted from those; a bill
   * filed on Spending under Drug purchases is the same money in a second place.
   */
  const wholesalerBills = i.expenses.filter((e) => e.kind === "cost_of_goods" && e.categoryName === "Drug purchases");
  const wholesalerBillCents = wholesalerBills.reduce((n, e) => n + e.amountCents, 0);
  out.push({
    what: "What was bought from the wholesalers",
    routes: ["The supplier invoices, on the invoices page", "A bill filed on Spending under Drug purchases"],
    rule: "The invoices win, always. A wholesaler bill filed on Spending is dropped from both bases and named, because it is either the same money twice or it belongs in another category.",
    bothPresent: wholesalerBills.length > 0,
    keptOutCents: wholesalerBills.length > 0 ? wholesalerBillCents : null,
    says:
      wholesalerBills.length > 0
        ? `${wholesalerBills.length} bill${wholesalerBills.length === 1 ? "" : "s"} worth ${dollars(wholesalerBillCents)} filed on Spending and left out.`
        : "Nothing filed on Spending under Drug purchases this month, so there is nothing to keep out.",
  });

  /*
   * The rebate. The ladder estimates what this month's buying earned; the wholesaler's own
   * statement says what it settled; and on the cash side a receipt says what arrived.
   */
  const stated = i.expenses.filter((e) => e.kind === "cost_of_goods" && e.categoryName === "Wholesaler rebates");
  const statedCents = stated.reduce((n, e) => n + e.amountCents, 0);
  const rebateReceipts = i.receipts.filter((r) => r.kind === "rebate").reduce((n, r) => n + r.amountCents, 0);
  const ladder = i.rebatesCents ?? 0;
  out.push({
    what: "The wholesaler rebate",
    routes: [
      "The ladder's estimate from this month's invoice lines",
      i.basis === "cash" ? "A receipt of kind Wholesaler rebate, and a bill on Spending saying the same thing" : "The wholesaler's own statement, entered on Spending",
    ],
    rule:
      i.basis === "cash"
        ? "The receipt wins: on a cash account the rebate counts when the money arrived. A bill on Spending saying the same thing is dropped, and the ladder's estimate never appears at all."
        : "The statement wins. Where one is entered the estimate goes to nought, because a discount taken twice makes every margin below it wrong.",
    bothPresent: i.basis === "cash" ? rebateReceipts !== 0 && stated.length > 0 : stated.length > 0 && ladder !== 0,
    keptOutCents: i.basis === "cash" ? (rebateReceipts !== 0 && stated.length > 0 ? statedCents : null) : stated.length > 0 && ladder !== 0 ? ladder : null,
    says:
      i.basis === "cash"
        ? rebateReceipts !== 0 && stated.length > 0
          ? `${dollars(rebateReceipts)} received is counted; the ${dollars(statedCents)} bill saying the same thing is dropped.`
          : rebateReceipts !== 0
            ? `${dollars(rebateReceipts)} received is counted.`
            : "No rebate reached the bank this month."
        : stated.length > 0
          ? `The statement's ${dollars(statedCents)} is counted; the ladder's ${dollars(ladder)} estimate is set aside.`
          : ladder !== 0
            ? `The ladder's ${dollars(ladder)} estimate stands in until the wholesaler's statement is entered.`
            : "No rebate earned or entered this month.",
  });

  /*
   * Payroll and rent. The standing cost accrues by the day so a month in progress carries its
   * share; the real bill, when it comes, is the fact.
   */
  const replaced = (i.standing ?? []).length;
  out.push({
    what: "Payroll and rent",
    routes: ["The standing cost, accrued by the day", "The real bill for the month, filed on Spending"],
    rule:
      "The bills win as far as they go, and the estimate covers the rest. A standing cost stands down by what has been billed rather than for the first bill that arrives: " +
      "$45,000 of payroll with one $12,000 run filed carries $12,000 of bill and $33,000 of estimate, never both in full and never only the part that happens to be in. " +
      "It disappears entirely once the bills reach the month's figure.",
    bothPresent: false,
    keptOutCents: null,
    says:
      replaced > 0
        ? `${replaced} standing cost${replaced === 1 ? "" : "s"} carried this month, each net of whatever its real bills already cover.`
        : "No standing costs apply to this month.",
  });

  /*
   * Facilitator money on the cash side. The bank statement is typed in as receipts; the payer
   * payment report the site reads carries the same deposits.
   */
  const typedFacilitator = i.receipts.filter((r) => r.kind === "facilitator").reduce((n, r) => n + r.amountCents, 0);
  out.push({
    what: "Facilitator and top-off money reaching the bank",
    routes: ["A receipt of kind Facilitator, typed from the bank statement", "The payer payment report the site reads, by its received date"],
    rule: "The typed receipt wins, because it came off the bank statement. The site's own payments stand in only where no facilitator receipt has been typed for the month, and say so.",
    bothPresent: i.basis === "cash" && typedFacilitator !== 0,
    keptOutCents: null,
    says:
      i.basis === "cash"
        ? typedFacilitator !== 0
          ? `${dollars(typedFacilitator)} typed from the statement is counted; the site's own payments are not added to it.`
          : "Nothing typed for this month, so the payments the site holds stand in."
        : "Not a cash-account question: on the accrual side this money belongs to the month of the fill, and is counted there.",
  });

  /*
   * The delivery round. One setting governs whether it is the pharmacy's cost or the clinic's,
   * and both the account and the note about the omission read it, so they cannot disagree.
   */
  const driver = line("Delivery round");
  out.push({
    what: "The delivery round",
    routes: ["The round accrued from the days entered, at his rate", "The driver's own invoice for the month"],
    rule:
      "The invoice where there is one, the days entered where there is not — never both, because an invoice is the same round the days describe. " +
      "An invoice is only raised on a finished month, so a month in progress carries the days: it used to carry nothing at all, and September showed $0.00 with $486.00 owed. " +
      "And where the setting says the clinic pays him, neither is the pharmacy's money and the account names it as excluded rather than dropping it in silence.",
    bothPresent: false,
    keptOutCents: null,
    says: driver
      ? `${dollars(driver.amountCents)} counted as an operating cost, from ${i.basis === "cash" ? "the invoices sent this month" : "the days entered, until his invoice for the month is raised"}.`
      : "Not counted: the setting says the round is billed to the clinic, and it is named on the month's account as excluded.",
  });

  /*
   * What actually left the bank for goods. Three records know it and only one may be believed.
   */
  out.push({
    what: "What was paid to the wholesalers",
    routes: ["The wholesaler's own ledger — what cleared, and under which ACH", "Their invoices by date, and their deliveries in PioneerRx"],
    rule:
      "A supplier whose own ledger arrives is counted ONLY from it: not their invoices by date, not their PioneerRx deliveries, either of which on top would be the same purchase twice. " +
      "Everyone else is counted from invoice dates exactly as before. Only what has actually CLEARED counts — an invoice still pending is money in the bank, however certain its due date. " +
      "`countedTwiceInCash` proves it by counting rather than by reasoning, which is what catches the case nobody thought of.",
    /* Only a question on the cash side; on the accrual one the two records are not alternatives at all. */
    bothPresent: i.basis === "cash" && Boolean(i.cashCogsSays && /actually taken by/.test(i.cashCogsSays)),
    keptOutCents: null,
    says: i.basis === "cash" ? (i.cashCogsSays ?? "Nothing left the bank for goods that the site can see.") : "Not a cash-account question: the accrual side counts what the month's dispensings cost to buy, whenever they were paid for.",
  });

  /*
   * The PSAO's money, which the payment report itemises and the bank statement shows as a lump.
   */
  out.push({
    what: "The PSAO's payments",
    routes: ["The ProviderPay payment report, itemised by payer and payment number", "The deposit on the bank statement"],
    rule:
      "The report wins: it names which payer sent what, and the deposit is that same money swept across. August's file matches every deposit to exactly one payment — " +
      "$40,084.14 to Health Mart Atlas EFT-31312459 — so whichever is banked, the other must not be. Each payment is keyed on the payer and their own payment number, so the same report read twice banks nothing twice.",
    bothPresent: false,
    keptOutCents: null,
    says: "Banked from the report, by payer. The deposits on the statement are recognised as the same money and add nothing.",
  });

  /*
   * Postage, which arrives as a confirmation email and again as a card purchase on the statement.
   */
  out.push({
    what: "Postage bought by card",
    routes: ["Endicia's purchase confirmation, read from the email itself", "The STAMPS.COM purchase on the bank statement"],
    rule:
      "The confirmation wins, because it arrives first and carries the order number the booking is keyed on. The bank line is recognised as the same money and books nothing. " +
      "The confirmation has no attachment — the whole charge is four fields of text — which is why the sweep used to drop it and $200.00 reached neither account.",
    bothPresent: false,
    keptOutCents: null,
    says: "Booked once, from the email, keyed on Endicia's own order number.",
  });

  /*
   * The fills themselves: the nightly report, and PioneerRx, which holds the same fills.
   */
  out.push({
    what: "The month's fills",
    routes: ["The nightly Rx transaction report", "PioneerRx's own record of the same fills"],
    rule:
      "The report is the source and PioneerRx fills its gaps. Only fills whose Rx and refill number appear in PioneerRx and NOT in the claims are written, so a fill the report delivers tomorrow is never added again — it is already here. Backfilled rows are stamped `pioneer_sql` so what came from where is visible on any row.",
    bothPresent: false,
    keptOutCents: null,
    says: "One row per fill, keyed on the prescription and its refill, whichever feed brought it.",
  });

  return out;
}

/**
 * The register for a whole period: the same pairs, with each month's answer folded together.
 *
 * A quarter's register must not be three registers. The pair is the same pair every month — the
 * till report against the claims, the statement against the ladder — and what the reader wants is
 * the period's answer: did the rule have to fire, and how much did it keep out across the months.
 * The month-by-month wording gives way to a count, because "the ladder's estimate is set aside"
 * three times over is one fact, not three.
 */
export function countedTwiceOver(months: { inputs: PLInputs; pl: MonthlyPL }[]): CountedTwice[] {
  if (months.length === 0) return [];
  const each = months.map((m) => countedTwice(m.inputs, m.pl));
  if (months.length === 1) return each[0];
  return each[0].map((first, k) => {
    const all = each.map((r) => r[k]);
    const fired = all.filter((r) => r.bothPresent);
    const kept = all.reduce((n, r) => n + (r.keptOutCents ?? 0), 0);
    return {
      ...first,
      bothPresent: fired.length > 0,
      keptOutCents: all.some((r) => r.keptOutCents !== null) ? kept : null,
      says:
        fired.length > 0
          ? `Both records carried a figure in ${fired.length} of the ${all.length} months, and ${dollars(Math.abs(kept))} was kept out of the account.`
          : `Only one record carried a figure in any of the ${all.length} months, so nothing had to be kept out.`,
    };
  });
}

/* ── Nothing forgotten ──────────────────────────────────────────────────────────── */

export type FeedReach = "accrual" | "cash" | "both" | "none";

export type Feed = {
  /** The feed, named as the pharmacist meets it. */
  name: string;
  /** The money it carries. */
  carries: string;
  reaches: FeedReach;
  /** How it gets into the account, or why it does not. */
  how: string;
  /**
   * What is not in the books because of this feed, in one sentence. Null where nothing is.
   *
   * The point of the whole list. A feed that reaches neither basis is not a bug and often not even
   * wrong — the bank statement is not revenue, it is the check on revenue — but the difference
   * between "deliberately outside the account" and "nobody has wired it up" is invisible unless it
   * is written down, and only one of the two is a problem.
   */
  gap: string | null;
  href: string;
};

/**
 * Every feed the site holds that carries money, and where each one lands in the books.
 *
 * The owner's second requirement — *"needs to not forget about expenses or revenue it knows"* —
 * cannot be met by looking at the account, because the thing being looked for is not on it. It can
 * only be met by listing the feeds and saying, for each, what the books do with it. Three of them
 * do not reach the account at all today, and each is named with what that costs.
 */
export function feedsInTheBooks(): Feed[] {
  return [
    {
      name: "The claims export",
      carries: "Every fill: what each plan remitted, what the patient paid, and what the bottle cost to buy.",
      reaches: "accrual",
      how: "Revenue where no System Sales Summary has been loaded, and the acquisition cost of what was dispensed on every month — which is what makes a stocktake unnecessary.",
      gap: null,
      href: "/claims",
    },
    {
      name: "The System Sales Summary",
      carries: "The whole till by month: prescriptions and the front of shop, before sales tax.",
      reaches: "accrual",
      how: "The authority for accrual revenue. Where it is loaded the claims are not added to it.",
      gap:
        "It carries retail revenue and nothing in the site carries what that retail stock cost to buy, so front-of-shop margin falls straight to profit. " +
        "The month's account names this as a caveat with the amount against it.",
      href: "/money/monthly",
    },
    {
      name: "Supplier invoices",
      carries: "What the wholesalers billed, line by line, and when each invoice was paid.",
      reaches: "both",
      /*
       * What the cash account actually does, which stopped being what this said.
       *
       * It described a cascade — a recorded payment date, else the invoice date plus the supplier's
       * terms — that the account no longer runs. The owner: "Let's simplify it.. let's just use
       * invoices in September." Not one of September's invoices carried a payment date and not one
       * supplier had terms on file, so all three branches arrived at the same figure while leaving a
       * standing instruction to key in 71 payment dates. The cascade went; this sentence did not.
       *
       * A page that describes a method the code does not use is worse than one that says nothing:
       * somebody auditing the books would have checked payment dates that play no part in them.
       */
      how: "Accrual: the purchases figure, for the stock comparison only — never as cost of goods. Cash: the cost of goods, at each invoice's own date.",
      gap: "The invoice's date, not the day the money left the bank — which is what the pharmacy means by a September bill, and is not the same thing. Where no invoice arrived at all, PioneerRx's own record of receiving the delivery stands in, and the account says how much of the figure is on that footing.",
      href: "/inventory/invoices",
    },
    {
      name: "Bills on Spending",
      carries: "Rent, wages, insurance, card fees — every invoice that is not a wholesaler's.",
      reaches: "both",
      how: "Accrual by the date incurred, cash by the date paid. Sorted onto the account by the category's kind: revenue offset, cost of goods, operating, or below the line.",
      gap: null,
      href: "/expenses",
    },
    {
      name: "Standing costs",
      carries: "Payroll and rent as a monthly amount, so a month in progress carries its share.",
      reaches: "both",
      how: "Accrued by the day on the accrual account; counted on the day it is paid on the cash one. Dropped where the real bill for the month is already filed.",
      gap: "A standing cost with no day of the month it is paid cannot be placed on the cash account. It is left out and named, never guessed at.",
      href: "/expenses",
    },
    {
      name: "The rebate ladder",
      carries: "What this month's buying earned under each supplier's programme.",
      reaches: "both",
      how: "Accrual: the ladder's estimate against the month that earned it, until the wholesaler's statement replaces it. Cash: only a receipt, on the month the money arrived.",
      gap: "A reduction in cost of goods, never revenue. Booked as income it would overstate both sales and cost and leave every margin wrong.",
      href: "/suppliers",
    },
    {
      name: "Cash receipts",
      carries: "What reached the bank, typed by month and kind until the statement itself is read.",
      reaches: "cash",
      how: "The whole of cash revenue. Without it a cash account has no revenue at all, and the month says so rather than printing nought.",
      gap:
        "The whole of it is typed. The patient's money is cash on the day it was collected and the site already knows that day — a fill carries the date it was picked up — " +
        "so the copays could be placed on the cash account by themselves and are not. Today a month with nothing typed has no cash revenue even though every register " +
        "transaction in it is on file.",
      href: "/money",
    },
    {
      name: "Payer payments and facilitator remittances",
      carries: "Deposits from the payment reports the site reads, by payer and deposit date.",
      reaches: "cash",
      how: "The facilitator's stand in for a typed receipt where none exists for the month.",
      gap:
        "Only the facilitator's do. A plan remittance in this feed reaches the cash account solely if somebody also types it as a receipt, so cash revenue can be short by " +
        "whatever the payment reports hold and nobody re-entered. This closes when the 835s arrive here.",
      href: "/money",
    },
    {
      name: "Bank lines",
      carries: "The bank statement itself: every deposit and every payment out, with its description.",
      reaches: "none",
      how: "Read and shown beside the books, and used to place a deposit against a receipt or a bill against an invoice. No figure on either account comes from it.",
      gap:
        "The bank is the truth on the cash side and the books do not yet draw from it. Until they do, cash revenue is what somebody typed rather than what landed, " +
        "and a deposit nothing explains — or an 835 with no deposit — is not raised as a finding.",
      href: "/money",
    },
    {
      name: "Remittance advice (835)",
      carries: "What each payer decided to pay, claim by claim, with its adjustments and the trace number of the payment.",
      reaches: "none",
      how: "Not yet received here. The reader exists and the enrolment requests are being built.",
      gap:
        "This is the missing half of the cash account. Until an 835 exists for a claim the payer's money is a receivable, and the books can show the period's receivable " +
        "but not its age by payer. Provider-level adjustments — DIR, recoupments, fees — belong to no single claim and must still reach the books.",
      href: "/payers/routing",
    },
    {
      name: "On-hand counts",
      carries: "The value of the dispensing shelf on the day it was counted.",
      reaches: "none",
      how: "The independent check on cost of goods — opening stock plus purchases less closing stock uses nothing from the claims — and never a figure on the account itself.",
      gap: "Deliberate. The account's cost of goods comes from the claims, and this is what proves it; a check that fed the thing it checks would prove nothing.",
      href: "/inventory",
    },
    {
      name: "The delivery round",
      carries: "What the driver is owed for the month.",
      reaches: "both",
      how: "An operating cost where the setting says the pharmacy pays him; otherwise raised on his behalf and named on the account as excluded.",
      gap: null,
      href: "/deliveries",
    },
    {
      name: "Supply orders",
      carries: "What was ordered from the supply vendors.",
      reaches: "none",
      how: "The order is an email and carries no price; the vendor's invoice does, and lands as an ordinary bill on Spending.",
      gap: "Deliberate. Booking the order would be inventing a figure. The month's account names the orders it has left out.",
      href: "/purchasing/supplies",
    },
  ];
}

/* ── The books add up ───────────────────────────────────────────────────────────── */

export type BalanceCheck = { says: string; expectedCents: number; actualCents: number; ok: boolean };

/**
 * Every total is the sum of its own lines, and every subtotal follows from the one above it.
 *
 * Cheap, and it catches the one class of fault nobody spots by reading: a line added to a list and
 * not to the total, or a total carried forward from a period whose lines were merged differently.
 * On a period this is a real check rather than a tautology — the period's totals are added from the
 * months, while the lines are merged by label, so the two only agree if both are right.
 */
export function booksBalance(pl: PeriodPL | MonthlyPL): { ok: boolean; checks: BalanceCheck[]; offByCents: number } {
  const revenue = sumLines(pl.revenue);
  const offsets = sumLines(pl.offsets);
  const cogs = sumLines(pl.costOfGoods);
  const operating = sumLines(pl.operating);
  const otherOut = sumLines(pl.otherCashOut ?? []);
  const checks: BalanceCheck[] = [
    { says: "Revenue is the sum of its lines", expectedCents: revenue, actualCents: pl.revenueCents, ok: revenue === pl.revenueCents },
    { says: "Net revenue is revenue less what was taken back out of it", expectedCents: pl.revenueCents - offsets, actualCents: pl.netRevenueCents, ok: pl.revenueCents - offsets === pl.netRevenueCents },
    { says: "Cost of goods is the sum of its lines", expectedCents: cogs, actualCents: pl.costOfGoodsCents, ok: cogs === pl.costOfGoodsCents },
    { says: "Gross profit is net revenue less cost of goods", expectedCents: pl.netRevenueCents - pl.costOfGoodsCents, actualCents: pl.grossProfitCents, ok: pl.netRevenueCents - pl.costOfGoodsCents === pl.grossProfitCents },
    { says: "Operating costs are the sum of their lines", expectedCents: operating, actualCents: pl.operatingCents, ok: operating === pl.operatingCents },
    { says: "The bottom line is gross profit less operating costs", expectedCents: pl.grossProfitCents - pl.operatingCents, actualCents: pl.netProfitCents, ok: pl.grossProfitCents - pl.operatingCents === pl.netProfitCents },
    { says: "Other cash out is the sum of its lines", expectedCents: otherOut, actualCents: pl.otherCashOutCents ?? 0, ok: otherOut === (pl.otherCashOutCents ?? 0) },
  ];
  if (pl.basis === "cash") {
    const expected = pl.netProfitCents - (pl.otherCashOutCents ?? 0);
    checks.push({ says: "The cash change is the bottom line less the money out that is not a cost", expectedCents: expected, actualCents: pl.cashChangeCents ?? 0, ok: pl.cashChangeCents === expected });
  } else {
    /*
     * A cash change has no accrual side. It must be null and not nought: nought is a figure, and a
     * figure here would be read as "the bank did not move", which the accrual account cannot know.
     */
    checks.push({ says: "An accrual account states no cash change, because it cannot know one", expectedCents: 0, actualCents: pl.cashChangeCents ?? 0, ok: pl.cashChangeCents === null });
  }
  const offByCents = checks.reduce((n, c) => n + (c.ok ? 0 : Math.abs(c.expectedCents - c.actualCents)), 0);
  return { ok: checks.every((c) => c.ok), checks, offByCents };
}

/* ── Both bases, and the difference explained ───────────────────────────────────── */

export type BasisPart = { what: string; cents: number; says: string };

export type BasisDifference = {
  /** Accrual bottom line less cash bottom line. Positive: the month earned more than it banked. */
  differenceCents: number;
  /** The four parts, largest first. They add to the difference exactly, or `adds` is false. */
  parts: BasisPart[];
  adds: boolean;
  says: string;
};

/**
 * Why the two accounts differ, in parts that add to exactly the difference.
 *
 * Both bases are true and they never agree, and a books page that shows two bottom lines and no
 * account of the gap between them invites the reader to decide one of them is wrong. The gap is
 * not a discrepancy: it is the receivable, the payable, and the bills incurred but not yet paid,
 * and each of those is a fact worth knowing on its own.
 *
 * The decomposition is an identity, not an estimate:
 *
 *   netProfit(accrual) − netProfit(cash)
 *     = (revenue − revenue) − (offsets − offsets) − (cost of goods − cost of goods) − (operating − operating)
 *
 * so if the parts do not add to the difference, the arithmetic above them is wrong and the page
 * must say so rather than print four numbers that nearly work.
 */
export function basisDifference(accrual: PeriodPL | MonthlyPL, cash: PeriodPL | MonthlyPL): BasisDifference {
  const differenceCents = flat(accrual.netProfitCents - cash.netProfitCents);
  const parts: BasisPart[] = [
    {
      what: "Revenue earned and not yet banked",
      cents: flat(accrual.revenueCents - cash.revenueCents),
      says: "The receivable. Prescriptions dispensed in the period whose plans pay two to four weeks later, plus anything on account.",
    },
    {
      what: "Money taken back out of revenue",
      cents: flat(-(sumLines(accrual.offsets) - sumLines(cash.offsets))),
      says: "DIR fees and concessions counted against the period that earned the revenue rather than the period the plan took them.",
    },
    {
      what: "Goods dispensed and not yet paid for",
      cents: flat(-(accrual.costOfGoodsCents - cash.costOfGoodsCents)),
      says: "The payable, and its opposite. Accrual costs what left the shelf; cash costs what left the bank, so a month of stocking up is worse on cash and a month of running the shelf down is better.",
    },
    {
      what: "Bills incurred and not yet paid",
      cents: flat(-(accrual.operatingCents - cash.operatingCents)),
      says: "Overheads counted on the day they were incurred rather than the day the money went.",
    },
  ];
  const total = flat(parts.reduce((n, p) => n + p.cents, 0));
  const adds = total === differenceCents;
  const ordered = [...parts].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
  return {
    differenceCents,
    parts: ordered,
    adds,
    says: !adds
      ? `The two accounts differ by ${dollars(differenceCents)} and the parts below come to ${dollars(total)}. They must be the same figure, so something above this line is wrong and no explanation of the gap should be trusted until it is found.`
      : differenceCents === 0
        ? "The two accounts agree on the bottom line this period, which is unusual and worth a look: it normally means one of them is short of a feed rather than that the money arrived the month it was earned."
        : differenceCents > 0
          ? `The period earned ${dollars(differenceCents)} more than it banked. ${ordered[0].what.toLowerCase()} is the largest part of it, at ${dollars(Math.abs(ordered[0].cents))}.`
          : `The period banked ${dollars(-differenceCents)} more than it earned. ${ordered[0].what.toLowerCase()} is the largest part of it, at ${dollars(Math.abs(ordered[0].cents))}.`,
  };
}
