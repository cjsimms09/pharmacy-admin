/**
 * Whether the site's own data is complete enough to be believed.
 *
 * The owner: "The logic and data in this site needs to be correct, full, and cleanly organized. If
 * we are missing data, I need to know and we need to fix it. Data needs to link when it should! …
 * all these things HAVE to be correct or what we are building will not only fail but lead us
 * astray."
 *
 * Every figure elsewhere on this site is defined only on the rows that linked. A margin exists for
 * a fill whose NDC found a catalogue row with a pack size; an "under NADAC" alert exists for a fill
 * whose NDC found a NADAC row current on the day; a reimbursement formula exists for a claim that
 * matched a contract. Where the link fails the figure is not wrong, it is absent — and an absent
 * figure looks exactly like a good month. That is the failure this page exists to remove, and it
 * is the one that has already cost this project money twice: eight invoice lines that matched no
 * supplier and left the rebate arithmetic without a word, and an invoice for $1,530.89 with no
 * item lines under it that read as an ordinary filed invoice.
 *
 * ── This module counts nothing itself ──
 *
 * It is the definitions and the arithmetic, pure, so the arithmetic can be tested without a
 * database. `data-health-store.ts` runs the queries and hands the numbers in. That split is not
 * tidiness: every libsql call blocks the Node event loop, 200,000 rows is 1.7 seconds during which
 * the web server answers nothing, and a page that recounted on every view would take the site down
 * while telling you how healthy it is.
 *
 * ── The rules that keep a percentage honest ──
 *
 * These are the point of the module, because a rounded number reading 100% while something is
 * missing is precisely the silence being removed.
 *
 *   - 100% is printed only when the numerator equals the denominator. 26,245 of 26,246 rounds to
 *     100.0% and must not print it: one row is missing and this page exists to say so.
 *   - 0% is printed only when the numerator is zero, for the same reason in the other direction.
 *   - A denominator of zero is not 0% and not 100%. There is nothing to measure, which is a third
 *     answer and a common one here — no on-hand count has ever been received, so "counted rows
 *     matching a catalogue row" has no denominator at all.
 *   - A measurement never taken is not a measurement of zero. `measuredAt` null says nobody has
 *     asked; a zero with a date is a fact, and 0 of 1,081 insured fills matching a contract is one
 *     of the most important facts on the page.
 *   - A numerator above its denominator is a counting fault, reported as one rather than printed
 *     as 103%.
 */

/** How much of a thing linked where it had to. One row on the page. */
export type Measurement = {
  /** Stable identifier, so a row keeps its history when its wording changes. */
  key: string;
  numerator: number;
  denominator: number;
  /** ISO date the count was taken. Null where it never has been. */
  measuredAt: string | null;
  /**
   * The worst gaps, already in words and already counted by the store.
   *
   * "29 dispensed NDCs have no NADAC — 2 are devices, 27 are repackager labels" is the shape. A
   * gap the store could not characterise is still listed as a bare number, because an
   * uncharacterised gap is not a missing one.
   */
  gaps?: string[];
  /**
   * Why the figure is what it is, where the number alone would mislead.
   *
   * A measured zero nearly always needs one. 0 of 1,081 insured fills match a contract because the
   * matcher reads BIN, PCN and group while the contracts name networks and chain codes — which is
   * a different problem, and a different fix, from "nobody has filed a contract".
   */
  note?: string | null;
};

/** What kind of trouble a row is in. */
export type Health = "unmeasured" | "empty" | "broken" | "poor" | "fair" | "good" | "complete";

export type HealthGroup = "Datasets" | "Links that must hold";

export type HealthRow = {
  key: string;
  title: string;
  group: HealthGroup;
  /** What the numerator counts and what the denominator counts, so the figure has one meaning. */
  of: string;
  /** Why this link matters, in the owner's terms rather than the schema's. */
  why: string;
  numerator: number;
  denominator: number;
  /** Null where there is nothing to measure, or nobody has measured. Never a stand-in zero. */
  percent: number | null;
  /** The percentage as it should be printed, with the rounding rules applied. */
  percentText: string;
  /** "26,245 of 26,246". What the owner acts on. */
  fractionText: string;
  /** The two together, which is how a row prints: "26,245 of 26,246 · 99.9%". */
  countText: string;
  health: Health;
  measuredAt: string | null;
  /** Days since it was measured, where it has been. */
  ageDays: number | null;
  stale: boolean;
  gaps: string[];
  note: string | null;
  /** The rows that did not link, where both numbers are known. */
  missing: number | null;
};

