import type { RawLine, RawStatement } from "./scanned-bank-statement";

/**
 * The scanned statement's figures, solved against each other. See `scanned-bank-statement.ts` for why.
 *
 * Each figure the scan printed is turned into every value it could plausibly be — "t4,642.54" is
 * 14,642.54; "22s.22" is 225.22 or 228.22; "937,00" is 937.00 — and each line's date into the days the
 * statement has a balance for. Then the lines are walked day by day from the opening balance, and a
 * reading survives only where it arrives at the balance the statement prints for that day. A day whose
 * printed balance is itself misread is carried forward and settled by the next.
 *
 * Accepted only when exactly one reading survives to the closing balance. Every line the solver had to
 * choose for is named in the result, so a person can see what was decided and from what.
 *
 * Pure.
 */

export type SolvedLine = {
  on: string;
  /** Positive in, negative out. */
  amountCents: number;
  description: string;
  section: RawLine["section"];
  page: number;
  /** Set where the scan's characters admitted more than one value and the balances decided it. */
  decidedFrom: string | null;
};

export type SolvedStatement =
  | {
      ok: true;
      periodFrom: string;
      periodTo: string;
      openingCents: number;
      closingCents: number;
      lines: SolvedLine[];
      creditsCents: number;
      debitsCents: number;
      /**
       * Days the scan alone could not prove: the lines do not reach the bank's balance and no single correction explains it.
       * Empty means every line is proved. Anything here goes to a person before a line of the statement is used.
       */
      unproven: Unproven[];
      /** Where the summary's own printed figures disagree with the lines, which the balances outrank. */
      notes: string[];
    }
  | { ok: false; why: string; unresolved: { page: number; section: string; dateText: string; amountText: string; options: string[] }[] };

export type Unproven = {
  from: string;
  to: string;
  /** What the balances say the lines must come to, less what the scan reads them as. */
  differenceCents: number;
  /** The lines no other document already confirms. */
  lines: { index: number; page: number; section: string; dateText: string; amountText: string; readAsCents: number }[];
};

const CAP = 48;

/* What each character the scan printed could have been, in a figure. Unknown letters are handled separately. */
const DIGITISH: Record<string, string[]> = {
  l: ["1"], L: ["1"], I: ["1"], i: ["1"], t: ["1", "7"], r: ["1"], T: ["1"], J: ["1"], "]": ["1"], "[": ["1"], "|": ["1"], "!": ["1"], "\\": ["1"],
  O: ["0"], o: ["0"], D: ["0"], Q: ["0"], C: ["0"], U: ["0"], "@": ["0"],
  s: ["5", "8"], S: ["5", "8"], $: ["5", "8"],
  B: ["8"], z: ["2"], Z: ["2"], q: ["9", "4"], g: ["9"], A: ["4"], G: ["6"], b: ["6"], e: ["6", "8", "9"],
};
const SEPARATORS = new Set([",", ".", '"', ";", ":", "'"]);

