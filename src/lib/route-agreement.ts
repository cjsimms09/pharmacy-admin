/**
 * The same question, asked two ways, must give the same answer.
 *
 * Every check this site already has compares it to something **outside** itself — a file, the till,
 * the bank, a stocktake, the payer's own total. `reconcile.ts` opens with the principle: *every
 * figure has a source, and the ones with two sources are checked against each other.* What none of
 * them does is compare two of the site's **own** answers to one question, and that is the shape of
 * every fault found on this branch in a week:
 *
 *   - a month's revenue on the books and the same month in the chart above it, differing by the
 *     fills carried in from the month before, because the two routes load through different windows;
 *   - the Inbox saying it holds a remittance whose payments the undo has deleted;
 *   - an 820 payment order refused by the router and called "a remittance, certain" by the
 *     recogniser.
 *
 * Four files, one fault, and each found by a person reading code. Nothing external disagreed in any
 * of them — the site disagreed with itself, quietly, and whichever page you happened to read was
 * the answer you got.
 *
 * ── Why this is worth a module rather than an assertion ──
 *
 * Because the interesting states are not two: they are four. Two routes that agree is the easy one.
 * Two that disagree is the finding. But **one route answering and the other declining** is not
 * agreement — it is a question that was only asked once, and reporting it as agreement is how a
 * check comes to certify something it never looked at. And **neither answering** is a question
 * nobody asked at all. Same discipline as `data-health.ts`'s: a measurement never taken is not a
 * measurement of zero.
 *
 * ── No tolerance ──
 *
 * These are two computations of one figure from one database at one moment. There is no rounding,
 * no timing difference and no third party: if they differ by a cent, one of them is wrong. A
 * tolerance here would only ever hide the smallest version of a real fault.
 *
 * Pure. The caller does the asking; this says whether the answers stand together.
 */

/** One way of answering. `null` for a figure this route does not claim to know. */
export type Route = { name: string; figures: Record<string, number | null> };

export type Watched = { key: string; what: string };

export type AgreementState = "agreed" | "disagreed" | "asked_once" | "unasked";

export type FigureAgreement = {
  key: string;
  what: string;
  state: AgreementState;
  /** Every route that gave a figure, with what it gave. */
  answers: { route: string; cents: number }[];
  /** The largest gap between any two answers. Zero where they agree. */
  spreadCents: number;
  says: string;
};

export type Agreement = {
  question: string;
  figures: FigureAgreement[];
  state: AgreementState;
  says: string;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const RANK: Record<AgreementState, number> = { disagreed: 3, asked_once: 2, unasked: 1, agreed: 0 };

/** Whether every route that answered gave the same figure, and what it means when they did not. */
export function agreementOf(question: string, routes: Route[], watched: Watched[]): Agreement {
  const figures = watched.map<FigureAgreement>((w) => {
    const answers = routes
      .map((r) => ({ route: r.name, cents: r.figures[w.key] }))
      .filter((a): a is { route: string; cents: number } => a.cents !== null && a.cents !== undefined);

    if (answers.length === 0) {
      return { key: w.key, what: w.what, state: "unasked", answers, spreadCents: 0, says: `${w.what}: no route answered, so nothing has been checked.` };
    }
    if (answers.length === 1) {
      return {
        key: w.key,
        what: w.what,
        state: "asked_once",
        answers,
        spreadCents: 0,
        says: `${w.what}: only ${answers[0].route} answered, so this figure stands unchecked. One answer is not agreement.`,
      };
    }

    const values = answers.map((a) => a.cents);
    const spreadCents = Math.max(...values) - Math.min(...values);
    if (spreadCents === 0) {
      return { key: w.key, what: w.what, state: "agreed", answers, spreadCents: 0, says: `${w.what}: ${answers.length} routes, one answer — ${money(values[0])}.` };
    }

    const low = answers.reduce((a, b) => (a.cents <= b.cents ? a : b));
    const high = answers.reduce((a, b) => (a.cents >= b.cents ? a : b));
    return {
      key: w.key,
      what: w.what,
      state: "disagreed",
      answers,
      spreadCents,
      says:
        `${w.what}: ${high.route} says ${money(high.cents)} and ${low.route} says ${money(low.cents)} — ` +
        `${money(spreadCents)} apart. One of them is wrong, and the page you happen to read decides which answer you get.`,
    };
  });

  const state = figures.reduce<AgreementState>((w, f) => (RANK[f.state] > RANK[w] ? f.state : w), "agreed");
  const bad = figures.filter((f) => f.state === "disagreed");
  const once = figures.filter((f) => f.state === "asked_once");

  const says =
    bad.length > 0
      ? `${question}: ${bad.length === 1 ? "one figure does" : `${bad.length} figures do`} not agree across routes. ${bad[0].says}`
      : figures.every((f) => f.state === "unasked")
        ? `${question}: nothing was asked, so nothing was checked.`
        : once.length > 0
          ? `${question}: every figure that two routes answered agrees, and ${once.length} ${once.length === 1 ? "figure was" : "figures were"} answered by only one route and stand${once.length === 1 ? "s" : ""} unchecked.`
          : `${question}: every figure agrees across every route that answered.`;

  return { question, figures, state, says };
}

/**
 * The books' figures, which is where the routes are already known to disagree.
 *
 * The books draw one month through a window of that month; the chart draws the same month inside a
 * window of n months. Both call the same code, so nothing about either looks wrong on its own.
 */
export const BOOKS_FIGURES: Watched[] = [
  { key: "revenueCents", what: "Revenue" },
  { key: "costOfGoodsCents", what: "Cost of goods" },
  { key: "grossProfitCents", what: "Gross profit" },
  { key: "netProfitCents", what: "The bottom line" },
  { key: "scripts", what: "Prescriptions" },
];

/** Every question at once, worst first. */
export function agreementOfAll(questions: Agreement[]): { rows: Agreement[]; state: AgreementState; says: string } {
  const state = questions.reduce<AgreementState>((w, q) => (RANK[q.state] > RANK[w] ? q.state : w), "agreed");
  const bad = questions.filter((q) => q.state === "disagreed");
  const says =
    bad.length > 0
      ? `${bad.length} question${bad.length === 1 ? "" : "s"} the site answers two ways ${bad.length === 1 ? "gives" : "give"} two answers: ${bad.map((q) => q.question).join(", ")}.`
      : questions.length === 0
        ? "No question has been asked two ways, so no route has been checked against another."
        : "Every question the site answers by more than one route gives one answer.";
  return { rows: [...questions].sort((a, b) => RANK[b.state] - RANK[a.state]), state, says };
}
