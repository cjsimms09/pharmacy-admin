/**
 * The morning check: a fixed list of things that must be true, judged against what is.
 *
 * ── Why this exists ──
 *
 * On 17 September 2026 the owner said: *"you need to make sure we are getting data were supposed to,
 * fixing issues as they come up, auditing everything... You need to making sure everything is working
 * daily!"* He said it after a day in which four separate faults were found only because he asked —
 * an inbox counting one delivery twenty-eight times, a sixteen-month-old rebate statement describing
 * where the pharmacy stood, four invoices marked short that were not, and unread mail the sweep
 * could not see. Every one of them was silent. Every one had been silent for days.
 *
 * What they have in common is not a bug in common. It is that nothing in the site ever asked
 * whether its own results still made sense. Each feature checked its own work at the moment it did
 * it and never again, so a rule that started returning nonsense went on returning nonsense, and the
 * only detector in the building was a pharmacist noticing a number looked wrong.
 *
 * ── Why it is written this way ──
 *
 * Every check states what OUGHT to be true before it looks — and states it from how a pharmacy and
 * its books work, never from the data it is about to judge. That is the house rule (CLAUDE.md,
 * clause 1) and it is the whole difference between a check and a description: "the inbox has 1,822
 * rows" is a description, and it is what the site displayed happily for a day. "One delivered
 * attachment should leave one inbox row, because that is what the key means" is a check, and it
 * fails immediately.
 *
 * So `shouldBe` is a sentence written here, in code, once, by someone thinking about the pharmacy.
 * `observed` is measured. A check is a finding only where they differ, and then it says by how much.
 *
 * Judging is pure and the facts are gathered elsewhere, so every one of these can be tested by
 * handing it numbers — including the numbers of the day it was written, which is how each of these
 * six was proved to fire.
 */

export type Facts = {
  /** Inbox rows, and distinct delivered attachments behind them. */
  inboxRows: number;
  inboxArrivals: number;
  /** Document rows filed in the invoice drawers, and distinct files behind them. */
  invoiceDocumentRows: number;
  invoiceDocumentFiles: number;
  /** The period end of the rebate statement currently describing where the pharmacy stands. */
  standingRebatePeriodTo: string | null;
  /** Invoices whose lines do not reach the total printed on them. */
  invoicesShort: number;
  invoicesShortCents: number;
  /** When the mailbox was last swept, ISO. Null if it never has been. */
  lastSweptAt: string | null;
  /** Money booked off a statement that does not point at the statement it came from. */
  bookedWithNoDocument: number;
  /**
   * Revenue offsets carrying a payment date, which puts them on the cash account twice.
   *
   * A rebate, a DIR clawback, a recoupment: the cash side of each is its own receipt or a deposit
   * that already arrived net. A paid date on the expense as well means `expensesIn(month, "cash")`
   * returns it too, and the same money lands twice — as revenue and as a negative cost.
   */
  offsetsWithPaymentDates: number;
  offsetsWithPaymentDatesCents: number;
  /**
   * Suppliers with two current rebate ladders paying on the same basket off the same measurement.
   *
   * `rebateView` sums every current ladder with the same eligibility, so two of them double the rate
   * the estimate uses — and the estimate is a cost-of-goods line, so profit rises by the whole of the
   * difference. A rename is enough to create one, which is how it happened.
   */
  doubledRebateLadders: number;
  /**
   * Payments counted as new revenue that are the claim's own adjudicated figure arriving.
   *
   * A fill earns `remitCents` on the day it is dispensed. When the plan pays, that is the same
   * money turning up, not more of it — so a payment whose amount is exactly the claim's
   * `remitCents` and which still carries a non-zero `revenueCents` is that fill's revenue counted
   * twice. Written as a shape rather than as one importer's bug because three separate faults in
   * two days were this shape: a rebate expense dated as paid, two rebate ladders on one basket,
   * and a fortnight of remittances posted as though none of the claims had ever been billed.
   */
  paymentsCountedTwice: number;
  paymentsCountedTwiceCents: number;
  /**
   * Remittances the payer says it has paid, whose money no cash receipt carries.
   *
   * The other half of the same absence. Counting a remittance twice overstates the accrual side;
   * never banking its deposit understates the cash side, and on 18 September both were true at
   * once — $28,645.57 too much earned, $99,238.84 too little received. A remittance with no
   * payment number is not counted here: that is the payer saying the deposit has not happened.
   */
  remittancesNotBanked: number;
  remittancesNotBankedCents: number;
  /** Today, so the check does not have to ask the clock and can be tested. */
  today: string;
  /** Now, ISO, for the same reason. */
  now: string;
};

