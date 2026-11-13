/**
 * The two CSVs ProviderPay's remittance table exports, told apart from each other and from
 * everything else by their columns.
 *
 * These are not 835s. They are the portal table's own data, and they arrive when somebody goes to
 * the site and presses Export rather than when a feed delivers anything — which is most of why
 * they matter: the push feeds went quiet on 15 September 2026 and the portal is the route that
 * still works.
 *
 * ── Why naming them is worth a file ──
 *
 * Unrecognised is not a harmless state here. A file nothing recognises is filed as a document with
 * its bytes intact, and the detail export carries a column headed "Patient name" — 9,107 rows of
 * it in the first one downloaded. The patient-information gate refuses that file, but the gate says
 * only that something is wrong; it cannot say *what the file is* or why it was downloaded. A named
 * kind lets the refusal read "this is the detail export, take the summary instead" rather than
 * "columns did not match any known report".
 *
 * Pure: text in, a verdict out. Neither of these is read into the ledger yet.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const columnsOf = (text: string): Set<string> => {
  const head = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  return new Set(head.split(",").map((c) => norm(c.replace(/^"|"$/g, ""))));
};

/**
 * The remit summary: one row per remittance.
 *
 * Known by "remit number" beside "payment match" — the column that carries the payer's own payment
 * number and so joins a remittance to the deposit in the sweep account. No other report the
 * pharmacy receives pairs those two.
 */
export function looksLikeRemitSummary(text: string): boolean {
  const cols = columnsOf(text);
  return ["remitnumber", "payername", "remitdate", "remitamt", "paymentmatch"].every((c) => cols.has(c));
}

/**
 * The remit detail: one row per claim inside a remittance.
 *
 * Known by its patient column as much as anything else, because that column is the reason this
 * shape has to be recognised rather than merely refused. "Rx number or ADJ description" is the
 * other giveaway: one column doing two jobs, which no other report here does.
 */
export function looksLikeRemitDetail(text: string): boolean {
  const cols = columnsOf(text);
  return cols.has("remitnumber") && cols.has("rxnumberoradjdescription") && cols.has("matchtoclaim");
}

/** One remittance, as the summary export prints it. No patient data anywhere in this file. */
export type SummaryRow = {
  remitNumber: string;
  payerName: string;
  /** ISO. When the payer remitted, which is what the detail export's lines carry too. */
  remitOn: string | null;
  amountCents: number;
  /** The payer's payment number, or null where the portal has not matched one yet. */
  paymentNumber: string | null;
};

const splitRow = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

const iso = (raw: string | undefined): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((raw ?? "").trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/**
 * Read the summary export.
 *
 * "Not matched" in the payment column is the portal saying it has not tied the remittance to a
 * deposit yet; it is kept as null rather than as the string, because a null is a state and a
 * string that happens to read "Not matched" is a number waiting to be used by mistake.
 */
export function readRemitSummary(text: string): { rows: SummaryRow[]; problems: string[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], problems: ["The file is empty."] };

  const header = splitRow(lines[0]).map((h) => norm(h.replace(/^"|"$/g, "")));
  const at = (n: string) => header.indexOf(n);
  const iRemit = at("remitnumber");
  const iPayer = at("payername");
  const iDate = at("remitdate");
  const iAmt = at("remitamt");
  const iMatch = at("paymentmatch");
  if (iRemit < 0 || iAmt < 0) return { rows: [], problems: [`Not a remit summary: columns are ${header.join(", ")}.`] };

  const rows: SummaryRow[] = [];
  const problems: string[] = [];
  for (let r = 1; r < lines.length; r++) {
    const f = splitRow(lines[r]).map((s) => s.replace(/^"|"$/g, ""));
    const remitNumber = (f[iRemit] ?? "").trim();
    const raw = (f[iAmt] ?? "").replace(/[$,]/g, "").trim();
    if (!remitNumber || !/^-?\d*\.?\d+$/.test(raw)) {
      if (f.some((x) => x.length > 0)) problems.push(`Row ${r + 1} could not be read.`);
      continue;
    }
    const match = (f[iMatch] ?? "").trim();
    rows.push({
      remitNumber,
      payerName: (f[iPayer] ?? "").trim(),
      remitOn: iDate >= 0 ? iso(f[iDate]) : null,
      amountCents: Math.round(parseFloat(raw) * 100),
      paymentNumber: match && !/^not\s*matched$/i.test(match) ? match : null,
    });
  }
  return { rows, problems };
}
