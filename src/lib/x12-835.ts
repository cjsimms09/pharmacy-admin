/**
 * Reading an 835 remittance: what was paid, on which prescription, by whom.
 *
 * This is what the Medicare Transaction Facilitator's CLI downloads, and what every payer sends
 * when it settles. Until now the money in these files reached the pharmacy's bank and nothing here
 * knew about it — so a fill that a facilitator paid $146.18 on weeks later sat on the "dispensed at
 * a loss" list for ever, and the plan that underpaid it was judged on money it never sent.
 *
 * ── What is read, and what is deliberately not ──
 *
 * An 835 carries far more than this needs: adjustment reason codes, provider-level adjustments,
 * forwarding balances, an entire remittance's worth of accounting. This reads the part that answers
 * one question — which prescription was paid how much, by whom, and when — because that is what can
 * be matched to a fill and checked. Everything else is kept as the raw segment against the payment
 * so nothing is lost, and none of it is interpreted into a number this site will act on.
 *
 * ── Pharmacy 835s in particular ──
 *
 * CLP01 is the claim submitter's own identifier, which for a pharmacy claim is the prescription
 * number, sometimes with the fill appended. SVC01 carries the product as `N4:<NDC>`. That pair is
 * what lets a payment find its fill; a remittance that carries neither is reported as unmatchable
 * rather than attached to a guess.
 *
 * Pure. No database, no file system: the text goes in and the payments come out, so a real
 * remittance can be run through it and checked line by line.
 */

export type RemittancePayment = {
  /** CLP01, the pharmacy's own reference: the prescription number as submitted. */
  reference: string;
  rxNumber: string;
  fillNumber: number | null;
  /** CLP02: 1 processed as primary, 4 denied, 22 reversal of a previous payment, and so on. */
  statusCode: string;
  chargedCents: number | null;
  paidCents: number | null;
  patientResponsibilityCents: number | null;
  ndc11: string | null;
  /** DTM 472, the date the prescription was dispensed. */
  serviceDate: string | null;
  /** The segments this payment was read from, kept verbatim. */
  raw: string[];
};

export type Remittance = {
  /** BPR02, what the whole remittance came to. */
  totalPaidCents: number | null;
  /** BPR16, the date the money moves. */
  paidOn: string | null;
  /** TRN02, the trace or cheque number — how the pharmacy finds it on a bank statement. */
  traceNumber: string | null;
  payer: string | null;
  payee: string | null;
  payments: RemittancePayment[];
  /** Anything that looked like a payment but could not be read into one, quoted. */
  problems: string[];
};