/** Every value a printed amount could be, in cents, cheapest reading first. Empty where nothing fits a money shape. */
export function amountOptions(printed: string): number[] {
  const text = printed.replace(/\s+/g, "").replace(/\*+$/, "");
  if (!text) return [];
  let partial: { s: string; cost: number }[] = [{ s: "", cost: 0 }];
  for (const ch of text) {
    let opts: { add: string; cost: number }[];
    if (/\d/.test(ch)) opts = [{ add: ch, cost: 0 }];
    else if (SEPARATORS.has(ch)) opts = [{ add: ".", cost: ch === "." ? 0 : 1 }, { add: ",", cost: ch === "," ? 0 : 1 }, { add: "", cost: 3 }];
    else if (ch === "+") opts = [{ add: "", cost: 2 }, { add: "4", cost: 2 }];
    else if (DIGITISH[ch]) opts = DIGITISH[ch].map((d, i) => ({ add: d, cost: 1 + i }));
    else opts = [{ add: "", cost: 2 }, ..."0123456789".split("").map((d) => ({ add: d, cost: 4 })), ..."0123456789".split("").flatMap((d) => "0123456789".split("").map((e) => ({ add: d + e, cost: 7 })))];
    const next: { s: string; cost: number }[] = [];
    for (const p of partial) for (const o of opts) next.push({ s: p.s + o.add, cost: p.cost + o.cost });
    next.sort((a, b) => a.cost - b.cost);
    partial = next.slice(0, 400);
  }
  const values = new Map<number, number>();
  for (const p of partial) {
    if (!/^\d{1,3}(,\d{3})*\.\d{2}$/.test(p.s) && !/^\d{1,4}\.\d{2}$/.test(p.s)) continue;
    const cents = Math.round(Number(p.s.replace(/,/g, "")) * 100);
    if (!values.has(cents) || values.get(cents)! > p.cost) values.set(cents, p.cost);
  }
  return [...values.entries()].sort((a, b) => a[1] - b[1]).slice(0, CAP).map(([c]) => c);
}

/* A day-of-month's two characters, loosely: dates are also settled by order and by the days that have balances. */
const DAYISH: Record<string, string[]> = {
  l: ["1"], L: ["1"], I: ["1"], i: ["1"], t: ["1", "4"], r: ["1", "2", "3"], T: ["1"], J: ["1"], "]": ["1"], "|": ["1"], "!": ["1"],
  O: ["0"], o: ["0"], D: ["0"], Q: ["0"], C: ["0"], U: ["0"], a: ["0", "4", "8"], "@": ["0"], p: ["0", "5"],
  s: ["5", "8"], S: ["5", "8"], B: ["8"], z: ["2"], Z: ["2"], q: ["0", "9"], g: ["9"], A: ["4"], e: ["6", "8", "9"], "+": ["4"], ":": ["3"],
};

/** Days of the month a printed date could be. Null where nothing can be read from it. */
export function dayOptions(printed: string): number[] | null {
  const t = printed.replace(/\s+/g, "").replace(/[.,]+$/, "");
  if (t.length < 2) return null;
  const tail = t.slice(-2);
  const opts = tail.split("").map((ch) => (/\d/.test(ch) ? [ch] : DAYISH[ch] ?? null));
  if (opts.some((o) => o === null)) return null;
  const days = new Set<number>();
  for (const a of opts[0]!) for (const b of opts[1]!) {
    const d = Number(a + b);
    if (d >= 1 && d <= 31) days.add(d);
  }
  return days.size ? [...days].sort((x, y) => x - y) : null;
}

/** The month and year the statement covers, from its "Date:" in the header ("08/3U26"). */
function periodOf(raw: RawStatement): { year: number; month: number } | null {
  const t = raw.summary.statementDateText ?? "";
  const m = /^(\d{2})\D/.exec(t.replace(/^[oO]/, "0"));
  const y = /(\d{2})$/.exec(t);
  if (!m || !y) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { year: 2000 + Number(y[1]), month };
}

