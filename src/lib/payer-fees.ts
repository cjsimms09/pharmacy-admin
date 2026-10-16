/**
 * What the payers took off the remittances, counted once.
 *
 * Three records can carry the same fee, and every one of them is true: the Health Mart Atlas payment report (its "Adj-"
 * rows, booked as expenses keyed on the EFT), the 835's provider-level segments (remittance_holdbacks) and the
 * reconciliation service's adjustment report. Adding what each says is the natural thing for a program to do, and
 * September 2026's net revenue was $145.89 too low for it: seven EFTs' fees were taken once from the payment reports and
 * again from the adjustment report, to the cent.
 *
 * One remittance is counted from ONE record: the payment report first, because it closes to the EFT's total; then the
 * 835; then the adjustment report, which stands in for a remittance whose 835 was read before its provider-level segments
 * were kept. A fee a better record already counted is kept out and said so (`keptOut`), and where the two records give
 * different totals for the same remittance that is said too (`disagree`), because deduplicating by remittance number
 * would otherwise hide a real difference.
 *
 * Not every line is a fee. An origination fee (AH) and a CS that takes money are; a balance forward is a negative balance
 * carried to a later remittance, so the claims on that remittance and the line add to nothing; every other code is held,
 * on neither account, until somebody who knows what it is says. The same rule applies to whichever record carries the
 * line, so a fee never changes when a better record of it arrives (accesshealth-payment.ts books the payment report by it).
 *
 * The rule can be wrong about a line, and a person can know better. A line he counts or leaves out stays that way across
 * every import: a decision is keyed on the remittance, the code and the amount, never on which record carried the line,
 * so a better record arriving does not put it back in front of him. It is listed beside what the rule would have done so
 * it can be undone, and where it moves the account's figure the month says so.
 *
 * Pure: the records and the decisions are read in payer-fees-store.ts.
 */

export type FeeLine = {
  /** What the record calls the remittance: an EFT number, a trace number, a check number. */
  remittance: string;
  /** The month the payer took it: the remittance's own date. */
  month: string;
  code: string;
  /** The payer's own reference for the line. A balance forward says so here. */
  reference: string;
  /** Positive where the payer took money; negative where the line gave some back. */
  takenCents: number;
  payer: string;
};

const BALANCE_FORWARD = /balance\s*forward|forwarding\s*balance/i;

/** `byRule`: the rule is certain this is not a fee, so nobody has anything to decide. Otherwise it is waiting for a person. */
export type FeeKind = { fee: true } | { fee: false; why: string; byRule: boolean };

export function classifyFee(line: { code: string; reference?: string | null; takenCents: number }): FeeKind {
  const code = line.code.trim().toUpperCase();
  if (BALANCE_FORWARD.test(line.reference ?? "") || code === "FB") {
    return { fee: false, byRule: true, why: "a balance carried to a later remittance, which moves no money by itself: not a fee and not revenue" };
  }
  if (code === "AH") return { fee: true };
  if (code === "CS") {
    return line.takenCents > 0 ? { fee: true } : { fee: false, byRule: false, why: "a credit from the payer rather than a recoupment, and what it reverses is not on the report" };
  }
  return { fee: false, byRule: false, why: `a "${code}" line, whose meaning is not settled` };
}

export const isSettledPayerFee = (code: string, takenCents: number, reference?: string | null): boolean => classifyFee({ code, reference, takenCents }).fee;

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^EFT/, "");

