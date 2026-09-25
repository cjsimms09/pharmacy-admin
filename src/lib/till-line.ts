/**
 * What the till took, said only as far as the site actually knows it.
 *
 * The home page used to print, in bold and on one line:
 *
 *   "$0.00 taken in 2026-09 — the whole till, retail and prescriptions together, from the System
 *    Sales Summary. Of that, $0.00 came from the plans, $0.00 from patients at the counter and
 *    $2,115.07 over the counter."
 *
 * Every fault in that sentence is the same fault. The `sales_months` row holds a real retail figure
 * and nulls for the three prescription columns, because the row was reconstructed from PioneerRx's
 * till and the till knows the front of shop; each null was rendered `?? 0`, so "nobody has told us"
 * came out as "nothing was taken". It then attributed the whole thing to a System Sales Summary
 * which has never been filed — the one document that would carry the missing halves.
 *
 * So the sentence is built from what is present. A figure the site holds is stated; a figure it does
 * not hold is named as missing, with where it would come from. Nothing is defaulted to nought,
 * because on a till reading a nought and a blank are opposite pieces of news.
 *
 * Pure, so it is tested.
 */

export type TillFigures = {
  month: string;
  retailCents: number | null;
  rxPatientCents: number | null;
  rxRemitCents: number | null;
  totalCents: number | null;
  /** True where the month on file is the one now running. */
  isCurrentMonth: boolean;
  /** The document the row was built from, where one is recorded. */
  fileName?: string | null;
};

export type TillLine = {
  /** The bold figure, or null where the site has no total to lead with. */
  headlineCents: number | null;
  /** What the headline is: the whole till, or only the part that is known. */
  headline: string;
  /** The rest of the sentence. Never contains a figure the site does not hold. */
  detail: string;
  /** True where something the sentence would want is absent. */
  partial: boolean;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/**
 * A reconstruction is not the pharmacy's own report, and saying so is the point.
 *
 * The till pull writes its own name into `fileName`. Where that is what filled the row, the sentence
 * must not claim a System Sales Summary, because the reader's next question — "why is the
 * prescription half nought?" — has a different answer in each case: the Summary would have carried
 * it, and the till pull never could.
 */
function sourceOf(f: TillFigures): { name: string; reconstructed: boolean } {
  const n = (f.fileName ?? "").trim();
  if (/^pioneerrx till/i.test(n)) return { name: "PioneerRx's till, front of shop only", reconstructed: true };
  if (n) return { name: n, reconstructed: false };
  return { name: "the System Sales Summary", reconstructed: false };
}

export function tillLine(f: TillFigures): TillLine {
  const src = sourceOf(f);
  const when = f.isCurrentMonth ? f.month : `${f.month} — the last month closed`;

  const parts: string[] = [];
  if (has(f.rxRemitCents)) parts.push(`${money(f.rxRemitCents)} came from the plans`);
  if (has(f.rxPatientCents)) parts.push(`${money(f.rxPatientCents)} from patients at the counter`);
  if (has(f.retailCents)) parts.push(`${money(f.retailCents)} over the counter`);

  const missing: string[] = [];
  if (!has(f.rxRemitCents)) missing.push("what the plans paid");
  if (!has(f.rxPatientCents)) missing.push("what patients paid at the counter");
  if (!has(f.retailCents)) missing.push("what the front of shop took");

  /*
   * The headline is the whole till only where the whole till is on file. Where it is not, the
   * largest thing actually known leads instead, and is labelled as the part it is — a bold total
   * that silently omits the prescription side is the version that started this.
   */
  if (has(f.totalCents)) {
    return {
      headlineCents: f.totalCents,
      headline: `${money(f.totalCents)} taken in ${when}`,
      detail:
        `the whole till, retail and prescriptions together, from ${src.name}.` +
        (parts.length ? ` Of that, ${parts.join(", ")}.` : "") +
        (missing.length ? ` It does not say ${missing.join(" or ")}.` : ""),
      partial: missing.length > 0,
    };
  }

  if (has(f.retailCents) && !has(f.rxRemitCents) && !has(f.rxPatientCents)) {
    return {
      headlineCents: f.retailCents,
      headline: `${money(f.retailCents)} over the counter in ${when}`,
      detail: src.reconstructed
        ? `the front of shop only, rebuilt from ${src.name}. The prescription side of the till is not on this figure — the claims carry it, and a System Sales Summary would carry both halves together.`
        : `from ${src.name}, which does not state what the prescription side of the till took.`,
      partial: true,
    };
  }

  const known = parts.length ? `So far: ${parts.join(", ")}.` : "None of its figures have been read.";
  return {
    headlineCents: null,
    headline: `The till for ${when} is not fully on file`,
    detail: `${known} Missing: ${missing.join(", ")}. From ${src.name}.`,
    partial: true,
  };
}