export function solveStatement(
  raw: RawStatement,
  options: {
    /**
     * Amounts other feeds have already recorded around this month — card deposits from the processor's statement, payer
     * payments, bills. Where the balances say a line was misread and more than one correction fits, the one that turns
     * the line into money another document already shows is taken; a line that already equals such an amount is left alone.
     */
    known?: number[];
    trace?: (message: string) => void;
  } = {},
): SolvedStatement {
  const trace = options.trace ?? (() => {});
  const known = new Set(options.known ?? []);
  const fail = (why: string, unresolved: Extract<SolvedStatement, { ok: false }>["unresolved"] = []): SolvedStatement => ({ ok: false, why, unresolved });
  const period = periodOf(raw);
  if (!period) return fail("The statement's date could not be read from its header.");
  const iso = (day: number) => `${period.year}-${String(period.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();

  /* ── The days with a balance, in the order the table prints them: down each column. ── */
  const table = [...raw.balances].sort((a, b) => a.page - b.page || a.column - b.column);
  /*
   * Strictly increasing days, agreeing with as many printed dates as possible. A date the scan garbled past
   * reading ("8pa") takes the only day its neighbours leave; where they leave more than one, it is refused.
   */
  const readDays = table.map((b) => new Set(dayOptions(b.dateText) ?? []));
  const n = table.length;
  /* best[i][d]: most agreements for rows i.. given row i is day d. */
  const best: number[][] = Array.from({ length: n + 1 }, () => Array(lastDay + 2).fill(-Infinity));
  for (let d = 0; d <= lastDay + 1; d++) best[n][d] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let d = lastDay; d >= 1; d--) {
      let tail = -Infinity;
      for (let e = d + 1; e <= lastDay + 1; e++) tail = Math.max(tail, i + 1 === n ? 0 : e <= lastDay ? best[i + 1][e] : -Infinity);
      best[i][d] = (readDays[i].has(d) ? 1 : 0) + tail;
    }
  }
  const balanceDays: number[] = [];
  {
    let floor = 0;
    for (let i = 0; i < n; i++) {
      let top = -Infinity;
      for (let d = floor + 1; d <= lastDay; d++) top = Math.max(top, best[i][d]);
      const ties = [];
      for (let d = floor + 1; d <= lastDay; d++) if (best[i][d] === top) ties.push(d);
      const agreeing = ties.filter((d) => readDays[i].has(d));
      const pick = agreeing.length === 1 ? agreeing[0] : ties.length === 1 ? ties[0] : null;
      if (pick === null || top === -Infinity) return fail(`The daily balance table's date "${table[i].dateText}" could not be told apart from its neighbours.`);
      balanceDays.push(pick);
      floor = pick;
    }
  }
  const balanceOptions = table.map((b) => new Set(amountOptions(b.balanceText)));
  const dayIndex = new Map(balanceDays.map((d, i) => [d, i]));

  /* ── Each line's possible days: what its characters allow, among days with a balance, kept in order within a section. ── */
  const lines = raw.lines.filter((l) => l.amountText);
  const dayChoices: number[][] = lines.map((l) => {
    const read = dayOptions(l.dateText);
    const allowed = read ? read.filter((d) => dayIndex.has(d)) : [];
    return allowed.length ? allowed : [...balanceDays];
  });
  /*
   * Within a section the lines run in date order. Each line may take any day with a balance; the days chosen
   * never go backwards; and the choice agrees with as many printed dates as it can. A line keeps every day
   * that some best-agreeing order gives it — one garbled date cannot drag its neighbours along with it.
   */
  const m = balanceDays.length;
  for (const section of ["credits", "debits", "card"] as const) {
    const idx = lines.map((l, i) => (l.section === section ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) continue;
    const agrees = idx.map((i) => {
      const read = new Set(dayOptions(lines[i].dateText) ?? []);
      return balanceDays.map((d) => (read.has(d) ? 1 : 0));
    });
    const fwd = idx.map(() => Array(m).fill(0));
    for (let a = 0; a < idx.length; a++) {
      let run = -Infinity;
      for (let k = 0; k < m; k++) {
        run = Math.max(run, a === 0 ? 0 : fwd[a - 1][k]);
        fwd[a][k] = run + agrees[a][k];
      }
    }
    const bwd = idx.map(() => Array(m).fill(0));
    for (let a = idx.length - 1; a >= 0; a--) {
      let run = -Infinity;
      for (let k = m - 1; k >= 0; k--) {
        run = Math.max(run, a === idx.length - 1 ? 0 : bwd[a + 1][k]);
        bwd[a][k] = run + agrees[a][k];
      }
    }
    const top = Math.max(...fwd[idx.length - 1]);
    idx.forEach((i, a) => {
      dayChoices[i] = balanceDays.filter((_, k) => fwd[a][k] + bwd[a][k] - agrees[a][k] === top);
    });
  }
  const amountChoices = lines.map((l) => amountOptions(l.amountText));
  const unreadable = lines.map((l, i) => ({ l, i })).filter(({ i }) => amountChoices[i].length === 0 || dayChoices[i].length === 0);
  if (unreadable.length) {
    return fail(
      `${unreadable.length} line${unreadable.length === 1 ? "" : "s"} on the scan could not be read as a date and an amount at all.`,
      unreadable.map(({ l, i }) => ({ page: l.page, section: l.section, dateText: l.dateText, amountText: l.amountText, options: amountChoices[i].map((c) => (c / 100).toFixed(2)) })),
    );
  }



  /*
   * ── Each day proved by the two balances either side of it ──
   *
   * The balance printed before a day and the balance printed after it say what that day's lines must come
   * to, so a day is checked on its own and one misread line cannot put every later day out. The lines are
   * taken as the scan reads them first; then, cheapest first, another reading its characters allow, two such
   * readings, one digit read as another, and a digit with a reading. The first level at which exactly one
   * correction fits is taken.
   *
   * A printed balance can be the misread figure itself. Then neither day beside it fits, or fits only by
   * inventing a digit; the two days are proved together by the balances either side of both, which never
   * reads the doubtful one. The same joining settles a line printed under the wrong day.
   */
  const opening = amountOptions(raw.summary.beginningText ?? "");
  if (opening.length === 0) return fail("The opening balance could not be read.");
  const printed = table.map((b) => amountOptions(b.balanceText));
  const sign = (i: number) => (lines[i].credit ? 1 : -1);
  const agreesDay = (i: number, d: number) => (dayOptions(lines[i].dateText) ?? []).includes(d);
  const assign = lines.map((_, i) => ({
    day: dayChoices[i].find((d) => agreesDay(i, d)) ?? dayChoices[i][0],
    cents: amountChoices[i][0],
    how: null as string | null,
  }));
  const m2 = balanceDays.length;
  const kOf = new Map(balanceDays.map((d, k) => [d, k]));
  const digitSwaps = (cents: number): number[] => {
    const s = String(cents);
    const out: number[] = [];
    for (let p = 0; p < s.length; p++) for (const d of "0123456789") {
      if (d === s[p] || (p === 0 && d === "0" && s.length > 1)) continue;
      out.push(Number(s.slice(0, p) + d + s.slice(p + 1)));
    }
    return out;
  };
  type Change = { i: number; cents: number; how: "reading" | "digit" | "day"; day?: number };
  type Fit = { tier: number; changes: Change[]; closing: number };

  /* The cheapest unique correction making days a..b agree with a balance before and after; null if none, or if it is not unique. */
  const solveBlock = (a: number, b: number, before: number[]): Fit | null | "ambiguous" => {
    const after = printed[b];
    if (after.length === 0 || before.length === 0) return null;
    const idx = lines.map((_, i) => i).filter((i) => {
      const k = kOf.get(assign[i].day)!;
      return k >= a && k <= b;
    });
    const base = idx.reduce((n, i) => n + sign(i) * assign[i].cents, 0);
    const targets = new Map<number, number>();
    for (const p of before) for (const q of after) if (!targets.has(q - p)) targets.set(q - p, q);
    /* A line already equal to money another document shows is not reconsidered. */
    const open = idx.filter((i) => !known.has(assign[i].cents));
    const readings: Change[] = [
      ...open.flatMap((i) => amountChoices[i].filter((c) => c !== assign[i].cents).map((c) => ({ i, cents: c, how: "reading" as const }))),
      ...open.flatMap((i) => digitSwaps(assign[i].cents).filter((c) => known.has(c) && !amountChoices[i].includes(c)).map((c) => ({ i, cents: c, how: "digit" as const }))),
      /*
       * A line printed under the wrong day: out of this block to a later day its date could be, or into it from one.
       * Never to or from a day already proved.
       */
      ...lines.flatMap((_, i) => {
        const here = kOf.get(assign[i].day)!;
        if (here < a) return [];
        return dayChoices[i]
          .filter((d) => d !== assign[i].day && kOf.get(d)! >= a && (here <= b) !== (kOf.get(d)! <= b))
          .map((d) => ({ i, cents: assign[i].cents, how: "day" as const, day: d }));
      }),
    ];
    const digits: Change[] = open.flatMap((i) => digitSwaps(assign[i].cents).filter((c) => !known.has(c)).map((c) => ({ i, cents: c, how: "digit" as const })));
    const inBlock = (d: number) => { const k = kOf.get(d)!; return k >= a && k <= b; };
    const delta = (ch: Change) => {
      const was = inBlock(assign[ch.i].day) ? sign(ch.i) * assign[ch.i].cents : 0;
      const now = inBlock(ch.day ?? assign[ch.i].day) ? sign(ch.i) * ch.cents : 0;
      return now - was;
    };
    const tiers: Change[][][] = [
      [[]],
      readings.map((r) => [r]),
      readings.flatMap((r, x) => readings.slice(x + 1).filter((s) => s.i !== r.i).map((s) => [r, s])),
      digits.map((d) => [d]),
      digits.flatMap((d) => readings.filter((r) => r.i !== d.i).map((r) => [d, r])),
    ];
    for (let t = 0; t < tiers.length; t++) {
      const fits = tiers[t].filter((set) => targets.has(base + set.reduce((n, ch) => n + delta(ch), 0)));
      if (fits.length === 0) continue;
      const distinct = new Map<string, Change[]>();
      for (const set of fits) distinct.set(set.map((c) => `${c.i}:${c.cents}`).sort().join(","), set);
      if (distinct.size > 1) return "ambiguous";
      const set = [...distinct.values()][0];
      return { tier: t, changes: set, closing: targets.get(base + set.reduce((n, ch) => n + delta(ch), 0))! };
    }
    return null;
  };

  const notes: string[] = [];
  const unproven: Unproven[] = [];
  const closingOf: number[] = [];
  let before = opening;
  let a = 0;
  while (a < m2) {
    let b = a;
    let taken: Fit | null = null;
    for (;;) {
      const alone = solveBlock(a, b, before);
      const joined = b + 1 < m2 ? solveBlock(a, b + 1, before) : null;
      const good = (f: Fit | null | "ambiguous"): f is Fit => f !== null && f !== "ambiguous";
      if (good(alone) && (alone.tier <= 2 || !good(joined) || joined.tier >= alone.tier)) {
        taken = alone;
        break;
      }
      if (b + 1 >= m2 || b - a >= 6) {
        /*
         * Not provable from the scan alone. The block runs to the first balance the scan printed cleanly, which
         * the next block starts from, and its lines go to a person with the difference they have to explain.
         */
        let end = a;
        while (end < m2 - 1 && !/^\d{1,3}(,\d{3})*\.\d{2}$/.test(table[end].balanceText)) end++;
        const idx = lines.map((_, i) => i).filter((i) => {
          const k = kOf.get(assign[i].day)!;
          return k >= a && k <= end;
        });
        const target = printed[end][0];
        const made = before[0] + idx.reduce((n, i) => n + sign(i) * assign[i].cents, 0);
        unproven.push({
          from: iso(balanceDays[a]),
          to: iso(balanceDays[end]),
          differenceCents: target - made,
          lines: idx.filter((i) => !known.has(assign[i].cents)).map((i) => ({ index: i, page: lines[i].page, section: lines[i].section, dateText: lines[i].dateText, amountText: lines[i].amountText, readAsCents: sign(i) * assign[i].cents })),
        });
        trace(`${iso(balanceDays[a])}..${iso(balanceDays[end])} NOT PROVED: lines make ${(made / 100).toFixed(2)}, balance ${(target / 100).toFixed(2)}`);
        before = [target];
        a = end + 1;
        taken = null;
        break;
      }
      b++;
    }
    if (!taken) continue;
    if (b > a) notes.push(`The balance printed for ${iso(balanceDays[b - 1])} ("${table[b - 1].balanceText}") could not be relied on; ${iso(balanceDays[a])} to ${iso(balanceDays[b])} were proved together.`);
    trace(`${iso(balanceDays[a])}..${iso(balanceDays[b])} tier ${taken!.tier} ${taken!.changes.map((c) => `"${lines[c.i].amountText}" -> ${(c.cents / 100).toFixed(2)} (${c.how})`).join("; ")}`);
    for (const ch of taken!.changes) assign[ch.i] = { day: ch.day ?? assign[ch.i].day, cents: ch.cents, how: ch.how === "day" ? assign[ch.i].how : ch.how };
    for (let k = a; k <= b; k++) closingOf[k] = k === b ? taken!.closing : NaN;
    before = [taken!.closing];
    a = b + 1;
  }

  const closingCents = before[0];
  const unexplained = unproven.reduce((n, u) => n + u.differenceCents, 0);
  const openingCents = closingCents - unexplained - lines.reduce((n, _, i) => n + sign(i) * assign[i].cents, 0);
  const closingOptions = amountOptions((raw.summary.endingText ?? "").replace(/\*/g, ""));
  if (closingOptions.length && !closingOptions.includes(closingCents)) {
    return fail(`The lines reach ${(closingCents / 100).toFixed(2)}, and the statement's closing balance reads "${raw.summary.endingText}".`);
  }
  if (!opening.includes(openingCents)) {
    return fail(`The lines start from ${(openingCents / 100).toFixed(2)}, and the statement's opening balance reads "${raw.summary.beginningText}".`);
  }
  const solved: SolvedLine[] = lines.map((l, i) => {
    const p = assign[i];
    const clean = /^\d{1,3}(,\d{3})*\.\d{2}$/.test(l.amountText) && agreesDay(i, p.day) && dayChoices[i].length === 1;
    const said = `"${l.dateText} ${l.amountText}"`;
    return {
      on: iso(p.day),
      amountCents: sign(i) * p.cents,
      description: l.description.replace(/\s+/g, " ").trim(),
      section: l.section,
      page: l.page,
      decidedFrom: p.how === "digit" ? `the scan printed ${said}; the balances either side show a digit was misread` : clean && !p.how ? null : `the scan printed ${said}`,
    };
  });
  const creditsCents = solved.filter((s) => s.amountCents > 0).reduce((n, s) => n + s.amountCents, 0);
  const debitsCents = -solved.filter((s) => s.amountCents < 0).reduce((n, s) => n + s.amountCents, 0);
  const summaryCheck = (label: string, text: string | null, actual: number, count: string | null, n: number) => {
    if (text && !amountOptions(text).includes(actual)) notes.push(`The summary prints ${label} as "${text}"; the lines, which the daily balances prove, come to ${(actual / 100).toFixed(2)}.`);
    if (count && Number(count.replace(/\D/g, "")) !== n) notes.push(`The summary counts ${count} ${label}; ${n} were read.`);
  };
  summaryCheck("deposits", raw.summary.creditsText, creditsCents, raw.summary.creditsCountText, solved.filter((s) => s.amountCents > 0).length);
  summaryCheck("withdrawals", raw.summary.debitsText, debitsCents, raw.summary.debitsCountText, solved.filter((s) => s.amountCents < 0).length);

  return { ok: true, periodFrom: iso(1), periodTo: iso(lastDay), openingCents, closingCents, lines: solved, creditsCents, debitsCents, unproven, notes };
}
