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

/**
 * What stands for a remittance this check does not count as banked: a receipt of exactly its amount near its advice date, which the bank
 * matcher accepts and this check does not, because two remittances of one amount are two deposits. Null where nothing stands for it.
 * A receipt carrying its payment number, one naming the remittance itself, or the account history all bank it, and it is not listed.
 */
export type Tie = "amount in window" | null;

/**
 * What ProviderPay's account history on file can say of one remittance no receipt stands for. Five things, and "no deposit found" is
 * each of them in turn: none is on file; the newest on file ends too soon after the advice for its deposit to be in it (the deposit may
 * land up to the matcher's fortnight after); it reaches far enough but no file on file covers the month the advice, or the fortnight
 * after it, falls in, so there is a gap exactly where the deposit would be (`month`); the files cover it and hold nothing under the
 * payment number; or one holds a deposit under the payment number, dated `on`, that is not shown reaching a bank line already placed.
 * The first three are the history not being there to look in, the fourth is measured-and-none and the last is a bank line to place, so
 * they are not one sentence.
 */
export type History =
  | { state: "none" }
  | { state: "ends too soon" | "reaches past"; through: string }
  | { state: "has a gap"; month: string }
  | { state: "holds a deposit"; on: string };

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
  /** The invoices behind that count, largest shortfall first, as many as the store brings: who billed it and the date on it, which find an invoice in a drawer where a count does not. */
  shortInvoices: { supplier: string | null; invoiceOn: string | null; shortCents: number }[];
  /**
   * When the sweep last ran, ISO, as the sweep itself recorded it. Null if it never has.
   *
   * Not when mail last arrived: an hour or a day with no post is normal for a pharmacy, and reading the newest
   * inbox row made a healthy sweep look dead on every quiet evening.
   */
  lastSweptAt: string | null;
  /** What that run said it did. A run that failed still stamps `lastSweptAt`, so the stamp alone cannot say the post was collected. */
  lastSweepResult: string | null;
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
   * payment number is not counted here: ProviderPay has not matched it to a payment, so there is no
   * deposit to look for under a number — or its payer pays by cheque and never will. It is said
   * apart, with what stands for it, below.
   */
  remittancesNotBanked: number;
  remittancesNotBankedCents: number;
  /**
   * The remittances behind that count, largest first. Never the payment number: it is the payer's key to its own money.
   *
   * `tie` is what the bank matcher and the Remits tab already say of that remittance (engine/remit-standing.ts), asked of that one
   * computation and not worked out again here: the card and the Remits tab judge a remittance banked by the same rule, except that
   * this check does not take the same amount near the advice date as proof for a remittance that has a payment number. Where that is
   * all that stands for it the card says so, or it tells him something the Remits tab contradicts.
   *
   * `history` is what ProviderPay's account history on file can say of it. It is asked of the store, not worked out here, because it
   * turns on the same fortnight the matcher allows a remittance to take to land (engine/remit-standing.ts).
   */
  unbankedRemittances: { payer: string | null; remitOn: string | null; amountCents: number; tie: Tie; history: History }[];
  /**
   * Remittances with a payment number that no receipt carries by that number but whose deposit ProviderPay's own account history shows,
   * swept to a bank line of the same amount (engine/remit-sweep.ts). They are banked and are in neither count above; they are said here so
   * that a passing line does not hide that its evidence is the history and not a receipt.
   */
  remittancesBankedBySweep: number;
  /**
   * Remittances with a payment number that no receipt carries by that number but that a receipt keyed to the remittance number stands for
   * (engine/remit-standing.ts): the key the bank matcher writes when the register holds a remittance without its payment number, which
   * ProviderPay's later export then gives it. They are banked and are in neither count above; they are said here as the sweep ones are.
   */
  remittancesBankedByRemitNumber: number;
  /**
   * How many remittances the register holds at all, and how many claim payments came from one.
   *
   * Without these the check above passes when the register is empty, which is exactly what it did
   * on the day it was written: the import had already run, the register was built afterwards, and
   * "no remittance is unbanked" was true because no remittance was known. A check that cannot tell
   * *nothing to check* from *all clear* is not a check, and this is the pair that tells them apart.
   */
  remittanceRegisterRows: number;
  /**
   * How many remittances advised since the books began carry a payment number: the population this check judges, and the denominator
   * of every "all N" and "K of N" it says.
   *
   * Not the register's row count. A remittance advised before the books began is not money the cash account is missing
   * (`remittancesNotBanked` leaves it out, so the denominator must), and one with no payment number cannot be looked for by number.
   * On 6 October 2026 "all 62" counted 22 advised in August and before.
   */
  remittancesNumbered: number;
  /**
   * Advices since the books began of $0.00 or less: a payer's payments and take-backs netting to nothing, or a negative net, which is
   * money taken back and not money sent. There is no deposit for the bank to hold for either, so no bank line could ever clear one;
   * counting it as "advised as paid and not banked" would be an alarm nothing the pharmacy does can end. They are left out of every
   * count and list here, and said apart.
   */
  remittancesNotPositive: number;
  /**
   * The remittances since the books began with no payment number, said in the two states the check can tell apart: a receipt already
   * stands for it (a cheque payer's money arrives at the counter and its remittance never gets a number, which is why a blank number
   * is not "unpaid"), or nothing stands for it yet and it is waiting. The waiting ones are listed largest first, so that what he is
   * waiting for is named.
   */
  remittancesUnnumberedStanding: number;
  remittancesWaiting: { payer: string | null; remitOn: string | null; amountCents: number }[];
  /**
   * The newest remittance date the register holds, and the day the register was last filled from an export; each null while it is empty.
   *
   * The horizon of the check, and a fact rather than a sentence: the ProviderPay pull is monthly and by hand, so between pulls this
   * check reads an older and older snapshot while saying nothing about it. Two dates because they are not one: advice is dated the day
   * the payer remitted and the export is read days later, and "reading to the 30th (6 days ago)" made an export read the day before look
   * a week stale. A green line that means "reconciled to the 17th" and reads as "reconciled" is what CLAUDE.md's sixth clause is about.
   */
  remittanceRegisterThrough: string | null;
  remittanceRegisterReadOn: string | null;
  remittancePaymentsPosted: number;
  /** Today, so the check does not have to ask the clock and can be tested. */
  today: string;
  /** Now, ISO, for the same reason. */
  now: string;
};