export type Check = {
  /** What is being checked, as a person would say it. */
  what: string;
  /** What ought to be true, and why — written here, never derived from the observation. */
  shouldBe: string;
  /** What is, with numbers. */
  observed: string;
  ok: boolean;
  /** Only when it fails: what it means and what closes it. */
  difference: string | null;
  /**
   * How bad. `money` is a figure that is wrong or at risk; `counting` is a number somebody would
   * act on being wrong; `feed` is data not arriving. Nothing here is cosmetic — a check that does
   * not matter should be deleted rather than ranked low.
   */
  kind: "money" | "counting" | "feed";
};

const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function runDailyCheck(f: Facts): Check[] {
  const checks: Check[] = [];

  /*
   * 1. One delivered attachment, one inbox row.
   *
   * Not an aesthetic preference: the row key IS `<message id>#<file name>`, so a second row for one
   * attachment means a dedupe stopped working. It is also the arrivals list the expected-documents
   * page counts, and a list that counts one delivery twenty-eight times cannot show what is late.
   */
  checks.push({
    what: "One inbox row per delivered attachment",
    shouldBe:
      "An inbox row is keyed on the message and the file name together, so one attachment can only ever be one row. More than one means a dedupe has stopped working, and the arrivals list stops being able to show what is late.",
    observed: `${f.inboxRows.toLocaleString()} rows for ${f.inboxArrivals.toLocaleString()} arrivals`,
    ok: f.inboxRows === f.inboxArrivals,
    difference:
      f.inboxRows === f.inboxArrivals
        ? null
        : `${(f.inboxRows - f.inboxArrivals).toLocaleString()} rows more than there were deliveries. The collapse runs at every restart; if this is standing, the sweep is writing them faster than it removes them.`,
    kind: "counting",
  });

  /*
   * 2. One document row per file in the invoice archive.
   *
   * This is the drawer a DEA inspection counts. Twenty copies of one Schedule II invoice is not a
   * breach of anything and is still the first question asked, and the pharmacist has to answer it.
   */
  checks.push({
    what: "One record per invoice in the archive",
    shouldBe:
      "An inspector counting Schedule II invoice records should get the number of Schedule II invoices. Duplicate records are not a breach, but they are the first thing asked about and the pharmacist has to explain them.",
    observed: `${f.invoiceDocumentRows.toLocaleString()} records for ${f.invoiceDocumentFiles.toLocaleString()} invoices`,
    ok: f.invoiceDocumentRows === f.invoiceDocumentFiles,
    difference:
      f.invoiceDocumentRows === f.invoiceDocumentFiles
        ? null
        : `${(f.invoiceDocumentRows - f.invoiceDocumentFiles).toLocaleString()} duplicate records. They can be removed on the invoices page — only copies nothing points at, whose bytes survive against an invoice.`,
    kind: "counting",
  });

  /*
   * 3. The rebate statement describing the present is from the present.
   *
   * A breakdown is monthly and paid in arrears, so the newest is perhaps six weeks old when the next
   * falls due. Sixty days therefore means one of two things, and both matter: a statement is late,
   * or something older is standing in its place — which is exactly what a 2025 sample did for twelve
   * days while the site showed its rate as current.
   */
  const standingAgeDays = f.standingRebatePeriodTo === null ? null : daysBetween(f.standingRebatePeriodTo, f.today);
  checks.push({
    what: "The rebate statement standing is a current one",
    shouldBe:
      "A rebate breakdown covers one month and is paid in arrears, so the newest one on file is at most about six weeks old. Anything older is either a statement that has not arrived or an older one standing in its place, and both change the rate every purchasing comparison uses.",
    observed:
      f.standingRebatePeriodTo === null
        ? "no statement is standing"
        : `covers up to ${f.standingRebatePeriodTo}, ${standingAgeDays} days ago`,
    ok: standingAgeDays !== null && standingAgeDays <= 60,
    difference:
      standingAgeDays !== null && standingAgeDays <= 60
        ? null
        : f.standingRebatePeriodTo === null
          ? "Nothing is setting the contract rate, so the purchasing comparison is working without one."
          : `${standingAgeDays} days old. The correction at boot puts the newest statement on file back in charge; if this is standing after a restart, the newest statement has not arrived.`,
    kind: "money",
  });

  /*
   * 4. Every invoice adds up to the total printed on its face.
   *
   * The arithmetic is the only thing proving the reading, so a shortfall is either money billed and
   * not booked or a line the reader cannot see — and the two need different answers. Named in money
   * because either way a purchase figure is wrong by it.
   */
  checks.push({
    what: "Invoices add up to what they say they come to",
    shouldBe:
      "An invoice reconciles when its item lines plus its printed charges equal its printed total. That arithmetic is the only thing proving the reading, so a shortfall is either money billed and never booked, or a line the reader cannot see.",
    observed: f.invoicesShort === 0 ? "every invoice on file reconciles" : `${f.invoicesShort} short by ${money(f.invoicesShortCents)} in total`,
    ok: f.invoicesShort === 0,
    difference:
      f.invoicesShort === 0
        ? null
        : `${money(f.invoicesShortCents)} across ${f.invoicesShort} invoice${f.invoicesShort === 1 ? "" : "s"} that the reader could not account for. They are re-read nightly as the reader improves; one that persists is a layout worth looking at.`,
    kind: "money",
  });

  /*
   * 5. The post is being collected.
   *
   * Every feed but PioneerRx arrives as mail, so a sweep that stops is the whole site going quiet
   * with nothing going wrong. Six hours because the tick is far more frequent than that and the
   * window has to survive a slow evening without crying wolf.
   */
  const hoursSinceSweep = f.lastSweptAt === null ? null : hoursBetween(f.lastSweptAt, f.now);
  checks.push({
    what: "The mailbox is being swept",
    shouldBe:
      "Every feed except PioneerRx arrives as email, so the sweep is the way almost all data reaches this site. It runs many times a day; more than six hours of silence means it is failing or being starved, and nothing else would say so.",
    observed: f.lastSweptAt === null ? "never swept" : `last swept ${Math.round(hoursSinceSweep!)} hours ago`,
    ok: hoursSinceSweep !== null && hoursSinceSweep <= 6,
    difference:
      hoursSinceSweep !== null && hoursSinceSweep <= 6
        ? null
        : "Nothing is arriving. Check the mail settings page for the last error, and that the site has not been left busy enough to starve the tick.",
    kind: "feed",
  });

  /*
   * 6. Money booked off a document can produce the document.
   *
   * An expense with no document behind it spends correctly and proves nothing, and nobody notices
   * until an accountant or an inspector asks. It is also what made the first rebate correction
   * report success while doing nothing: it looked the statement up through the expense, and the
   * expense had never been given one.
   */
  checks.push({
    what: "Money booked off a statement points at the statement",
    shouldBe:
      "An expense read off a document should carry that document, so the figure can be produced when an accountant or an inspector asks where it came from. A booked amount with nothing behind it is correct and unprovable.",
    observed: f.bookedWithNoDocument === 0 ? "every booked statement has its document" : `${f.bookedWithNoDocument} booked with no document`,
    ok: f.bookedWithNoDocument === 0,
    difference:
      f.bookedWithNoDocument === 0
        ? null
        : `${f.bookedWithNoDocument} figure${f.bookedWithNoDocument === 1 ? "" : "s"} on the books that cannot show where ${f.bookedWithNoDocument === 1 ? "it" : "they"} came from.`,
    kind: "money",
  });

  /*
   * 7. No revenue offset carries a payment date.
   *
   * The check that should have existed this morning. A rebate, a DIR clawback and a recoupment are
   * all money the pharmacy was told it had and did not; the cash account sees each by its own route —
   * the rebate's receipt, or a deposit that already arrived net. A payment date on the expense as
   * well puts it on the cash account a second time, as a negative cost beside the revenue, and
   * profit goes up by the whole amount with nothing on any screen to say why.
   *
   * It happened on 17 September 2026 and the owner found it, not this site: "are gross profit went
   * up massively today and IDK how or why." $10,697.24 on one month. Every other rule in this file
   * exists because something was found by hand once; this is the most expensive of them.
   */
  checks.push({
    what: "No revenue offset is dated as paid",
    shouldBe:
      "A rebate, a clawback or a recoupment is money the pharmacy was told it had earned and did not. The cash account sees it by its own route — the rebate's receipt, or a deposit that already arrived net — so the expense must carry no payment date. With one, the same money lands twice on the cash account and profit rises by the whole of it.",
    observed:
      f.offsetsWithPaymentDates === 0
        ? "none of them is dated as paid"
        : `${f.offsetsWithPaymentDates} dated as paid, ${money(f.offsetsWithPaymentDatesCents)} between them`,
    ok: f.offsetsWithPaymentDates === 0,
    difference:
      f.offsetsWithPaymentDates === 0
        ? null
        : `${money(f.offsetsWithPaymentDatesCents)} is being counted twice on the cash account — once as revenue and once as a negative cost — so gross profit is that much better than the pharmacy's. Cleared at every restart; standing here means something is writing the date back.`,
    kind: "money",
  });

  /*
   * 8. No supplier pays on the same basket twice.
   *
   * The rate that prices a rebate is summed across every current ladder with the same eligibility,
   * so a second ladder on the same basket does not compete with the first — it is ADDED to it. The
   * contract rate read 60% against a statement that says 30%, the brand factor 2% against 1%, and
   * September's estimated rebate came out at double. It is a cost-of-goods line, so the whole of the
   * difference landed in profit: about $5,000, from a programme having been renamed.
   *
   * Cheapest check on this list and the one that would have saved the most. It counts.
   */
  checks.push({
    what: "No supplier pays on the same basket twice",
    shouldBe:
      "A rebate rate is summed across every current ladder paying on the same basket, so a second ladder on the same basket is added to the first rather than replacing it. One programme should be current per basket per supplier; two means every rate the estimate uses is doubled, and the estimate is a cost of goods, so profit rises by the whole of the difference.",
    observed:
      f.doubledRebateLadders === 0
        ? "one current ladder per basket"
        : `${f.doubledRebateLadders} basket${f.doubledRebateLadders === 1 ? "" : "s"} with more than one current ladder`,
    ok: f.doubledRebateLadders === 0,
    difference:
      f.doubledRebateLadders === 0
        ? null
        : "Every rate on those baskets is being added twice, so the estimated rebate — and the profit above it — is overstated. The superseded ladders are ended at every restart; standing here means something is filing them under a new name again.",
    kind: "money",
  });

  /*
   * 9. Money earned and money arriving are never the same money twice.
   *
   * The one check on this list written for a shape rather than a bug. Three separate faults in two
   * days were all this: a rebate expense carrying a payment date, two rebate ladders on one basket,
   * and a fortnight of remittances posted as new revenue when the claims had already earned it —
   * $28,645.57 of September, found by the owner in minutes and not by anything here.
   *
   * Every one had correct arithmetic and passing tests. None could have failed one, because each
   * half was right on its own and the fault was the two halves meeting. So this does not test a
   * calculation; it tests the books for the footprint such a fault leaves — a payment that is
   * exactly the claim's own adjudicated figure and is still being added to it.
   *
   * It is cheap, it is general, and had it existed on Tuesday it would have caught all three.
   */
  checks.push({
    what: "Money earned and money arriving are counted once, not twice",
    shouldBe:
      "A fill earns what the plan agreed to pay on the day it is dispensed, and the remittance is that same money arriving rather than more of it. A payment whose amount is exactly the claim's own remit figure must therefore add nothing further to that fill's revenue — `laterPayments` exists to carry the difference where a payment really is new money, and is nought where it is not.",
    observed:
      f.paymentsCountedTwice === 0
        ? "no payment is being added to the figure it settles"
        : `${f.paymentsCountedTwice} payment${f.paymentsCountedTwice === 1 ? "" : "s"} equal to the claim's own figure and still counted as revenue, ${money(f.paymentsCountedTwiceCents)} between them`,
    ok: f.paymentsCountedTwice === 0,
    difference:
      f.paymentsCountedTwice === 0
        ? null
        : `${money(f.paymentsCountedTwiceCents)} of profit exists only because a remittance was read: the fill earned it once when it was dispensed and again when the money turned up. Net profit, gross margin and every per-drug figure above them are all that much better than the pharmacy's. Whatever posted those payments is setting revenueCents to the amount instead of to nought.`,
    kind: "money",
  });

  /*
   * 10. Money the payer says it has sent has reached the cash account.
   *
   * The mirror of the check above, and it exists because both were true at the same moment: on 18
   * September the accrual side carried $28,645.57 that had never been earned twice and the cash
   * side was missing $99,238.84 that had genuinely arrived. One overstated profit, the other
   * understated it, and neither showed anywhere.
   *
   * The cash side is banked from the payer payment report, not from the remittance — deliberately,
   * because banking both would double it. The cost of that is this: when the payment report is not
   * pulled, cash simply stops, and nothing notices. The register now holds each remittance's
   * payment number, so "posted but never banked" is a question with an answer.
   */
  checks.push({
    what: "Money the payer says it has sent has reached the cash account",
    shouldBe:
      "A remittance carrying a payment number is the payer saying that deposit has been made, and the deposit is banked from the payer payment report under that same number. Every remittance with a payment number should therefore have cash banked against it. One without a payment number is not owed yet and is not counted here.",
    observed:
      f.remittancesNotBanked === 0
        ? "every remittance with a payment number has its cash"
        : `${f.remittancesNotBanked} remittance${f.remittancesNotBanked === 1 ? "" : "s"} paid and not banked, ${money(f.remittancesNotBankedCents)} between them`,
    ok: f.remittancesNotBanked === 0,
    difference:
      f.remittancesNotBanked === 0
        ? null
        : `${money(f.remittancesNotBankedCents)} has reached the bank and the cash account does not know. Cash profit, and every figure drawn from it, is that much worse than the pharmacy's. The payer payment report for those dates has not been read — it is the Payments export on the ProviderPay portal, and reading it banks them under the payment numbers they already carry.`,
    kind: "money",
  });

  return checks;
}

/** What the morning check came to, in one sentence, for a page heading or a log line. */
export function summarise(checks: Check[]): string {
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) return `All ${checks.length} checks pass.`;
  return `${bad.length} of ${checks.length} failing: ${bad.map((c) => c.what.toLowerCase()).join("; ")}.`;
}
