import { type ReturnTermsT } from "./supplier-terms";

/**
 * When a bottle has to go back, counted from the invoice rather than from the expiry date.
 *
 * "Only ten days left to return this to IPC" is the whole point, and it is the invoice date that
 * decides it. A bottle bought last week and not wanted is on the invoice's clock: McKesson credits
 * a saleable return in full where the authorisation is raised within thirty days of the invoice and
 * three quarters after that. Nothing about how much shelf life is left enters into it. A site that
 * counted down to expiry would tell a pharmacist about a bottle with eighteen months on it and say
 * nothing about the one whose full credit runs out on Friday.
 *
 * ── What it will not do ──
 *
 * Where no return policy is on file for the supplier, nothing is returned: no window, no countdown,
 * no guess. A return raised outside a window the site invented is a return refused, with the
 * pharmacy holding stock it was told to send back.
 *
 * ── Dispensed or not ──
 *
 * Whether the drug has moved since it arrived is the difference between "send this back" and
 * "leave it alone", and it is the one thing a purchase record cannot know on its own. Claims since
 * the invoice date answer it. Nothing here decides for anybody: a product that has moved is
 * reported as having moved, and how much of the bottle is left is a question only the shelf can
 * settle.
 *
 * Pure. Everything comes in as arguments, so the arithmetic can be checked against a real invoice
 * and a real policy rather than against whatever is in the database today.
 */

export type ReturnCandidate = {
  ndc11: string;
  description: string | null;
  supplier: string;
  supplierId: string | null;
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  quantity: number;
  extendedCents: number;
  /** Whole days since the invoice was dated. */
  daysSinceInvoice: number;
  /** What the supplier credits today, as a percentage of what was paid. */
  creditPercentNow: number;
  /** That percentage of the line's extended amount. */
  creditNowCents: number;
  /**
   * Days until the credit falls, and what it falls to. Null once no further step remains.
   */
  dropsInDays: number | null;
  dropsToPercent: number | null;
  /** Days until nothing can be returned at all, where the policy sets a final deadline. */
  closesInDays: number | null;
  /** Units dispensed of this NDC since the invoice date. */
  dispensedSince: number;
  /** The sentence to put in front of a person. */
  says: string;
  /** How urgent, for ordering and for colour. */
  urgency: "today" | "this week" | "this month" | "later" | "closed";
};

export type ReturnsInput = {
  lines: {
    ndc11: string;
    description: string | null;
    supplier: string | null;
    supplierId: string | null;
    invoiceId: string;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    quantity: number;
    extendedCents: number;
  }[];
  /** The return terms in force for each supplier, by supplier id. Absent means no policy on file. */
  termsBySupplierId: Map<string, ReturnTermsT>;
  /** Claims, for working out whether an NDC has moved since it arrived. */
  claims: { ndc11: string | null; quantityThousandths: number | null; dateFilled: string | null; status?: string }[];
  today: string;
};

const DAY = 86_400_000;

/** Whole days from one ISO date to another. Negative where the second is earlier. */
export function daysFrom(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / DAY);
}

/**
 * The credit step that applies after so many days, and the one after it.
 *
 * Steps are "within this many days, this much" and are read in ascending order; a final step whose
 * `withinDays` is null is the rate beyond every named window. A policy with no steps at all
 * settles nothing, and returns null rather than a rate somebody might act on.
 */
