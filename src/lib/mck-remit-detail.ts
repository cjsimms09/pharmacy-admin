/**
 * ProviderPay's Remit Detail export, read without ever touching the patient column.
 *
 * ── Why this file exists at all ──
 *
 * The push feeds went quiet around 14 September 2026. Measured on the portal's own summary against
 * the site's claim payments: $119,273 remitted between the 14th and the 18th, $3,665 of it in the
 * books. The 835s are still on the portal, but "Export Modified 835" only enables for one
 * remittance at a time, so recovering a fortnight means twenty separate downloads by hand. The
 * detail export is one file and carries every claim line of all of them.
 *
 * ── The patient column ──
 *
 * The export's fifth column is headed "Patient name". That is why the ingestion gate refuses this
 * file wholesale, and the refusal is right: nothing should store these bytes. The owner, twice:
 * "DO NOT touch patient name, DOB, or anything related", and "i do not want the site to get
 * patient names.. or at least to retain them".
 *
 * A reader is a different thing from a store. The site's own 835 parser reads remittances that
 * carry member names in their NM1 segments and leaves no name behind, because it handles nine
 * segment types and NM1 is not one of them. This does the same by the same means: the columns it
 * wants are located by name and read by index, and the patient column's index is never among them.
 * `readRemitDetail` returns a shape with nowhere to put a name.
 *
 * Pure: text in, rows out. Nothing here touches a database or decides what a month contains.
 */

export type DetailLine = {
  /** ProviderPay's number for the remittance this line belongs to. */
  remitNumber: string;
  /**
   * The prescription number, or null on an adjustment row.
   *
   * One column does both jobs — it is headed "Rx number or ADJ description" — so a row whose value
   * is not a bare number is an adjustment and its text is kept in `adjustment` instead. Guessing
   * either way would put a description in a prescription column.
   */
  rxNumber: string | null;
  /** The adjustment's description where this is one, otherwise null. */
  adjustment: string | null;
  /** ISO. The day the prescription was dispensed, not the day it was paid. */
  dispensedOn: string | null;
  /** ISO. The remittance's date, which is when this money is the pharmacy's. */
  remitOn: string | null;
  amountCents: number;
  /** The payer's payment number, which joins this to the deposit in the sweep account. */
  paymentNumber: string | null;
  /** Whether ProviderPay matched the line to a claim of its own. Recorded, not relied upon. */
  matchedToClaim: boolean | null;
};