/** The same remittance, however two records spell it: "EFT-9000001", "9000001" and a trace that carries it all agree. */
export function sameRemittance(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

const PAYMENT_REPORT = "the Health Mart Atlas payment report";
const ON_835 = "the 835";
const ON_REPORT = "the adjustment report";

export type FeeDecisionKind = "count" | "leave_out";

/** The audit actions a decision is written under. The latest on a line stands; "reopen" puts the line back to the rule. */
export const FEE_DECISION_ACTIONS = { count: "payer_fee.counted", leave_out: "payer_fee.left_out", reopen: "payer_fee.reopened" } as const;

/**
 * What a person said about one line, as the store reads it back: the latest word under each key, with who said it and when.
 * "reopen" is a word too. It is how a later press undoes an earlier one, so it has to be seen in order to beat it.
 */
export type FeeDecision = { key: string; decision: FeeDecisionKind | "reopen"; by: string; on: string };

/** A decision as it sits on a line, with what the rule alone would have done, so that it is said when it moves a figure. */
export type Decided = { decision: FeeDecisionKind; by: string; on: string; ruleCounted: boolean };

/** A line with no remittance number is told apart by its month, so two such lines of different months are not decided as one. */
const keyedRemittance = (l: { remittance: string; month: string }) => l.remittance.replace(/[|\s]+/g, " ").trim() || `no remittance number, ${l.month}`;

/**
 * What a decision is keyed on: the remittance, the code and the amount. Not the reference, which a better record of the
 * same line may spell differently; a decision that lapsed when one arrived would put the line back in front of him. Two
 * lines of one remittance with the same code and amount are therefore decided together.
 */
export const feeKey = (l: { remittance: string; month: string; code: string; takenCents: number }): string => `${keyedRemittance(l)}|${l.code.trim().toUpperCase()}|${l.takenCents}`;

export function readFeeKey(key: string): { remittance: string; code: string; takenCents: number } | null {
  const m = /^([^|]+)\|([^|]+)\|(-?\d+)$/.exec(key);
  return m ? { remittance: m[1], code: m[2], takenCents: Number(m[3]) } : null;
}

export type PayerFees = {
  /** Fees to add to the account: lines of an 835 or an adjustment report that no better record counted, and any a person counted. */
  counted: (FeeLine & { from: string; decided?: Decided })[];
  /** Fee lines a better record had already counted, with which record that was and which record they came from. */
  keptOut: (FeeLine & { alreadyIn: string; from: string })[];
  /** Lines the rule cannot place (a credit, a code nobody has explained), on neither account, waiting for a person to say. */
  held: (FeeLine & { from: string; why: string })[];
  /** Lines the rule is certain are not fees (a balance forward), on neither account, with nothing for anybody to decide. */
  notFees: (FeeLine & { from: string; why: string })[];
  /** Lines a person left out, whatever the rule would have done with them. */
  leftOut: (FeeLine & { from: string; decided: Decided; ruleSaid: string })[];
  /** Remittances two records both carry whose fee totals differ. The better record stands; the difference is said. */
  disagree: { remittance: string; month: string; believedFrom: string; believedCents: number; otherFrom: string; otherCents: number }[];
};

export function countPayerFees(i: {
  /** Remittances whose Health Mart Atlas payment report is read, with the fees booked from it (positive). */
  paymentReports: { remittance: string; feeCents: number }[];
  from835: FeeLine[];
  fromAdjustmentReport: FeeLine[];
  /** What a person has said about particular lines. Absent, the rule alone decides. */
  decisions?: FeeDecision[];
}): PayerFees {
  const covered = (r: string) => i.paymentReports.some((k) => sameRemittance(k.remittance, r));
  const on835 = (r: string) => i.from835.some((l) => sameRemittance(l.remittance, r));
  const out: PayerFees = { counted: [], keptOut: [], held: [], notFees: [], leftOut: [], disagree: [] };
  /* A line can have been decided under more than one spelling of its remittance, as better records arrived: the latest word wins. */
  const decisionFor = (l: FeeLine): (FeeDecision & { decision: FeeDecisionKind }) | null => {
    const mine = (i.decisions ?? []).filter((d) => {
      const k = readFeeKey(d.key);
      return !!k && k.code === l.code.trim().toUpperCase() && k.takenCents === l.takenCents && sameRemittance(k.remittance, keyedRemittance(l));
    });
    const latest = mine.reduce<FeeDecision | null>((a, d) => (!a || d.on >= a.on ? d : a), null);
    return latest && latest.decision !== "reopen" ? { ...latest, decision: latest.decision } : null;
  };
  const take = (l: FeeLine, from: string, alreadyIn: string | null) => {
    const k = classifyFee(l);
    if (alreadyIn) {
      if (k.fee) out.keptOut.push({ ...l, alreadyIn, from });
      return;
    }
    const d = decisionFor(l);
    const decided: Decided | undefined = d ? { decision: d.decision, by: d.by, on: d.on, ruleCounted: k.fee } : undefined;
    if (decided?.decision === "leave_out") out.leftOut.push({ ...l, from, decided, ruleSaid: k.fee ? "a fee, which the rule counts" : k.why });
    else if (decided?.decision === "count" || k.fee) out.counted.push({ ...l, from, ...(decided ? { decided } : {}) });
    else (k.byRule ? out.notFees : out.held).push({ ...l, from, why: k.why });
  };
  for (const l of i.from835) take(l, ON_835, covered(l.remittance) ? PAYMENT_REPORT : null);
  for (const l of i.fromAdjustmentReport) take(l, ON_REPORT, covered(l.remittance) ? PAYMENT_REPORT : on835(l.remittance) ? ON_835 : null);

  const total = (ls: { takenCents: number }[]) => ls.reduce((n, l) => n + l.takenCents, 0);
  const believed = (alreadyIn: string, r: string) =>
    alreadyIn === PAYMENT_REPORT
      ? i.paymentReports.filter((p) => sameRemittance(p.remittance, r)).reduce((n, p) => n + p.feeCents, 0)
      : total(i.from835.filter((l) => sameRemittance(l.remittance, r) && classifyFee(l).fee));
  const groups = new Map<string, { line: FeeLine; alreadyIn: string; from: string; cents: number }>();
  for (const l of out.keptOut) {
    const key = `${norm(l.remittance)}|${l.from}`;
    const g = groups.get(key) ?? { line: l, alreadyIn: l.alreadyIn, from: l.from, cents: 0 };
    g.cents += l.takenCents;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const b = believed(g.alreadyIn, g.line.remittance);
    if (b !== g.cents) out.disagree.push({ remittance: g.line.remittance, month: g.line.month, believedFrom: g.alreadyIn, believedCents: b, otherFrom: g.from, otherCents: g.cents });
  }
  return out;
}

export type MonthFees = {
  countedCents: number;
  countedLines: number;
  keptOutCents: number;
  keptOutLines: number;
  /** Lines waiting for a person to say what they are. */
  heldCents: number;
  heldLines: number;
  /** The held lines in words, for the month's account. Empty where none. */
  heldSays: string;
  /** Lines the rule is certain are not fees: nothing to decide, and nothing on the account. */
  notFeesCents: number;
  notFeesLines: number;
  /** Those lines in words, for the month's account. Empty where none. */
  notFeesSays: string;
  /** Lines a person left out. */
  leftOutCents: number;
  leftOutLines: number;
  /** Where a decision moved the account's figure from what the rule alone gives, in words. Empty where none did. */
  decidedSays: string;
  /** The remittances on which two records differ, in words. Empty where every one agrees. */
  differ: string;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** One line in words: which payer, which code, how much, which way, on which remittance. */
export function lineSays(l: FeeLine): string {
  const way = l.takenCents < 0 ? "added to the remittance" : "taken from the remittance";
  return `${l.payer || "A payer"} ${l.code}${l.reference ? ` "${l.reference}"` : ""} ${money(l.takenCents)} ${way}${l.remittance ? `, on ${l.remittance}` : ""}`;
}
const several = (lines: string[]) => (lines.length > 3 ? `${lines.slice(0, 3).join("; ")}; and ${lines.length - 3} more` : lines.join("; "));

export function feesByMonth(r: PayerFees): Map<string, MonthFees> {
  const out = new Map<string, MonthFees>();
  const of = (m: string) => {
    let e = out.get(m);
    if (!e) out.set(m, (e = { countedCents: 0, countedLines: 0, keptOutCents: 0, keptOutLines: 0, heldCents: 0, heldLines: 0, heldSays: "", notFeesCents: 0, notFeesLines: 0, notFeesSays: "", leftOutCents: 0, leftOutLines: 0, decidedSays: "", differ: "" }));
    return e;
  };
  for (const l of r.counted) {
    const e = of(l.month);
    e.countedCents += l.takenCents;
    e.countedLines++;
  }
  for (const l of r.keptOut) {
    const e = of(l.month);
    e.keptOutCents += l.takenCents;
    e.keptOutLines++;
  }
  const heldBy = new Map<string, string[]>();
  for (const l of r.held) {
    const e = of(l.month);
    e.heldCents += l.takenCents;
    e.heldLines++;
    heldBy.set(l.month, [...(heldBy.get(l.month) ?? []), `${lineSays(l)}: ${l.why}`]);
  }
  for (const [m, lines] of heldBy) of(m).heldSays = several(lines);
  const notBy = new Map<string, string[]>();
  const moved = new Map<string, { counted: number; countedCents: number; leftOut: number; leftOutCents: number }>();
  const movedIn = (m: string) => moved.get(m) ?? moved.set(m, { counted: 0, countedCents: 0, leftOut: 0, leftOutCents: 0 }).get(m)!;
  for (const l of r.notFees) {
    const e = of(l.month);
    e.notFeesCents += l.takenCents;
    e.notFeesLines++;
    notBy.set(l.month, [...(notBy.get(l.month) ?? []), `${lineSays(l)}: ${l.why}`]);
  }
  for (const [m, lines] of notBy) of(m).notFeesSays = several(lines);
  for (const l of r.leftOut) {
    const e = of(l.month);
    e.leftOutCents += l.takenCents;
    e.leftOutLines++;
    if (l.decided.ruleCounted) {
      const x = movedIn(l.month);
      x.leftOut++;
      x.leftOutCents += l.takenCents;
    }
  }
  for (const l of r.counted) {
    if (l.decided && !l.decided.ruleCounted) {
      const x = movedIn(l.month);
      x.counted++;
      x.countedCents += l.takenCents;
    }
  }
  const nLines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const signed = (c: number) => (c < 0 ? "-" : "") + money(c);
  for (const [m, x] of moved) {
    of(m).decidedSays = [
      x.counted ? `${nLines(x.counted)} counted that the rule would not have (${signed(x.countedCents)})` : "",
      x.leftOut ? `${nLines(x.leftOut)} the rule would have counted left out (${signed(x.leftOutCents)})` : "",
    ]
      .filter(Boolean)
      .join(" and ");
  }
  const differBy = new Map<string, string[]>();
  for (const d of r.disagree) {
    differBy.set(d.month, [...(differBy.get(d.month) ?? []), `${d.remittance}: ${d.believedFrom} says ${money(d.believedCents)} and ${d.otherFrom} says ${money(d.otherCents)}`]);
  }
  for (const [m, lines] of differBy) of(m).differ = several(lines);
  return out;
}