export type Check = {
  /** What is being checked, as a person would say it. */
  what: string;
  /** The page where the thing found can be seen. The dashboard used to guess it from the words of the finding, and sent all three of 6 October 2026's to /money. */
  href: string;
  /** What that press is called, in the words of the page it lands on. */
  action: string;
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

/*
 * How far the remittance register reaches, said on the same line as its verdict.
 *
 * The pull is monthly and by hand — the owner, 26 September 2026: "were going to have to get monthly
 * with out auto task". So a gap between pulls is the design working, and the check must not report
 * it as a fault. What it must not do either is stay silent about it: on the eleventh day the line
 * still read "all 51 remittances have their cash" with no hint that it had seen nothing since the
 * 17th. The horizon goes in the observation, where the number he reads is, and not in a footnote.
 */
function horizon(f: Facts): string {
  const read = f.remittanceRegisterReadOn;
  const through = f.remittanceRegisterThrough;
  if (!read && !through) return "";
  const ago = (iso: string) => {
    const days = daysBetween(iso, f.today);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  };
  const readSaid = read ? `the last ProviderPay export was read ${read} (${ago(read)})` : "the last ProviderPay export";
  const holds = through ? ` ${read ? "and holds" : "holds"} advice to ${through}` : "";
  return `; ${readSaid}${holds}`;
}

/** The rows since the books began with no payment number, said by what is known of each rather than netted out of the count. */
function unnumberedSaid(f: Facts): string {
  const stands = f.remittancesUnnumberedStanding;
  const waits = f.remittancesWaiting.length;
  const n = stands + waits;
  if (n === 0) return "";
  const parts: string[] = [];
  if (stands > 0) parts.push(`${stands} ${stands === 1 ? "has a receipt standing for it" : "have a receipt standing for them"}, by remittance number or amount`);
  if (waits > 0) {
    const items = f.remittancesWaiting.map((r) => `${r.payer ?? "payer not captured"}, advised ${r.remitOn ?? "date not captured"}, ${money(r.amountCents)}`);
    parts.push(`${waits} ${waits === 1 ? "has" : "have"} nothing standing for ${waits === 1 ? "it" : "them"} yet and ${waits === 1 ? "is" : "are"} waiting (${listed(items, waits)})`);
  }
  const noun = `${f.remittancesNumbered > 0 ? "other " : ""}remittance${n === 1 ? "" : "s"}`;
  return `; ${n} ${noun} ${n === 1 ? "carries" : "carry"} no payment number yet: ${parts.join(", and ")}`;
}

/** Advices of nothing or less, said apart: they are not money sent, so they are in none of the counts or lists around this clause. */
function notPositiveSaid(f: Facts): string {
  const n = f.remittancesNotPositive;
  if (n === 0) return "";
  return `; ${n} ${n === 1 ? "advice" : "advices"} of nothing or less ${n === 1 ? "is" : "are"} not money sent and ${n === 1 ? "is" : "are"} not judged`;
}

/** What ProviderPay's account history on file can and cannot say of a remittance no receipt stands for: five states, not one. */
function historySaid(h: History): string {
  if (h.state === "none") return "no ProviderPay account history is on file to look in";
  if (h.state === "holds a deposit") return `ProviderPay's account history holds a deposit under its payment number, dated ${h.on}, that is not shown reaching a bank line already placed`;
  if (h.state === "ends too soon") return `the newest ProviderPay account history on file ends ${h.through}, too soon after it was advised to show its deposit either way`;
  if (h.state === "has a gap") return `no ProviderPay account history on file covers ${h.month}, so it cannot show its deposit either way`;
  return `ProviderPay's account history on file (to ${h.through}) holds no deposit under its payment number`;
}

/** Says how many remittances were shown banked by the account history rather than by a receipt, so the evidence is not hidden by the count. */
function sweptSaid(f: Facts, who: "of them" | "other"): string {
  const n = f.remittancesBankedBySweep;
  if (n === 0) return "";
  const subject = who === "of them" ? `${n} of them ${n === 1 ? "is" : "are"}` : `${n} ${n === 1 ? "other is" : "others are"}`;
  return `; ${subject} shown banked by ProviderPay's account history, not by a receipt carrying the payment number`;
}

/** Says how many remittances were shown banked by a receipt keyed to the remittance number, so the evidence is not hidden by the count. */
function namedSaid(f: Facts, who: "of them" | "other"): string {
  const n = f.remittancesBankedByRemitNumber;
  if (n === 0) return "";
  const subject = who === "of them" ? `${n} of them ${n === 1 ? "is" : "are"}` : `${n} ${n === 1 ? "other is" : "others are"}`;
  return `; ${subject} banked by a receipt keyed to the remittance number, not the payment number`;
}

const NAMED = 3;

/** Names up to NAMED of `total` things and says how many it left out. */
function listed(items: string[], total: number): string {
  const shown = items.slice(0, NAMED);
  const rest = total - shown.length;
  return rest > 0 ? `${shown.join("; ")}; and ${rest} more` : shown.join("; ");
}

function shortNamed(f: Facts): string {
  if (f.shortInvoices.length === 0) return "";
  const lone = f.invoicesShort === 1;
  const items = f.shortInvoices.map(
    (r) => `${r.supplier ?? "supplier not captured"}, ${r.invoiceOn ?? "date not captured"}${lone ? "" : `, ${money(r.shortCents)} short`}`,
  );
  return ` (${listed(items, f.invoicesShort)})`;
}

/** The invoices page has no "short" filter, so the first short invoice is reached by its supplier and its day. */
function shortLink(f: Facts): string {
  const first = f.shortInvoices[0];
  const q = new URLSearchParams();
  if (first?.supplier) q.set("supplier", first.supplier);
  if (first?.invoiceOn) q.set("on", first.invoiceOn);
  const query = q.toString();
  return query ? `/inventory/invoices?${query}` : "/inventory/invoices";
}

const TIE_SAID = {
  "amount in window": "a receipt of exactly that amount, near the advice date, stands for it by amount alone and not by its payment number",
} as const;

/** What stands for a remittance this check does not call banked, and then what the account history on file can say of it: the two things that settle it. */
function unbankedNamed(f: Facts): string {
  if (f.unbankedRemittances.length === 0) return "";
  const lone = f.remittancesNotBanked === 1;
  const items = f.unbankedRemittances.map((r) => {
    const standing = r.tie ? TIE_SAID[r.tie] : "no receipt stands for it, by payment number, remittance number or amount";
    return `${r.payer ?? "payer not captured"}, advised ${r.remitOn ?? "date not captured"}${lone ? "" : `, ${money(r.amountCents)}`}: ${standing}, and ${historySaid(r.history)}`;
  });
  return ` (${listed(items, f.remittancesNotBanked)})`;
}

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
    href: "/inbox",
    action: "See the inbox",
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
    href: "/inventory/invoices",
    action: "See the invoices",
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
    href: "/suppliers",
    action: "See where the rebate stands",
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
    href: shortLink(f),
    action: f.invoicesShort === 1 ? "See the invoice" : "See the invoices",
    shouldBe:
      "An invoice reconciles when its item lines plus its printed charges equal its printed total. That arithmetic is the only thing proving the reading, so a shortfall is either money billed and never booked, or a line the reader cannot see.",
    observed:
      f.invoicesShort === 0
        ? "every invoice on file reconciles"
        : `${f.invoicesShort} invoice${f.invoicesShort === 1 ? "" : "s"} short by ${money(f.invoicesShortCents)}${f.invoicesShort === 1 ? "" : " in total"}${shortNamed(f)}`,
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
  const sweptRecently = hoursSinceSweep !== null && hoursSinceSweep <= 6;
  // The sweep writes ", N error(s)" into its result whenever anything went wrong (mailbox.ts).
  const sweepErrored = f.lastSweepResult !== null && /\d+ error\(s\)/.test(f.lastSweepResult);
  const sweptAgo =
    hoursSinceSweep === null
      ? "never swept"
      : hoursSinceSweep < 1
        ? "last swept within the hour"
        : `last swept ${Math.round(hoursSinceSweep)} hour${Math.round(hoursSinceSweep) === 1 ? "" : "s"} ago`;
  checks.push({
    what: "The mailbox is being swept",
    href: "/settings/email",
    action: "See the mail settings",
    shouldBe:
      "Every feed except PioneerRx arrives as email, so the sweep is the way almost all data reaches this site. It runs about every half hour whether or not any mail has come, so the measure is the time since it last ran cleanly, not the time since mail last arrived: a quiet mailbox is normal, and a sweep that has stopped or ended in an error is not. More than six hours without a clean run means it is failing or being starved, and nothing else would say so.",
    observed: hoursSinceSweep !== null && sweepErrored ? `${sweptAgo}, and that run ended with an error` : sweptAgo,
    ok: sweptRecently && !sweepErrored,
    difference:
      sweptRecently && !sweepErrored
        ? null
        : sweptRecently
          ? "The last sweep ran but ended with an error, so mail may be sitting unread in the mailbox. The mail settings page shows the error."
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
    href: "/expenses",
    action: "See the expenses",
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
    href: "/expenses",
    action: "See the expenses",
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
    href: "/suppliers",
    action: "See the suppliers",
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
    href: "/money",
    action: "See the money",
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
    href: "/remits",
    action: "See the remittances",
    shouldBe:
      "A remittance carrying a payment number is the payer saying that deposit has been made, and the deposit is banked from the payer payment report under that same number. Every such remittance advised since the books began should therefore have cash banked against it: a receipt carrying that number; or, where the receipt was banked under another remittance of the same amount, ProviderPay's account history showing the deposit under that number swept to a bank line of the same amount; or a receipt keyed to the remittance's own number. A receipt of the same amount near the advice date is not enough for one that has a payment number, because two remittances of one amount are two deposits. One with no payment number cannot be looked for by number: ProviderPay has not matched it to a payment yet, or its payer pays by cheque and never will. It is said apart from the count, with what stands for it, and joins the count if it is given a number.",
    observed:
      /*
       * Never measured comes first, because it is the answer that looks most like success.
       *
       * Remittances have been posted and the register knows of none, so the comparison has nothing
       * to compare and would otherwise report "every remittance has its cash" — the reassuring
       * sentence, from no evidence at all.
       */
      f.remittanceRegisterRows === 0
        ? f.remittancePaymentsPosted === 0
          ? "no remittance has been read yet, so there is nothing to compare"
          : `${f.remittancePaymentsPosted} payments came from a remittance and the register holds none of them, so nothing can be compared`
        : f.remittancesNotBanked > 0
          ? `${f.remittancesNotBanked} of the ${f.remittancesNumbered} remittances with a payment number, advised since the books began, ${f.remittancesNotBanked === 1 ? "is" : "are"} advised as paid and not banked, ${money(f.remittancesNotBankedCents)}${f.remittancesNotBanked === 1 ? "" : " between them"}${unbankedNamed(f)}${sweptSaid(f, "other")}${namedSaid(f, "other")}${unnumberedSaid(f)}${notPositiveSaid(f)}${horizon(f)}`
          : f.remittancesNumbered === 0
            ? `no remittance advised since the books began carries a payment number, so there is nothing for this check to compare${unnumberedSaid(f)}${notPositiveSaid(f)}${horizon(f)}`
            : `all ${f.remittancesNumbered} remittances with a payment number, advised since the books began, have their cash${sweptSaid(f, "of them")}${namedSaid(f, "of them")}${unnumberedSaid(f)}${notPositiveSaid(f)}${horizon(f)}`,
    ok: f.remittancesNotBanked === 0 && !(f.remittanceRegisterRows === 0 && f.remittancePaymentsPosted > 0),
    difference:
      f.remittanceRegisterRows === 0 && f.remittancePaymentsPosted > 0
        ? "The register is empty while payments posted from remittances are on the books, so this check is measuring nothing. Re-read the Remit Summary export to fill it; until then neither this check nor the cash side can be trusted."
        : f.remittancesNotBanked === 0
          ? null
          : `${money(f.remittancesNotBankedCents)} is advised as paid and no receipt carries its payment number. Two causes look the same here: the deposit has reached the bank and has not been tied to this payment number yet, or the payer has advised it and not yet paid it. A deposit of that amount on the bank statement, on or after the advice date, settles which — unless that deposit already stands for another remittance of the same amount, because two remittances of one amount are two deposits. ProviderPay's account history for the month shows each deposit by its payment number and each sweep to the bank; where it shows this remittance's deposit reaching a bank line, the remittance is banked and leaves this list, so one that is on it is one the history on file does not show, or does not yet reach. The Payments export, read, can tie a deposit too, but the site can refuse its receipt as the same money as a receipt it already holds of that amount within a week, so where one is already there the account history is what settles it. Each remittance named above says what stands for it and what the history can show.`,
    kind: "money",
  });

  return checks;
}