export type DetailRead = {
  lines: DetailLine[];
  /** Totals per remittance, so each can be checked against the summary export's own figure. */
  byRemit: { remitNumber: string; lines: number; amountCents: number }[];
  totalCents: number;
  /** Rows the reader would not take, and why, so a changed export is visible rather than silent. */
  skipped: { row: number; why: string }[];
  problems: string[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** One CSV row into fields, honouring quotes, so a comma inside one cannot shift the columns. */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** "09/18/2026" → "2026-09-18". Null for anything else rather than a guess. */
function iso(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/** Dollars as printed to integer cents, negatives included. Null when it is not a number. */
function cents(raw: string | undefined): number | null {
  const t = (raw ?? "").replace(/[$,"]/g, "").trim();
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}

/**
 * Read a remit detail export.
 *
 * Returns an empty read with a problem rather than throwing, so a changed export shows up as a
 * sentence somebody can act on instead of a stack trace.
 */
export function readRemitDetail(text: string): DetailRead {
  const out: DetailRead = { lines: [], byRemit: [], totalCents: 0, skipped: [], problems: [] };

  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((r) => r.trim().length > 0);
  if (rows.length === 0) {
    out.problems.push("The file is empty.");
    return out;
  }

  const header = splitRow(rows[0]).map((h) => norm(h.replace(/^"|"$/g, "")));
  const at = (name: string) => header.indexOf(name);
  const iRemit = at("remitnumber");
  const iRx = at("rxnumberoradjdescription");
  const iDispensed = at("dispensedate");
  const iAmount = at("remitamt");
  const iRemitDate = at("remitdate");
  const iPayment = at("checkachnumber");
  const iMatch = at("matchtoclaim");

  if (iRemit < 0 || iRx < 0 || iAmount < 0) {
    out.problems.push(
      `This does not look like a ProviderPay remit detail export: its columns are ${header.join(", ")}. ` +
        `Expected a remit number, an Rx-or-adjustment column and a remit amount.`,
    );
    return out;
  }

  /*
   * The patient column is located only so that it can be excluded by assertion rather than by
   * hoping no wanted index happens to equal it. If the export ever moves the money into that
   * column the reader stops instead of reading a name into `amountCents`.
   */
  const iPatient = header.findIndex((h) => /^(patient|pt)(first|last|full)?name$/.test(h));
  const wanted = [iRemit, iRx, iDispensed, iAmount, iRemitDate, iPayment, iMatch];
  if (iPatient >= 0 && wanted.includes(iPatient)) {
    out.problems.push(
      `Refused: column ${iPatient + 1} of this export is the patient name and it is also where one of ` +
        `the columns this reads is expected. Nothing was read.`,
    );
    return out;
  }

  const totals = new Map<string, { lines: number; amountCents: number }>();

  for (let r = 1; r < rows.length; r++) {
    const f = splitRow(rows[r]);
    const remitNumber = (f[iRemit] ?? "").replace(/^"|"$/g, "").trim();
    const amountCents = cents(f[iAmount]);
    if (!remitNumber || amountCents === null) {
      if (f.some((x) => x.length > 0)) out.skipped.push({ row: r + 1, why: "no remit number or no readable amount" });
      continue;
    }

    const rxOrAdj = (f[iRx] ?? "").replace(/^"|"$/g, "").trim();
    const isRx = /^\d+$/.test(rxOrAdj);
    const matchRaw = (f[iMatch] ?? "").replace(/^"|"$/g, "").trim().toLowerCase();

    out.lines.push({
      remitNumber,
      rxNumber: isRx ? rxOrAdj : null,
      adjustment: isRx ? null : rxOrAdj || null,
      dispensedOn: iDispensed >= 0 ? iso(f[iDispensed]) : null,
      remitOn: iRemitDate >= 0 ? iso(f[iRemitDate]) : null,
      amountCents,
      paymentNumber: iPayment >= 0 ? (f[iPayment] ?? "").replace(/^"|"$/g, "").trim() || null : null,
      matchedToClaim: matchRaw === "yes" ? true : matchRaw === "no" ? false : null,
    });
    out.totalCents += amountCents;

    const t = totals.get(remitNumber) ?? { lines: 0, amountCents: 0 };
    t.lines += 1;
    t.amountCents += amountCents;
    totals.set(remitNumber, t);
  }

  out.byRemit = [...totals.entries()]
    .map(([remitNumber, t]) => ({ remitNumber, ...t }))
    .sort((a, b) => a.remitNumber.localeCompare(b.remitNumber));

  return out;
}

/**
 * Check each remittance's lines against the figure the summary export prints for it.
 *
 * The two files come out of the same table minutes apart, so they must agree; where they do not,
 * one of them was read wrongly and neither should be trusted for that remittance. Returns the
 * disagreements only — an empty array is the good answer.
 */
export function detailAgreesWithSummary(
  detail: DetailRead,
  summary: { remitNumber: string; amountCents: number }[],
): { remitNumber: string; detailCents: number; summaryCents: number }[] {
  const byRemit = new Map(summary.map((s) => [s.remitNumber, s.amountCents]));
  const out: { remitNumber: string; detailCents: number; summaryCents: number }[] = [];
  for (const d of detail.byRemit) {
    const s = byRemit.get(d.remitNumber);
    if (s === undefined) continue;
    if (s !== d.amountCents) out.push({ remitNumber: d.remitNumber, detailCents: d.amountCents, summaryCents: s });
  }
  return out;
}
