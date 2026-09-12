/**
 * Money this site has seen and cannot put under a heading.
 *
 * The owner, on what he needs the site to do without him: *"identify when we don't [know] or when
 * something is wrong."*
 *
 * That rule is implemented in exactly one place today, and it is the best thing in the remittance
 * reader: a file whose arithmetic does not close posts nothing and says what is missing. Everywhere
 * else, money the site cannot place goes quiet in a different way each time — a sentence on a
 * receipt, a note on a payment row, a flag nobody renders. Each is true, each is somewhere, and
 * together they are not a number, so nothing gets smaller and nobody can tell whether this month is
 * better than last.
 *
 * This is that number. Not a new kind of finding: the same five or six facts the site already
 * knows, added up, so the question "how much of this pharmacy's money is the site unsure about"
 * has an answer on a page rather than in five files.
 *
 * ── The one rule that makes it worth having ──
 *
 * **A total is a floor unless every part of it was measured.** A pot nobody has counted is not a pot
 * of nothing, and a total that quietly leaves it out reads as *"$412.60 unplaced"* when the truth
 * is *"$412.60 that we know of, and one kind we have never looked at"*. That is the same failure as
 * a health page rounding 26,245 of 26,246 up to 100% — the arithmetic is right and the sentence is
 * a lie. So `total.floor` says whether the figure is complete, and the wording changes with it.
 *
 * The second rule follows from the first: rows whose money is unknown still count as rows. Sixteen
 * payments that matched no claim are sixteen findings whether or not anybody has summed them, and
 * hiding them until the sum exists is how a gap becomes invisible for a quarter.
 *
 * ── This module counts nothing ──
 *
 * Same split as `data-health.ts`, for the same reason: every libsql call blocks the event loop, and
 * the arithmetic has to be testable without a database. The store supplies counts; this supplies
 * the definitions, the arithmetic and the words.
 */

/** A kind of money the site can find but cannot place, defined once. */
export type UnclassifiedSpec = {
  /** Stable across rewordings, so a row keeps its history. */
  key: string;
  /** What the money is, in the words the owner would use. */
  what: string;
  /** Why it cannot be placed. The cause, not the symptom. */
  why: string;
  /** What would resolve it — an instruction, not a wish. */
  resolvedBy: string;
  /** Where the rows are, so the page can link to them. */
  where: string;
};

/**
 * Every kind, in the order they cost the most to leave alone.
 *
 * Each one is a fact the site already holds and already states somewhere in prose. Nothing here is
 * a new investigation; it is the same five things, counted.
 */
export const UNCLASSIFIED: UnclassifiedSpec[] = [
  {
    key: "provider-adjustments",
    what: "Money a payer kept back from a whole remittance",
    why: "PLB adjustments belong to no single claim — DIR, recoupments, transaction fees, interest — so neither account carries them. The receipt says so in words each time.",
    resolvedBy: "The fee dictionary: a PLB reason code and the contract's name for the same fee, so each lands under a heading (BACKLOG 2b-v).",
    where: "/remits",
  },
  {
    key: "claim-adjustments",
    what: "Adjustments on a claim that say why a payer paid less",
    why: "The CAS group and reason codes are read out of the 835 and then dropped. A contractual write-off and the patient's share are different money and both are currently the same absence.",
    resolvedBy: "The same dictionary, at claim level: the group code decides the heading, the reason code decides the wording.",
    where: "/remits",
  },
  {
    key: "payments-no-claim",
    what: "Payments that matched no prescription",
    why: "Money arrived for a fill this site does not hold, or for one whose only claim was reversed. It is recorded rather than lost, and it belongs to nothing.",
    resolvedBy: "A missing day of the transaction report, or — where the claim was reversed — the reversal rule, which tells a takeback from a payment.",
    where: "/remits",
  },
  {
    key: "invoice-no-lines",
    what: "Invoices with a total and no items under them",
    why: "The total is on the books and nothing says what was bought, so it reaches cost of goods without reaching the shelf, the rebate ladder or the buy list.",
    resolvedBy: "Re-read the document, or enter the lines. An invoice with a total and no lines and no flag is the one that reads as ordinary.",
    where: "/invoices",
  },
  {
    key: "unplaced-supplier",
    what: "Invoice lines whose supplier matched no supplier on file",
    why: "The spend is real and lands against nobody, so it earns no rebate and appears in no supplier's terms.",
    resolvedBy: "Add the spelling to that supplier's aliases. The names are already listed as `unplacedNames`.",
    where: "/suppliers",
  },
  {
    key: "remit-held",
    what: "Remittances held because they did not add up",
    why: "Deliberate, and the system working: the file said it paid one figure and its lines came to another, so nothing from it was stored. It is still money that has not reached the books.",
    resolvedBy: "Read the file again, or accept the difference by name. Held is the right state; held and forgotten is not.",
    where: "/remits",
  },
];