/** What the morning check came to, in one sentence, for a page heading or a log line. */
export function summarise(checks: Check[]): string {
  const bad = checks.filter((c) => !c.ok);
  if (bad.length === 0) return `All ${checks.length} checks pass.`;
  // `what` is the rule, not the finding: said bare after "failing:" it reads as though the rule held.
  return `${bad.length} of ${checks.length} failing. Should be: ${bad.map((c) => c.what.charAt(0).toLowerCase() + c.what.slice(1)).join("; ")}.`;
}

/**
 * What Today shows when the morning check itself could not run.
 *
 * Today used to turn a thrown error into "no checks, none failing", which reads as all clear, and the card appears only when something
 * fails, so a check that never ran looked exactly like one that passed. A check that did not run is not measured, and saying so is the one
 * thing it can still do. The reason is the first line of the error with long digit runs masked, so a message that carries an
 * identifier does not reach the screen. Opening Today runs the check again, which is what "Try again" does.
 */
export function checkCouldNotRun(reason: unknown, now: string = new Date().toISOString()): { checks: Check[]; failing: number; says: string; ranAt: string } {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const why = raw.split("\n")[0].replace(/\d{5,}/g, "#####").trim().slice(0, 160);
  const check: Check = {
    what: "The morning check runs",
    href: "/",
    action: "Try again",
    shouldBe: "The morning check runs every time Today is opened, so what it checks has been looked at.",
    observed: `not measured: the check could not run${why ? ` (${why})` : ""}, so nothing it looks at was looked at just now`,
    ok: false,
    difference:
      "A check that did not run has not passed. Opening Today runs it again; until it runs, nothing the check covers (invoices, the mailbox, remittances, the feeds) has been judged.",
    kind: "money",
  };
  return { checks: [check], failing: 1, says: "The morning check could not run, so none of its checks was looked at.", ranAt: now };
}