export function stepAt(terms: ReturnTermsT, days: number): { now: number; next: { atDays: number; percent: number } | null } | null {
  const steps = [...terms.creditStepsFromInvoice].sort(
    (a, b) => (a.withinDays ?? Number.MAX_SAFE_INTEGER) - (b.withinDays ?? Number.MAX_SAFE_INTEGER),
  );
  if (steps.length === 0) return null;
  let now: number | null = null;
  let next: { atDays: number; percent: number } | null = null;
  for (const s of steps) {
    if (s.withinDays === null) {
      if (now === null) now = s.creditPercent;
      continue;
    }
    if (days <= s.withinDays) {
      now = s.creditPercent;
      // The next step is the first one whose window this line has not yet passed out of.
      const after = steps.filter((x) => (x.withinDays ?? Number.MAX_SAFE_INTEGER) > s.withinDays!)[0];
      next = after ? { atDays: s.withinDays + 1, percent: after.creditPercent } : null;
      break;
    }
  }
  if (now === null) {
    // Past every named window: the final open-ended step, or nothing.
    const open = steps.find((s) => s.withinDays === null);
    if (!open) return null;
    now = open.creditPercent;
  }
  return { now, next };
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function returnsDue(input: ReturnsInput): ReturnCandidate[] {
  /*
   * What has moved, by NDC and by date.
   *
   * Only claims dated on or after the invoice count: a dispensing from the bottle before this one
   * says nothing about whether this one has been opened.
   */
  const dispensed = new Map<string, { on: string; units: number }[]>();
  for (const c of input.claims) {
    if (!c.ndc11 || !c.dateFilled) continue;
    if (c.status && /revers|cancel/i.test(c.status)) continue;
    const units = (c.quantityThousandths ?? 0) / 1000;
    dispensed.set(c.ndc11, [...(dispensed.get(c.ndc11) ?? []), { on: c.dateFilled, units }]);
  }

  const out: ReturnCandidate[] = [];
  for (const l of input.lines) {
    if (!l.invoiceDate || !l.supplierId) continue;
    const terms = input.termsBySupplierId.get(l.supplierId);
    // No policy on file is not a zero-day window. It is silence, and silence is the right answer.
    if (!terms) continue;

    const days = daysFrom(l.invoiceDate, input.today);
    if (!Number.isFinite(days) || days < 0) continue;

    const step = stepAt(terms, days);
    if (!step) continue;

    const closesInDays =
      terms.returnableWithinDaysOfInvoice === null ? null : terms.returnableWithinDaysOfInvoice - days;
    if (closesInDays !== null && closesInDays < 0) continue; // the window has shut; nothing to offer

    const fee = terms.restockingFeePercent ?? 0;
    const creditPercentNow = Math.max(0, Math.round((step.now - fee) * 100) / 100);
    const creditNowCents = Math.round((l.extendedCents * creditPercentNow) / 100);
    const dropsInDays = step.next ? Math.max(0, step.next.atDays - days) : null;
    const dropsToPercent = step.next ? Math.max(0, Math.round((step.next.percent - fee) * 100) / 100) : null;

    const moved = (dispensed.get(l.ndc11) ?? []).filter((d) => d.on >= l.invoiceDate!);
    const dispensedSince = Math.round(moved.reduce((n, d) => n + d.units, 0) * 100) / 100;

    // The soonest thing that changes, which is what the sentence and the ordering both turn on.
    const soonest = dropsInDays !== null && (closesInDays === null || dropsInDays <= closesInDays) ? dropsInDays : closesInDays;
    const urgency: ReturnCandidate["urgency"] =
      soonest === null ? "later" : soonest <= 0 ? "today" : soonest <= 7 ? "this week" : soonest <= 30 ? "this month" : "later";

    const what = l.description ?? l.ndc11;
    const clock =
      dropsInDays !== null && dropsToPercent !== null
        ? dropsInDays === 0
          ? `the credit drops to ${dropsToPercent}% today`
          : `${dropsInDays} day${dropsInDays === 1 ? "" : "s"} left before the credit drops to ${dropsToPercent}%`
        : closesInDays !== null
          ? `${closesInDays} day${closesInDays === 1 ? "" : "s"} left before it cannot go back at all`
          : "no further deadline on this one";

    out.push({
      ndc11: l.ndc11,
      description: l.description,
      supplier: l.supplier ?? "this supplier",
      supplierId: l.supplierId,
      invoiceId: l.invoiceId,
      invoiceNumber: l.invoiceNumber,
      invoiceDate: l.invoiceDate,
      quantity: l.quantity,
      extendedCents: l.extendedCents,
      daysSinceInvoice: days,
      creditPercentNow,
      creditNowCents,
      dropsInDays,
      dropsToPercent,
      closesInDays,
      dispensedSince,
      urgency,
      says:
        `${what} from ${l.supplier ?? "this supplier"}: ${clock}. ` +
        `Worth ${money(creditNowCents)} back today at ${creditPercentNow}%. ` +
        (dispensedSince > 0
          ? `${dispensedSince} unit${dispensedSince === 1 ? "" : "s"} dispensed since it arrived, so check what is left before raising it.`
          : `Nothing has been dispensed since it arrived.`),
    });
  }

  /*
   * Soonest deadline first, and the money breaks the tie.
   *
   * A list ordered by value would put a fifty-dollar line with three weeks on it above a
   * twelve-dollar line whose full credit runs out tomorrow, which is the wrong way round: the
   * deadline is the thing that cannot be recovered.
   */
  const rank = { today: 0, "this week": 1, "this month": 2, later: 3, closed: 4 } as const;
  return out.sort(
    (a, b) =>
      rank[a.urgency] - rank[b.urgency] ||
      (a.dropsInDays ?? a.closesInDays ?? 9999) - (b.dropsInDays ?? b.closesInDays ?? 9999) ||
      b.creditNowCents - a.creditNowCents,
  );
}

/** What the whole list is worth if it all went back today. */
export function worthOf(rows: ReturnCandidate[]): number {
  return rows.reduce((n, r) => n + r.creditNowCents, 0);
}

/** The ones worth putting in front of somebody now: a deadline inside a fortnight, nothing dispensed. */
export function actNow(rows: ReturnCandidate[]): ReturnCandidate[] {
  return rows.filter((r) => (r.urgency === "today" || r.urgency === "this week") && r.dispensedSince === 0);
}

/** Loads everything the countdown needs and works it out. Server-side; the arithmetic above is pure. */
export async function returnsDueNow(): Promise<{ rows: ReturnCandidate[]; suppliersWithoutPolicy: string[]; linesConsidered: number }> {
  const { db, schema } = await import("@/db");
  const { todayIso } = await import("./dates");
  const { allSuppliers } = await import("./suppliers-registry");
  const { currentReturnPolicy } = await import("./supplier-terms-store");

  const [lines, claims, suppliers] = await Promise.all([
    /*
     * Eight of fourteen columns, which is what `ReturnsInput.lines` asks for.
     *
     * The claims read beside it names its four; this one read every column of all forty-five
     * thousand invoice lines. The two were written together and only one of them was narrowed.
     */
    db.query.invoiceLines.findMany({
      columns: { ndc11: true, description: true, supplier: true, supplierId: true, invoiceId: true, invoiceDate: true, quantity: true, extendedCents: true },
    }),
    db.query.claims.findMany({ columns: { ndc11: true, quantityThousandths: true, dateFilled: true, status: true } }),
    allSuppliers(true),
  ]);

  /*
   * Matching an invoice line's supplier to a register row.
   *
   * The line carries the name as the invoice printed it and the register carries the name the
   * pharmacy uses, and they are not obliged to agree — which is what the catalogue name is for.
   */
  const byName = new Map<string, string>();
  for (const s of suppliers) {
    byName.set(s.name.trim().toLowerCase(), s.id);
    if (s.catalogName) byName.set(s.catalogName.trim().toLowerCase(), s.id);
  }
  const idFor = (name: string | null): string | null => {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    if (byName.has(key)) return byName.get(key)!;
    for (const [n, id] of byName) if (key.includes(n) || n.includes(key)) return id;
    return null;
  };

  const termsBySupplierId = new Map<string, ReturnTermsT>();
  const without: string[] = [];
  for (const s of suppliers) {
    const p = await currentReturnPolicy(s.id);
    if (p && p.terms.creditStepsFromInvoice.length > 0) termsBySupplierId.set(s.id, p.terms);
    else without.push(s.name);
  }

  const withIds = lines.map((l) => ({
    ndc11: l.ndc11,
    description: l.description,
    supplier: l.supplier,
    supplierId: idFor(l.supplier),
    invoiceId: l.invoiceId,
    invoiceNumber: null as string | null,
    invoiceDate: l.invoiceDate,
    quantity: l.quantity,
    extendedCents: l.extendedCents,
  }));

  const rows = returnsDue({ lines: withIds, termsBySupplierId, claims, today: todayIso() });
  return { rows, suppliersWithoutPolicy: without, linesConsidered: withIds.length };
}
