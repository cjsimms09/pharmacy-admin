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