/**
 * The true ratio, unrounded, or null where there is nothing to measure.
 *
 * Unrounded on purpose: a caller sorting by this sorts by the real number. The two guard rails
 * live in `percentTextOf`, which is what a reader actually sees.
 */
export function percentOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

/**
 * The percentage as it should appear on the screen.
 *
 * One decimal place, except that 100% and 0% are reserved for the complete and the empty. Anything
 * short of the whole prints as at most 99.9%, anything above nothing as at least 0.1%, so the two
 * numbers a reader treats as absolutes stay absolute.
 */
export function percentTextOf(numerator: number, denominator: number): string {
  if (denominator <= 0) return "nothing to measure";
  if (numerator > denominator) return "counting fault";
  if (numerator === denominator) return "100%";
  if (numerator === 0) return "0%";
  const raw = (numerator / denominator) * 100;
  const shown = Math.min(99.9, Math.max(0.1, Math.round(raw * 10) / 10));
  return `${shown.toFixed(1)}%`;
}

/**
 * The count, in words, beside the percentage.
 *
 * The percentage is how a row is scanned; the count is what gets acted on. "29 dispensed NDCs have
 * no NADAC" is a morning's work with a list at the end of it, and "95.7%" is a feeling about the
 * data — so both are printed, always together, and the fraction is never dropped to save a column.
 */
export function fractionTextOf(numerator: number, denominator: number): string {
  const n = numerator.toLocaleString("en-US");
  const d = denominator.toLocaleString("en-US");
  if (denominator <= 0) return `${n} of none`;
  return `${n} of ${d}`;
}

/** The fraction and the percentage as one string, which is how every row prints it. */
export function countTextOf(numerator: number, denominator: number): string {
  return `${fractionTextOf(numerator, denominator)} · ${percentTextOf(numerator, denominator)}`;
}