/** "20260905" to "2026-09-05". Anything else is null rather than a guessed date. */
export function x12Date(s: string | undefined): string | null {
  const t = (s ?? "").trim();
  if (!/^\d{8}$/.test(t)) return null;
  const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** X12 money is decimal dollars. "146.18" to 14618, and a negative stays negative. */
export function x12Cents(s: string | undefined): number | null {
  const t = (s ?? "").trim();
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/**
 * "N4:00074433902" or "N4:00074-4339-02" to an eleven-digit NDC.
 *
 * The qualifier is checked rather than assumed: SVC01 can carry a HCPCS or a revenue code, and a
 * five-digit procedure code read as an NDC would attach a payment to the wrong drug.
 */
export function ndcFromServiceId(svc01: string | undefined, sub = ":"): string | null {
  const parts = (svc01 ?? "").split(sub);
  if (parts.length < 2) return null;
  if (parts[0].trim().toUpperCase() !== "N4") return null;
  const digits = parts[1].replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

/** "1234567-02" or "1234567" to the prescription and its fill. */
export function splitReference(reference: string): { rxNumber: string; fillNumber: number | null } {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(reference.trim());
  if (m) return { rxNumber: m[1], fillNumber: Number(m[2]) };
  return { rxNumber: reference.trim(), fillNumber: null };
}

/**
 * Reads a remittance.
 *
 * The delimiters are taken from the ISA segment rather than assumed, because they vary by sender
 * and a file split on the wrong character reads as one enormous unusable segment. Where there is no
 * ISA — the CLI writes files that begin at ST — the common defaults are used and that is stated.
 */
export function parse835(text: string): Remittance {
  const out: Remittance = { totalPaidCents: null, paidOn: null, traceNumber: null, payer: null, payee: null, payments: [], problems: [] };
  const body = text.replace(/^﻿/, "");
  if (!body.trim()) {
    out.problems.push("The file is empty.");
    return out;
  }

  // ISA is fixed-width: the element separator is its fourth character, the component separator its
  // 105th, and the segment terminator the one after that.
  let element = "*";
  let component = ":";
  let terminator = "~";
  const isa = body.indexOf("ISA");
  if (isa >= 0 && body.length > isa + 106) {
    element = body[isa + 3];
    component = body[isa + 104];
    terminator = body[isa + 105];
  }

  const segments = body
    .split(new RegExp(`[${escapeForClass(terminator)}\\r\\n]+`))
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    out.problems.push("No segments could be read — the file may not be an 835, or its delimiters are unusual.");
    return out;
  }

  let current: RemittancePayment | null = null;
  const push = () => {
    if (current) out.payments.push(current);
    current = null;
  };

  for (const seg of segments) {
    const f = seg.split(element);
    const tag = (f[0] ?? "").trim().toUpperCase();

    switch (tag) {
      case "BPR":
        out.totalPaidCents = x12Cents(f[2]);
        out.paidOn = x12Date(f[16]);
        break;
      case "TRN":
        out.traceNumber = (f[2] ?? "").trim() || null;
        break;
      case "N1":
        // PR is the payer, PE the payee. Anything else on an 835 is not one of the two parties.
        if ((f[1] ?? "").toUpperCase() === "PR") out.payer = (f[2] ?? "").trim() || null;
        if ((f[1] ?? "").toUpperCase() === "PE") out.payee = (f[2] ?? "").trim() || null;
        break;
      case "CLP": {
        push();
        const reference = (f[1] ?? "").trim();
        if (!reference) {
          out.problems.push(`A claim payment carries no reference of ours, so it cannot be matched: ${seg.slice(0, 120)}`);
          break;
        }
        const { rxNumber, fillNumber } = splitReference(reference);
        current = {
          reference,
          rxNumber,
          fillNumber,
          statusCode: (f[2] ?? "").trim(),
          chargedCents: x12Cents(f[3]),
          paidCents: x12Cents(f[4]),
          patientResponsibilityCents: x12Cents(f[5]),
          ndc11: null,
          serviceDate: null,
          raw: [seg],
        };
        break;
      }
      case "SVC":
        if (current) {
          current.raw.push(seg);
          current.ndc11 = current.ndc11 ?? ndcFromServiceId(f[1], component);
          // A single-line pharmacy claim repeats its money at service level; the claim total wins,
          // because that is the figure the remittance itself balances to.
          if (current.paidCents === null) current.paidCents = x12Cents(f[3]);
        }
        break;
      case "DTM":
        if (current) {
          current.raw.push(seg);
          // 472 is the service date; 232 and 233 bracket a period and are not one date.
          if ((f[1] ?? "").trim() === "472") current.serviceDate = x12Date(f[2]);
          else if (!current.serviceDate && (f[1] ?? "").trim() === "232") current.serviceDate = x12Date(f[2]);
        }
        break;
      case "SE":
        push();
        break;
      default:
        if (current) current.raw.push(seg);
    }
  }
  push();

  if (out.payments.length === 0 && out.problems.length === 0) {
    out.problems.push("No claim payments were found in this file. It may be an acknowledgement rather than a remittance.");
  }
  return out;
}

const escapeForClass = (c: string) => c.replace(/[\\\]^-]/g, "\\$&");

/**
 * Which payments are worth recording, and why the rest are not.
 *
 * A denial pays nothing and a zero payment moves no money; recording either as revenue would put a
 * row against a fill saying money arrived when none did. A reversal is real and negative, and is
 * kept — it takes back a payment that was counted.
 */
export function payableOnly(r: Remittance): { keep: RemittancePayment[]; skipped: { reference: string; why: string }[] } {
  const keep: RemittancePayment[] = [];
  const skipped: { reference: string; why: string }[] = [];
  for (const p of r.payments) {
    if (p.paidCents === null) {
      skipped.push({ reference: p.reference, why: "no payment amount could be read" });
      continue;
    }
    if (p.paidCents === 0) {
      skipped.push({ reference: p.reference, why: p.statusCode === "4" ? "denied — nothing was paid" : "paid nothing" });
      continue;
    }
    keep.push(p);
  }
  return { keep, skipped };
}