/**
 * What the store found for one kind.
 *
 * `cents` is null where the rows are known and their money is not — a real state, and not the same
 * as nought. `measuredAt` null means nobody has ever looked, which is the third state and the one a
 * total must never swallow.
 */
export type UnclassifiedCount = {
  key: string;
  rows: number;
  cents: number | null;
  measuredAt: string | null;
};

export type UnclassifiedState = "unmeasured" | "clear" | "held";

export type UnclassifiedRow = UnclassifiedSpec & {
  rows: number;
  cents: number | null;
  measuredAt: string | null;
  state: UnclassifiedState;
  /** One line, ready to render, that is true in every one of the three states. */
  says: string;
};

export const moneyText = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function stateOf(c: { rows: number; measuredAt: string | null }): UnclassifiedState {
  if (!c.measuredAt) return "unmeasured";
  return c.rows === 0 ? "clear" : "held";
}

/** One kind, with its count folded in and its sentence written. */
export function rowFor(spec: UnclassifiedSpec, count: UnclassifiedCount | undefined): UnclassifiedRow {
  const c = count ?? { key: spec.key, rows: 0, cents: null, measuredAt: null };
  const state = stateOf(c);
  const says =
    state === "unmeasured"
      ? `Never counted. ${spec.what} — nobody has looked, so this is not nought.`
      : state === "clear"
        ? `None. ${spec.what}: nothing is unplaced.`
        : c.cents === null
          ? `${plural(c.rows, "row")}, amount not known. ${spec.why}`
          : `${moneyText(c.cents)} across ${plural(c.rows, "row")}. ${spec.why}`;
  return { ...spec, rows: c.rows, cents: c.cents, measuredAt: c.measuredAt, state, says };
}

export type UnclassifiedTotal = {
  cents: number;
  rows: number;
  /**
   * True where some part of the figure was never counted, or is counted in rows but not in money.
   *
   * A floor is reported as "at least". The whole point of the module is that this cannot be
   * silently dropped: an incomplete total presented as a total is the failure it exists to remove.
   */
  floor: boolean;
  /** The keys that make it a floor, so the page can say which. */
  missing: string[];
  says: string;
};

export function totalOf(rows: UnclassifiedRow[]): UnclassifiedTotal {
  const cents = rows.reduce((n, r) => n + (r.state === "held" ? (r.cents ?? 0) : 0), 0);
  const count = rows.reduce((n, r) => n + (r.state === "held" ? r.rows : 0), 0);
  const missing = rows.filter((r) => r.state === "unmeasured" || (r.state === "held" && r.cents === null)).map((r) => r.key);
  const floor = missing.length > 0;

  const says = (() => {
    if (rows.every((r) => r.state === "unmeasured")) return "Nothing here has been counted yet, so there is no figure — which is not the same as nothing being unplaced.";
    if (count === 0 && !floor) return "Every dollar this site has seen is under a heading. Nothing is unplaced.";
    const head = floor
      ? `At least ${moneyText(cents)} across ${plural(count, "row")} is money this site has seen and cannot put under a heading`
      : `${moneyText(cents)} across ${plural(count, "row")} is money this site has seen and cannot put under a heading`;
    const tail = floor
      ? `, and ${plural(missing.length, "kind")} of it ${missing.length === 1 ? "has" : "have"} not been counted or has no amount — so the real figure is larger.`
      : ".";
    return head + tail;
  })();

  return { cents, rows: count, floor, missing, says };
}

/** The page's whole answer, from the store's counts. */
export function unclassified(counts: UnclassifiedCount[], specs: UnclassifiedSpec[] = UNCLASSIFIED): { rows: UnclassifiedRow[]; total: UnclassifiedTotal } {
  const by = new Map(counts.map((c) => [c.key, c]));
  const rows = specs.map((s) => rowFor(s, by.get(s.key)));
  return { rows, total: totalOf(rows) };
}
