/**
 * Bank lines named by payee, once, and remembered.
 *
 * The owner, 12 November 2026, with fifty-six October lines waiting to be named one at a time: "there need to be an EASY way for me to match
 * payments or debits, categorize and fix." Twenty-five of them were one payee (IPC), two were McKesson, three Wholescripts. Naming a payee is one
 * decision, not twenty-five, and next month's lines from the same payee are the same decision again.
 *
 * So lines are grouped by what the bank printed with the numbers taken off (the cheque number, the register's account code, the trace), split by
 * direction, and one answer is applied to the whole group. The answer is kept as a rule on the payee, so a later statement's line from that payee is
 * named when it is read and never reaches him. A rule says only what he said: nothing is inferred from amounts or from other payees.
 *
 * Pure: no database, so every rule of the grouping can be tested on invented lines.
 */

export type PayeeRule = {
  stem: string;
  direction: "out" | "in";
  what: string;
  category?: string;
  vendor?: string;
  standing?: string;
  payer?: string;
  receiptKind?: string;
  /** Who said it, and when, in his words: it is printed on every line the rule names. */
  by: string;
};

export type GroupableLine = { id: string; on: string; description: string; amountCents: number };

export type PayeeGroup<T extends GroupableLine = GroupableLine> = {
  stem: string;
  direction: "out" | "in";
  /** A description as the bank printed it, for display. */
  example: string;
  lines: T[];
  totalCents: number;
  from: string;
  to: string;
};

/** What the bank printed with the numbers taken off: the cheque number, the register's payee code, the trace and the account that follow. */
export function payeeStem(description: string): string {
  let s = description.replace(/\s+/g, " ").trim();
  s = s.replace(/^\d{3,5}\s+(?=\D)/, ""); // a cheque number in front: "1869 LL Medico"
  s = s.replace(/^[A-Z]{2,5}\d{3,5}\s+/, ""); // the register's payee code: "IPC0100 Independent Pharmacy Cooperative"
  s = s.split(/\s\d{5,}/)[0]; // from the first long number on: a trace, an account, a batch
  return s
    .toLowerCase()
    .replace(/[^a-z0-9&/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const directionOf = (amountCents: number): "out" | "in" => (amountCents < 0 ? "out" : "in");

/** The lines nobody has named, together by payee and direction, the biggest money first. */
export function groupByPayee<T extends GroupableLine>(lines: T[]): PayeeGroup<T>[] {
  const by = new Map<string, PayeeGroup<T>>();
  for (const l of lines) {
    const stem = payeeStem(l.description) || l.description.toLowerCase();
    const direction = directionOf(l.amountCents);
    const k = `${direction}|${stem}`;
    const g = by.get(k) ?? { stem, direction, example: l.description, lines: [], totalCents: 0, from: l.on, to: l.on };
    g.lines.push(l);
    g.totalCents += l.amountCents;
    if (l.on < g.from) g.from = l.on;
    if (l.on > g.to) g.to = l.on;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents) || a.stem.localeCompare(b.stem));
}

export function parseRules(json: string | null | undefined): PayeeRule[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((r) => r && typeof r.stem === "string" && (r.direction === "out" || r.direction === "in") && typeof r.what === "string") : [];
  } catch {
    return [];
  }
}

/** The rule for a line, if he has given one for its payee and direction. */
export function ruleFor(rules: PayeeRule[], description: string, amountCents: number): PayeeRule | null {
  const stem = payeeStem(description);
  if (!stem) return null;
  const direction = directionOf(amountCents);
  return rules.find((r) => r.stem === stem && r.direction === direction) ?? null;
}

/** A rule added or replaced: one per payee and direction, the latest answer standing. */
export function withRule(rules: PayeeRule[], rule: PayeeRule): PayeeRule[] {
  return [...rules.filter((r) => !(r.stem === rule.stem && r.direction === rule.direction)), rule];
}

export type SuggestContext = {
  suppliers: { name: string; aliases?: string | null }[];
  vendors: { name: string; categoryName: string | null }[];
  standing: { name: string }[];
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const contains = (a: string, b: string) => squash(b).length >= 3 && squash(a).includes(squash(b));

/**
 * What the group most likely is, from names the site already holds. Only ever a starting point on the form: nothing is applied until he presses.
 * A payee that is a wholesaler he buys from is drug purchases (the invoices carry the cost; the bank line is the payment). A payee that is a vendor on
 * file takes that vendor's category. Anything else is left for him to say.
 */
export function suggestFor(g: { stem: string; direction: "out" | "in" }, ctx: SuggestContext): { what: string; category?: string; vendor?: string; standing?: string; because: string } | null {
  if (g.direction !== "out") return null;
  for (const s of ctx.suppliers) {
    const names = [s.name, ...(s.aliases ?? "").split(/\r?\n|,/)].map((n) => n.trim()).filter((n) => n.length >= 3);
    if (names.some((n) => contains(g.stem, n))) return { what: "noted", category: "Drug purchases", because: `${s.name} is a wholesaler you buy from, so this is a payment for drugs.` };
  }
  for (const st of ctx.standing) if (contains(g.stem, st.name)) return { what: "standing", standing: st.name, because: `It matches your standing cost "${st.name}".` };
  for (const v of ctx.vendors) {
    if (contains(g.stem, v.name) && v.categoryName) return { what: "cost", category: v.categoryName, vendor: v.name, because: `${v.name} is a payee on file, under ${v.categoryName}.` };
  }
  return null;
}
