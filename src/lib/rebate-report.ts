/**
 * Reading McKesson's monthly rebate breakdown, so nobody types a tier ladder in by hand.
 *
 * The report carries two things worth keeping and they are different in kind. The **ladder** is the
 * contract: eleven bands of generic compliance rate, each paying a generic percentage and a brand
 * percentage, and it is the same every month until the agreement changes. The **statement** is one
 * month's settlement: what was bought, what ratio the pharmacy actually achieved, which band that
 * landed in, and what was paid. The ladder is what the purchasing comparison needs; the statement
 * is what proves the ladder was read correctly.
 *
 * ── Why it can be trusted ──
 *
 * Because the document checks itself. The statement prints the scrubbed generic compliance rate
 * (20.64% on the May report), and the band that rate falls into on the ladder must be the rate the
 * statement says it paid (29.00%), and that rate applied to the OneStop purchases must be the
 * generic rebate printed at the bottom ($2,872.67 × 29% = $833.07). Three independent readings that
 * have to agree. Where they do not, the report is not stored: a tier ladder read slightly wrong
 * would quietly misprice every generic in the purchasing comparison, and there would be nothing to
 * notice.
 *
 * ── The scrub, which this deliberately does not model ──
 *
 * The rate is driven by a *scrubbed* compliance rate: McKesson excludes certain products — GLP-1s
 * among them — from both sides of the ratio before working it out. Which NDCs are excluded is not
 * in this report and is not published anywhere the pharmacy can read. So the site takes the rate
 * the report states, which already has the scrub in it, and never tries to recompute the ratio
 * from purchases. A modelled ratio would be a number this software invented sitting inside a
 * decision about where to spend forty thousand dollars a month.
 */

export type LadderBand = {
  /** The compliance rate at or above which the band applies, in percent. */
  fromPercent: number;
  /** The top of the band, or null for the open-ended top band ("24+%"). */
  toPercent: number | null;
  /** What every OneStop purchase earns at this band. */
  genericPercent: number;
  /** What every brand purchase earns at this band. */
  brandPercent: number;
};

export type Ladder = {
  /** The generic compliance rate ladder — the one that pays. */
  gcr: LadderBand[];
  /** The generic purchase ratio ladder, printed beside it. Nil for this pharmacy so far. */
  gpr: { fromPercent: number; toPercent: number | null; rebatePercent: number }[];
};

export type Statement = {
  pharmacy: string | null;
  locationId: string | null;
  accountNumber: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  paidOn: string | null;
  netPurchasedCents: number | null;
  totalFeesCents: number | null;
  brandPurchasedCents: number | null;
  brandFactorPercent: number | null;
  brandRebateCents: number | null;
  oneStopPurchasedCents: number | null;
  gcrRatePercent: number | null;
  gcrRebateCents: number | null;
  gprRatePercent: number | null;
  gprRebateCents: number | null;
  genericRebateCents: number | null;
  totalPaidCents: number | null;
  /** The compliance rate actually achieved, after McKesson's exclusions. Selects the band. */
  scrubbedGcrPercent: number | null;
  gprPercent: number | null;
};

export type Check = { what: string; ok: boolean; detail: string };

export type RebateReport = {
  statement: Statement;
  ladder: Ladder;
  checks: Check[];
  /** True only when every check that could be made passed. Nothing is stored otherwise. */
  trustworthy: boolean;
  problems: string[];
};

