import { splitRow } from "./pioneer-catalog";

/**
 * The Aytu / IPD credit memo: top-off money for the RxRescue programme, paid weeks after the fill.
 *
 * A claim on this programme (BIN 024284, PCN ACR) adjudicates for whatever the primary plan will
 * pay, and the rest arrives later as a credit — the top-off that brings the pharmacy up to the
 * agreed price, plus whatever assistance covered the patient's share. Until that credit is applied
 * the fill reads as a loss, exactly like a facilitator payment does: on one real fortnight it is
 * $9,500 of money the site would otherwise have shown as gone.
 *
 * It reconciles on the prescription, the drug and the day it was dispensed. The memo carries no
 * fill number, so the match has to survive that.
 *
 * Pure, so a memo can be checked against the page it came from by hand.
 */

export type CreditRow = {
  /** Unique per line, and the thing that stops a memo sent twice being counted twice. */
  transactionId: string;
  /** Zero-padded in the file ("000000333801"); the pharmacy's own number is what claims hold. */
  rxNumber: string;
  groupNumber: string | null;
  ndc11: string | null;
  productName: string | null;
  /** The day it was dispensed, which is how it joins a fill. */
  transactionDate: string | null;
  occCode: string | null;
  quantityThousandths: number | null;
  /** Blank where the memo did not say, which is not the same as nothing paid. */
  primaryPayerReimbCents: number | null;
  patientOopCents: number | null;
  topOffCents: number | null;
  finalPatientPayCents: number | null;
  copayAssistCents: number | null;
  dispensingFeeCents: number | null;
  /** What the pharmacy is actually paid for this line. The only figure that becomes money here. */
  totalCreditCents: number | null;
  memoId: string | null;
  issuedOn: string | null;
};

export type CreditMemo = {
  rows: CreditRow[];
  memoId: string | null;
  issuedOn: string | null;
  /** The days the fills fall across, which is what the memo actually covers. */
  period: { from: string; to: string } | null;
  totalCreditCents: number;
  problems: string[];
};

const HEADERS = ["Transaction ID", "Rx Number", "RxRescue Top Off Amount/Credit", "Total Credit Payment to Pharmacy"];

export function looksLikeRxRescueCredit(text: string, fileName = ""): boolean {
  const head = text.replace(/^﻿/, "").slice(0, 2000);
  if (HEADERS.filter((h) => head.includes(h)).length >= 3) return true;
  return /credit[_ -]*memo/i.test(fileName) && /rxrescue|aytu|top\s*off/i.test(head + fileName);
}

const cents = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim().replace(/[$,]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (t === "" || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

const thousandths = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
};

const date = (s: string | undefined): string | null => {
  const t = (s ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/** "000000333801" is the pharmacy's Rx 333801. Claims hold it unpadded, so the join needs it so. */
export function unpadRx(s: string): string {
  const t = s.trim().replace(/^0+/, "");
  return t === "" ? s.trim() : t;
}

export function parseRxRescueCredit(text: string): CreditMemo {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const problems: string[] = [];
  if (lines.length === 0) return { rows: [], memoId: null, issuedOn: null, period: null, totalCreditCents: 0, problems: ["The file is empty."] };

  const header = splitRow(lines[0], ",").map((h) => h.trim());
  const at = (name: string) => header.indexOf(name);
  const need = ["Transaction ID", "Rx Number", "Total Credit Payment to Pharmacy"];
  const missing = need.filter((n) => at(n) < 0);
  if (missing.length) {
    return {
      rows: [],
      memoId: null,
      issuedOn: null,
      period: null,
      totalCreditCents: 0,
      problems: [`This does not look like an RxRescue credit memo — it has no ${missing.join(", ")} column.`],
    };
  }

  /*
   * Columns are taken by name, because this file has a proper header and there is no reason to
   * count positions when the names are right there. A column that moves is then a non-event.
   */
  const rows: CreditRow[] = [];
  for (const line of lines.slice(1)) {
    const c = splitRow(line, ",").map((x) => x.trim());
    const id = c[at("Transaction ID")];
    if (!id) continue;
    const get = (name: string) => (at(name) < 0 ? undefined : c[at(name)]);

    const topOffCents = cents(get("RxRescue Top Off Amount/Credit"));
    const copayAssistCents = cents(get("Pt Copay Asst"));
    const totalCreditCents = cents(get("Total Credit Payment to Pharmacy"));

    /*
     * The memo checking itself: the credit is the top-off plus the copay assistance.
     *
     * It holds on every line of the real memo, which makes it worth insisting on — a column read
     * from the wrong place would give a plausible payment, and a payment applied to a claim is not
     * something anybody re-checks afterwards.
     */
    if (topOffCents !== null && copayAssistCents !== null && totalCreditCents !== null) {
      if (Math.abs(topOffCents + copayAssistCents - totalCreditCents) > 2) {
        problems.push(
          `Line ${id.slice(0, 8)} does not add up: top-off ${topOffCents / 100} plus assistance ${copayAssistCents / 100} is not the ${totalCreditCents / 100} credited.`,
        );
      }
    }

    rows.push({
      transactionId: id,
      rxNumber: unpadRx(get("Rx Number") ?? ""),
      groupNumber: get("Processing Group Number")?.trim() || null,
      ndc11: (get("NDC") ?? "").replace(/\D/g, "").length === 11 ? (get("NDC") ?? "").replace(/\D/g, "") : null,
      productName: get("Product Name")?.trim() || null,
      transactionDate: date(get("Transaction Date")),
      occCode: get("OCC Code")?.trim() || null,
      quantityThousandths: thousandths(get("Qty Dispensed")),
      primaryPayerReimbCents: cents(get("Primary Payer Reimb")),
      patientOopCents: cents(get("Pt Out of Pocket")),
      topOffCents,
      finalPatientPayCents: cents(get("Final Patient Pay/ OOP")),
      copayAssistCents,
      dispensingFeeCents: cents(get("Dispensing Fee")),
      totalCreditCents,
      memoId: get("Credit Memo ID")?.trim() || null,
      issuedOn: date(get("Credit Memo Issue Date")),
    });
  }

  const dates = rows.map((r) => r.transactionDate).filter((d): d is string => d !== null).sort();
  return {
    rows,
    memoId: rows.find((r) => r.memoId)?.memoId ?? null,
    issuedOn: rows.find((r) => r.issuedOn)?.issuedOn ?? null,
    period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    totalCreditCents: rows.reduce((n, r) => n + (r.totalCreditCents ?? 0), 0),
    problems,
  };
}