/** Whole days between two ISO dates, or null where either is missing or unreadable. */
export function daysSince(measuredAt: string | null, today: string): number | null {
  if (!measuredAt) return null;
  const a = Date.parse(`${measuredAt.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * How much trouble a row is in.
 *
 * The bands are coarse on purpose: the page is read to decide what to do next, not to admire a
 * number. "broken" is reserved for a link that has a denominator and matched nothing at all — the
 * state that looks identical to a healthy quiet month everywhere else on the site, and the reason
 * this page exists.
 */
export function healthOf(m: { numerator: number; denominator: number; measuredAt: string | null }): Health {
  if (!m.measuredAt) return "unmeasured";
  if (m.denominator <= 0) return "empty";
  if (m.numerator > m.denominator) return "broken";
  if (m.numerator === 0) return "broken";
  if (m.numerator === m.denominator) return "complete";
  const p = (m.numerator / m.denominator) * 100;
  if (p < 50) return "poor";
  if (p < 90) return "fair";
  return "good";
}

/** Worst first, which is how the page sorts. */
const ORDER: Record<Health, number> = {
  broken: 0,
  unmeasured: 1,
  poor: 2,
  empty: 3,
  fair: 4,
  good: 5,
  complete: 6,
};

export type LinkSpec = { key: string; title: string; of: string; why: string; group: HealthGroup };

/**
 * Every dataset and every link the owner named, in the order of BACKLOG item 9.
 *
 * The store measures these keys and no others. A key here with no measurement shows as "not
 * measured" rather than vanishing, because a link nobody has counted is exactly as invisible as a
 * link that fails.
 */
export const SPECS: LinkSpec[] = [
  {
    key: "claims",
    group: "Datasets",
    title: "Claims",
    of: "paid, non-cash fills — counted by prescription, fill number, date and NDC, never by claim row, because one fill can carry a second payor",
    why: "Every money figure on the site starts here.",
  },
  {
    key: "catalogue",
    group: "Datasets",
    title: "Supplier catalogues",
    of: "catalogue rows carrying a price, out of all catalogue rows",
    why: "A row with no price cannot be bought from or compared.",
  },
  {
    key: "catalogue-currency",
    group: "Datasets",
    title: "Catalogue files arriving",
    of: "supplier catalogues whose newest file arrived in the last two days, out of the suppliers the site expects a nightly catalogue from",
    why:
      "A wholesaler whose file stopped arriving still shows prices — last week's. Nothing else on the site says a catalogue went quiet, so a price that has not moved in a month looks exactly like a price that has not changed.",
  },
  {
    key: "claims-window",
    group: "Datasets",
    title: "How much history the claims cover",
    of: "days between the first and last fill held, out of the 365 a year's history would carry",
    why:
      "Every rate, every steadiness test and every trend is judged on whatever window exists. A window this short cannot tell a slow seller from a new one, and nothing else on the site says how short it is.",
  },
  {
    key: "nadac",
    group: "Datasets",
    title: "NADAC",
    of: "NDCs whose newest NADAC row is within three months, out of NDCs carrying any NADAC row",
    why: "The benchmark every over- and under-payment figure is measured against, and the Kansas floor. A stale one is not the figure in force.",
  },
  {
    key: "fda-directory",
    group: "Datasets",
    title: "FDA directory",
    of: "rows loaded",
    why: "Product identity: which NDCs are the same drug. Without it, grouping falls back to a wholesaler's typing.",
  },
  {
    key: "invoices",
    group: "Datasets",
    title: "Supplier invoices",
    of: "invoices with item lines read, out of invoices filed",
    why: "What the pharmacy actually paid. An invoice with a total and no lines reaches the cost of no drug.",
  },
  {
    key: "claims-proof",
    group: "Datasets",
    title: "Claims proved against the reports they came from",
    of: "rows proved, out of every row that has to be proved — the paid rows in the daily reports plus the claim rows no report accounts for",
    why:
      "Every other row on this page measures whether the site's tables agree with each other, which they can do perfectly while all of them disagree with the file they were read from. This one re-reads the stored reports each night and sets them against the claims. Both directions count: a paid row in a report that reached no claim, and a claim no report explains, are the same failure seen from opposite ends, and a denominator that could only see one of them would read a hundred per cent with four hundred strays in the table.",
  },
  {
    key: "onhand-proof",
    group: "Datasets",
    title: "The shelf count proved against the report's own record count",
    of: "items on the shelf, out of the records the report says it holds",
    why:
      "The shelf values the pharmacy's inventory and stands on one side of the cost-of-goods identity, so a row the reader dropped is stock the accounts do not know exists. Everything else the site knows about a count came out of the same reader, which means a reader that lost rows and a report that never had them look identical — the record count PioneerRx prints about itself is the only figure here that did not.",
  },
  {
    key: "catalogue-proof",
    group: "Datasets",
    title: "Each wholesaler's catalogue proved against its own file",
    of: "NDCs the table agrees with the newest file about, out of every NDC that file carries — per NDC, never per listing",
    why:
      "The catalogue is what every buying decision here is made from: which supplier is cheapest, what an add-on costs, what the shelf is worth. A price the table holds that the wholesaler's file does not state is a purchase made on a number nobody sent. Counted per NDC because a wholesaler lists the same NDC several times in one file — McKesson 539 of them — and the table keeps one. Prices carried over from an earlier file are outside the figure and named in the gaps with their age: the newest file says nothing about them, so there is nothing to agree or disagree with, and counting them against the score would make a wholesaler who trimmed their catalogue look like one whose prices are wrong.",
  },
  {
    key: "nadac-proof",
    group: "Datasets",
    title: "NADAC proved against the CMS files it came from",
    of: "distinct prices accounted for, out of every price that has to be — those held, plus those the files carry that the table has not got",
    why:
      "Every over- and under-payment figure on this site is measured against NADAC, and the Kansas floor is calculated from it, so a price the table holds that no file contained is wrong money on a screen. Counted in prices rather than rows: the weekly files republish the same NDC and effective date about seven times each, so a figure built on rows would read five and three-quarter million out of five and three-quarter million and mean nothing. It also reports a file that has changed since it was loaded — the one fault where every count is right and the file they describe no longer exists.",
  },
  {
    key: "nadac-prune",
    group: "Datasets",
    title: "The nightly NADAC prune",
    of: "whether the last run succeeded",
    why:
      "The benchmark table is trimmed each night to the months the pharmacy can use; without it, it grows by about a million and a half rows a year and every reading over it grows with it. This has already failed silently: the prune had one caller, reached only when a new file had just been loaded, and swallowed its own error — so a prune that never ran and one that failed every time looked identical, and 770,000 prices sat past the cutoff with nothing to say so. Kept apart from the proof above because they are different failures: the prices being right, and the table being the size it should be.",
  },
  {
    key: "directory-proof",
    group: "Datasets",
    title: "The FDA directory proved against the load that wrote it",
    of: "packages in the table, out of the packages the last load says it wrote",
    why:
      "The directory decides which NDCs are the same drug, so a row lost from it silently ungroups a product and every equivalent, price comparison and substitution that runs through it. The loader records what it parsed and wrote at the moment it wrote — the measurement is free there and costs 430 MB anywhere else — and this sets that against the table today. The date is the load's, so a weekly fetch that quietly stopped shows here as an ageing proof over counts that are all perfectly correct.",
  },
  {
    key: "invoices-proof",
    group: "Datasets",
    title: "Invoices proved against their own printed total",
    of: "invoices whose stored lines add to the total printed on the invoice's face, out of invoices carrying a total",
    why:
      "The invoice states what it came to and the lines say what was bought; if they do not agree, one of the drugs on that invoice has the wrong cost against it and every margin, rebate and purchase figure that uses it is wrong by an amount nobody can see. A partial read is the dangerous outcome, not a failed one — the lines that were read look perfectly sound and only the product whose line was dropped appears cheaper than the pharmacy paid.",
  },
  {
    key: "supplier-invoices",
    group: "Datasets",
    title: "Which wholesalers have sent an invoice",
    of: "active wholesalers with at least one invoice on file, out of every active wholesaler",
    why:
      "The row above counts the invoices that arrived and cannot see the ones that never did. Four of this pharmacy's five wholesalers have never had an invoice loaded, so nothing bought from them has a cost, a supplier or a return clock — and every screen that asks 'who sold this bottle' answers 'no invoice on file' without saying that it will go on answering that until somebody forwards one.",
  },
  {
    key: "supplier-returns",
    group: "Datasets",
    title: "Returns policies",
    of: "active wholesalers with a returns policy on file, out of every active wholesaler",
    why:
      "A returns policy is what turns an invoice line into a deadline: the credit now, the day it steps down, the day the window shuts. Without one the site is silent on that supplier's stock — correctly silent, because a guessed window would send a bottle back on a date nobody agreed to — but silence here reads exactly like nothing needing to go back.",
  },
  {
    key: "on-hand",
    group: "Datasets",
    title: "On-hand counts",
    of: "counted rows",
    why: "What is on the shelf and what it is worth. Nothing else can value the inventory.",
  },
  {
    key: "contracts",
    group: "Datasets",
    title: "Contracts",
    of: "documents read into terms, out of documents held",
    why: "A contract nobody has read cannot price a claim.",
  },
  {
    key: "remits",
    group: "Datasets",
    title: "Later payments and remittances",
    of: "later payment lines loaded — facilitator payments, DIR, copay cards, and 835 remittance lines once any arrive",
    why: "What the plan actually paid, as opposed to what it said at adjudication.",
  },
  {
    key: "bank",
    group: "Datasets",
    title: "Bank lines",
    of: "bank lines loaded",
    why: "Cash that actually arrived, which is the end of every claim's story.",
  },

  {
    key: "claim-fda",
    group: "Links that must hold",
    title: "Claim NDC → FDA directory",
    of: "distinct NDCs dispensed on insured paid fills that the FDA directory places, out of all NDCs dispensed on insured paid fills",
    why: "Equivalence. Without it a product cannot be compared with the alternatives to it.",
  },
  {
    key: "claim-nadac",
    group: "Links that must hold",
    title: "Claim NDC → NADAC, current within three months",
    of: "distinct NDCs dispensed on insured paid fills with a NADAC row within three months, out of all NDCs dispensed on insured paid fills",
    why: "The benchmark every over- and under-payment figure uses.",
  },
  {
    key: "claim-catalogue",
    group: "Links that must hold",
    title: "Claim NDC → catalogue row with a pack size",
    of: "distinct NDCs dispensed on insured paid fills with a catalogue row carrying a pack size, out of all NDCs dispensed on insured paid fills",
    why: "A per-unit cost. Without a pack size there is no margin on the fill, only a pack price.",
  },
  {
    key: "catalogue-awp",
    group: "Links that must hold",
    title: "Catalogue row → AWP",
    of: "catalogue rows carrying an AWP, out of all catalogue rows",
    why: "Needed wherever a plan pays a discount off AWP.",
  },
  {
    key: "claim-plan",
    group: "Links that must hold",
    title: "Claim → payer → plan class",
    of: "insured fills whose BIN, PCN and group resolve to a plan carrying a class, out of all insured fills",
    why: "Who paid, and under what law — which decides whether the Kansas floor applies at all.",
  },
  {
    key: "claim-contract",
    group: "Links that must hold",
    title: "Claim → contract",
    of: "insured fills matching a contract on file, out of all insured fills",
    why: "The reimbursement formula. Without it there is nothing to check what was paid against.",
  },
  {
    key: "claim-remit-deposit",
    group: "Links that must hold",
    title: "Claim → later payment → deposit",
    of: "insured fills traced to a later payment, and that payment to a bank deposit, out of all insured fills",
    why:
      "Cash actually received rather than promised. Titled 'later payment' and not '835' on purpose: every payment on file is facilitator money, and calling it an 835 would report coverage of a remittance flow that has not started.",
  },
  {
    key: "invoice-supplier-ladder",
    group: "Links that must hold",
    title: "Invoice → register row → rebate ladder",
    of: "invoice lines resolving to a supplier that has a rebate ladder, out of all invoice lines",
    why: "What was really paid, after the rebate. A line resolving to no supplier leaves the rebate arithmetic silently.",
  },
  {
    key: "catalogue-package",
    group: "Links that must hold",
    title: "Catalogue row → FDA package size",
    of: "catalogue rows whose pack size agrees with the FDA package description, out of catalogue rows where both sides could be read",
    why: "Unit arithmetic that does not cross units. A per-EA cost against a per-ML benchmark once read as 100 times NADAC.",
  },
  {
    key: "onhand-catalogue",
    group: "Links that must hold",
    title: "On-hand count → catalogue row",
    of: "counted rows matching a catalogue row, out of all counted rows",
    why: "What is on the shelf, valued at what it cost.",
  },
];

/**
 * Turns raw counts into the rows the page shows.
 *
 * A spec with no measurement becomes an "unmeasured" row rather than disappearing, and a
 * measurement whose key matches no spec is ignored rather than guessed at.
 */
export function buildHealth(
  measurements: Measurement[],
  today: string,
  opts: { staleAfterDays?: number } = {},
): HealthRow[] {
  const staleAfter = opts.staleAfterDays ?? 7;
  const by = new Map(measurements.map((m) => [m.key, m]));

  return SPECS.map((spec) => {
    const m = by.get(spec.key);
    const numerator = m?.numerator ?? 0;
    const denominator = m?.denominator ?? 0;
    const measuredAt = m?.measuredAt ?? null;
    const ageDays = daysSince(measuredAt, today);
    return {
      key: spec.key,
      title: spec.title,
      group: spec.group,
      of: spec.of,
      why: spec.why,
      numerator,
      denominator,
      percent: measuredAt ? percentOf(numerator, denominator) : null,
      percentText: measuredAt ? percentTextOf(numerator, denominator) : "not measured",
      fractionText: measuredAt ? fractionTextOf(numerator, denominator) : "not measured",
      countText: measuredAt ? countTextOf(numerator, denominator) : "not measured",
      health: healthOf({ numerator, denominator, measuredAt }),
      measuredAt,
      ageDays,
      stale: ageDays !== null && ageDays > staleAfter,
      gaps: m?.gaps ?? [],
      note: m?.note ?? null,
      missing: measuredAt && denominator > 0 && numerator <= denominator ? denominator - numerator : null,
    };
  }).sort((a, b) => ORDER[a.health] - ORDER[b.health] || a.key.localeCompare(b.key));
}

/** One line for the top of the page, and for anywhere else that wants the state in a sentence. */
export function summarise(rows: HealthRow[]): { worst: Health; says: string } {
  if (rows.length === 0) return { worst: "unmeasured", says: "Nothing has been measured yet." };
  const count = (h: Health) => rows.filter((r) => r.health === h).length;
  const broken = count("broken");
  const unmeasured = count("unmeasured");
  const empty = count("empty");
  const worst = rows.reduce<Health>((w, r) => (ORDER[r.health] < ORDER[w] ? r.health : w), "complete");

  const bits: string[] = [];
  if (broken > 0) bits.push(`${broken} link${broken === 1 ? "" : "s"} matching nothing at all`);
  if (empty > 0) bits.push(`${empty} with no data to measure`);
  if (unmeasured > 0) bits.push(`${unmeasured} never measured`);
  if (bits.length === 0) return { worst, says: "Every link measured, and every one of them holds." };
  return { worst, says: `${bits.join(", ")}.` };
}