const cents = (s: string): number | null => {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const pct = (s: string): number | null => {
  const n = Number(s.replace(/[%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Whether a document is this report, before anything is read out of it. */
export function looksLikeRebateReport(text: string): boolean {
  const head = text.slice(0, 3000);
  return /rebate breakdown/i.test(head) || (/OneStop Purchases/i.test(text) && /GCR Generic Rebate/i.test(text));
}

/**
 * One row of the tier table, which prints two ladders side by side with no separator.
 *
 * "0-74.99%0.00%0-8.99%15.00%0.00%" is the GPR band 0 to 74.99 paying 0%, then the GCR band 0 to
 * 8.99 paying 15% on generics and 0% on brand. The top row is open-ended on both: "95+%10.00%24+%30.00%1.00%".
 */
const BAND = new RegExp(
  String.raw`^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?(\+)?%` + // GPR band
    String.raw`(\d+(?:\.\d+)?)%` + // GPR rebate
    String.raw`(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?(\+)?%` + // GCR band
    String.raw`(\d+(?:\.\d+)?)%` + // generic rebate
    String.raw`(\d+(?:\.\d+)?)%$`, // brand rebate
);

/** A labelled money or percentage figure printed with no space: "Net Purchased$28,788.29". */
function figure(lines: string[], label: RegExp): string | null {
  for (const l of lines) {
    const m = label.exec(l);
    if (m) return m[1] ?? null;
  }
  return null;
}

export function parseRebateReport(text: string): RebateReport {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const problems: string[] = [];

  const money = (label: RegExp) => {
    const v = figure(lines, label);
    return v === null ? null : cents(v);
  };
  const percent = (label: RegExp) => {
    const v = figure(lines, label);
    return v === null ? null : pct(v);
  };

  const period = lines.map((l) => /^Start:(.+?)End:(.+)$/.exec(l)).find(Boolean);
  const statement: Statement = {
    pharmacy: figure(lines, /^Pharmacy:\s*(.+)$/),
    locationId: figure(lines, /^Location ID:\s*(.+)$/),
    accountNumber: figure(lines, /^Primary Account #:\s*(.+)$/),
    periodFrom: period ? monthDayYear(period[1]) : null,
    periodTo: period ? monthDayYear(period[2]) : null,
    paidOn: monthDayYear(figure(lines, /^Paid:\s*(.+)$/) ?? ""),
    netPurchasedCents: money(/^Net Purchased\$?([\d,.]+)$/),
    totalFeesCents: money(/^Total Fees \/ Reimbursement\$?([\d,.]+)$/),
    brandPurchasedCents: money(/^Brand Purchases\$?([\d,.]+)$/),
    brandFactorPercent: percent(/^Brand Factor([\d.]+)%$/),
    brandRebateCents: money(/^Brand Rebate\$?([\d,.]+)$/),
    oneStopPurchasedCents: money(/^OneStop Purchases\$?([\d,.]+)$/),
    gcrRatePercent: percent(/^GCR Generic Rebate %([\d.]+)%$/),
    gcrRebateCents: money(/^GCR Generic Rebate\$?([\d,.]+)$/),
    gprRatePercent: percent(/^GPR Generic Rebate %([\d.]+)%$/),
    gprRebateCents: money(/^GPR Generic Rebate\$?([\d,.]+)$/),
    genericRebateCents: money(/^Generic Rebate\$?([\d,.]+)$/),
    totalPaidCents: money(/^Total Paid\$?([\d,.]+)$/),
    scrubbedGcrPercent: percent(/Scrubbed GCR:\s*([\d.]+)%/),
    gprPercent: percent(/^GPR:\s*([\d.]+)%/),
  };

  const gcr: LadderBand[] = [];
  const gpr: Ladder["gpr"] = [];
  for (const l of lines) {
    const m = BAND.exec(l.replace(/\s+/g, ""));
    if (!m) continue;
    const [, gprFrom, gprTo, , gprRebate, gcrFrom, gcrTo, , generic, brand] = m;
    gpr.push({ fromPercent: Number(gprFrom), toPercent: gprTo ? Number(gprTo) : null, rebatePercent: Number(gprRebate) });
    gcr.push({
      fromPercent: Number(gcrFrom),
      toPercent: gcrTo ? Number(gcrTo) : null,
      genericPercent: Number(generic),
      brandPercent: Number(brand),
    });
  }
  gcr.sort((a, b) => a.fromPercent - b.fromPercent);
  gpr.sort((a, b) => a.fromPercent - b.fromPercent);

  if (gcr.length === 0) problems.push("No tier table was found in this report — the bands could not be read.");

  const checks: Check[] = [];
  const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

  // 1. The band the achieved rate falls in must be the rate the statement says it paid.
  const band = statement.scrubbedGcrPercent === null ? null : bandFor(gcr, statement.scrubbedGcrPercent);
  if (band && statement.gcrRatePercent !== null) {
    const ok = band.genericPercent === statement.gcrRatePercent;
    checks.push({
      what: "The tier the achieved rate lands in",
      ok,
      detail: ok
        ? `A scrubbed GCR of ${statement.scrubbedGcrPercent}% falls in the ${describeBand(band)} band, which pays ${band.genericPercent}% — the rate the statement says it paid.`
        : `A scrubbed GCR of ${statement.scrubbedGcrPercent}% falls in the ${describeBand(band)} band, which pays ${band.genericPercent}%, but the statement says ${statement.gcrRatePercent}%. The ladder has been read wrongly, or the agreement has changed.`,
    });
  }

  // 2. That rate on the OneStop purchases must be the generic rebate printed.
  if (statement.oneStopPurchasedCents !== null && statement.gcrRatePercent !== null && statement.gcrRebateCents !== null) {
    const expected = Math.round((statement.oneStopPurchasedCents * statement.gcrRatePercent) / 100);
    const ok = near(expected, statement.gcrRebateCents);
    checks.push({
      what: "The generic rebate against the purchases it was paid on",
      ok,
      detail: `${dollars(statement.oneStopPurchasedCents)} of OneStop purchases at ${statement.gcrRatePercent}% is ${dollars(expected)}; the statement paid ${dollars(statement.gcrRebateCents)}.`,
    });
  }

  // 3. The brand factor on brand purchases must be the brand rebate printed.
  if (statement.brandPurchasedCents !== null && statement.brandFactorPercent !== null && statement.brandRebateCents !== null) {
    const expected = Math.round((statement.brandPurchasedCents * statement.brandFactorPercent) / 100);
    const ok = near(expected, statement.brandRebateCents);
    checks.push({
      what: "The brand rebate against brand purchases",
      ok,
      detail: `${dollars(statement.brandPurchasedCents)} of brand purchases at ${statement.brandFactorPercent}% is ${dollars(expected)}; the statement paid ${dollars(statement.brandRebateCents)}.`,
    });
  }

  // 4. And the band's brand column must be the brand factor the statement used.
  if (band && statement.brandFactorPercent !== null) {
    const ok = band.brandPercent === statement.brandFactorPercent;
    checks.push({
      what: "The brand factor for that tier",
      ok,
      detail: ok
        ? `The ${describeBand(band)} band pays ${band.brandPercent}% on brand, which is the factor the statement used.`
        : `The ${describeBand(band)} band shows ${band.brandPercent}% on brand but the statement used ${statement.brandFactorPercent}%.`,
    });
  }

  const trustworthy = gcr.length > 0 && checks.length > 0 && checks.every((c) => c.ok);
  if (!trustworthy && gcr.length > 0 && checks.some((c) => !c.ok)) {
    problems.push(
      "The figures on this report do not agree with the tier table printed on it, so the tiers were not stored. " +
        "Either the agreement has changed or the layout has; either way somebody should look before the purchasing " +
        "comparison starts using it.",
    );
  }

  return { statement, ladder: { gcr, gpr }, checks, trustworthy, problems };
}

/** The band a compliance rate falls in: the highest whose floor it reaches. */
export function bandFor(bands: LadderBand[], ratePercent: number): LadderBand | null {
  let found: LadderBand | null = null;
  for (const b of [...bands].sort((a, b2) => a.fromPercent - b2.fromPercent)) {
    if (ratePercent >= b.fromPercent) found = b;
  }
  return found;
}

const describeBand = (b: LadderBand) => (b.toPercent === null ? `${b.fromPercent}%+` : `${b.fromPercent}–${b.toPercent}%`);
const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "May 01 2025" to ISO. Returns null for anything else rather than a guessed date. */
export function monthDayYear(s: string): string | null {
  const m = /([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})/.exec(s.trim());
  if (!m) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const i = months.indexOf(m[1].slice(0, 3).toLowerCase());
  return i < 0 ? null : `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/**
 * The ladder as the terms the rest of the site understands.
 *
 * Only the GCR ladder becomes tiers, because it is the one that pays the generic rebate the
 * purchasing comparison takes off a price. The brand ladder and the scrub are recorded in the notes
 * rather than dropped: they change the money, and a person reading the terms later needs to know
 * they exist even though nothing computes with them yet.
 */
/**
 * The generic purchase ratio ladder, as terms of its own.
 *
 * A second programme rather than a footnote, because it is a second way of being paid and this
 * pharmacy is earning nothing from it: the ratio reads 0.00% and the first band that pays anything
 * starts at 75%. Recorded as its own ladder, the site can say how far away that is, which is a
 * question worth asking every month. Left out, the report would look as though the GCR ladder were
 * the only one there is.
 */
export function gprTermsFromReport(r: RebateReport): {
  kind: "tiered_ratio";
  period: "month";
  eligibility: "catalog_rebate_flag";
  ratioMeasure: "generic_purchase_ratio";
  ratioDefinition: string;
  tiers: { thresholdPercent: number; rebatePercent: number }[];
  paidAs: string;
  notes: string;
} | null {
  if (r.ladder.gpr.length === 0) return null;
  const pays = r.ladder.gpr.filter((b) => b.rebatePercent > 0).sort((a, b) => a.fromPercent - b.fromPercent)[0] ?? null;
  return {
    kind: "tiered_ratio",
    period: "month",
    /*
     * Paid on the contract items, not on generics generally.
     *
     * The report settles it: the statement's "Generic Rebate" is the GCR rebate plus the GPR
     * rebate, and the GCR rebate is OneStop purchases times the GCR rate. Two rebates added
     * together are two rebates on the same purchases. Recorded as "all generics" this ladder would
     * have promised a discount on every generic on the shelf, contract or not, and a purchasing
     * comparison would have preferred a McKesson generic that earns nothing.
     */
    eligibility: "catalog_rebate_flag",
    ratioMeasure: "generic_purchase_ratio",
    ratioDefinition:
      "The generic purchase ratio McKesson prints on the monthly rebate breakdown — the share of purchases that " +
      "are generic. A different measurement from the compliance rate, selecting a band on a different ladder, but " +
      "paid on the same OneStop contract items and on top of the compliance rebate.",
    tiers: r.ladder.gpr.map((b) => ({ thresholdPercent: b.fromPercent, rebatePercent: b.rebatePercent })),
    paidAs: "Settled monthly, added to the compliance rebate on the same contract purchases.",
    notes: pays
      ? `Nothing is paid below ${pays.fromPercent}%. ` +
        (r.statement.gprPercent === null
          ? ""
          : `The ${r.statement.periodFrom ?? "reported"} ratio was ${r.statement.gprPercent}%, which earns nothing.`)
      : "No band on this ladder pays anything.",
  };
}

/**
 * The brand factor ladder, which runs off the same compliance bands as the generic one.
 *
 * A separate programme rather than a note, because it is money on a different kind of purchase:
 * the same 20.64% compliance rate that pays 29% on contract generics pays 0.75% on every brand
 * item. Written into the notes it was a sentence nobody could compute with; as a ladder of its own
 * the brand side of an invoice can be priced too.
 */
export function brandTermsFromReport(r: RebateReport): {
  kind: "tiered_ratio";
  period: "month";
  eligibility: "brand_purchases";
  ratioMeasure: "generic_compliance";
  ratioDefinition: string;
  tiers: { thresholdPercent: number; rebatePercent: number }[];
  paidAs: string;
  notes: string;
} | null {
  if (r.ladder.gcr.length === 0) return null;
  if (r.ladder.gcr.every((b) => b.brandPercent === 0)) return null;
  return {
    kind: "tiered_ratio",
    period: "month",
    eligibility: "brand_purchases",
    ratioMeasure: "generic_compliance",
    ratioDefinition:
      "The same scrubbed generic compliance rate that sets the generic rebate — the brand factor is a second column " +
      "on the same ladder, not a separate measurement.",
    tiers: r.ladder.gcr.map((b) => ({ thresholdPercent: b.fromPercent, rebatePercent: b.brandPercent })),
    paidAs: "Settled monthly, on brand purchases, alongside the generic rebate.",
    notes:
      r.statement.brandFactorPercent === null
        ? "Paid on brand purchases only."
        : `Paid on brand purchases only. The ${r.statement.periodFrom ?? "reported"} factor was ${r.statement.brandFactorPercent}%.`,
  };
}

export function termsFromReport(r: RebateReport): {
  kind: "tiered_ratio";
  period: "month";
  eligibility: "catalog_rebate_flag";
  ratioMeasure: "generic_compliance";
  ratioDefinition: string;
  tiers: { thresholdPercent: number; rebatePercent: number }[];
  paidAs: string;
  notes: string;
} {
  return {
    kind: "tiered_ratio",
    period: "month",
    eligibility: "catalog_rebate_flag",
    ratioMeasure: "generic_compliance",
    ratioDefinition:
      "The scrubbed generic compliance rate McKesson prints on the monthly rebate breakdown. Certain products — " +
      "GLP-1s among them — are excluded from both sides of the ratio before it is worked out, and which products " +
      "those are is not published, so the rate is taken from the report rather than recomputed here.",
    tiers: r.ladder.gcr.map((b) => ({ thresholdPercent: b.fromPercent, rebatePercent: b.genericPercent })),
    paidAs: r.statement.paidOn
      ? `Settled monthly; the ${r.statement.periodFrom ?? "period"} statement was paid ${r.statement.paidOn}.`
      : "Settled monthly.",
    notes:
      "Brand purchases earn a separate factor off the same compliance bands; it is recorded as its own " +
      "programme rather than folded in here, so a brand line can be priced with it.",
  };
}
