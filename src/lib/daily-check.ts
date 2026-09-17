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

  return checks;
}

/** What the morning check came to, in one sentence, for a page heading or a log line. */
export function summarise(checks: Check[]): string {
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) return `All ${checks.length} checks pass.`;
  return `${bad.length} of ${checks.length} failing: ${bad.map((c) => c.what.toLowerCase()).join("; ")}.`;
}
