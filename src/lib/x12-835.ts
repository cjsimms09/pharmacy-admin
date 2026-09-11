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
 * An 835 carries far more than this needs: forwarding balances, an entire remittance's worth of
 * accounting. This reads the part that answers one question — which prescription was paid how much,
 * by whom, and when — plus the three things that decide whether the answer is *complete*: the
 * adjustments taken off each claim (CAS), the money taken off the whole remittance (PLB), and the
 * arithmetic that ties them to the payment. Everything else is kept as the raw segment against the
 * payment so nothing is lost, and none of it is interpreted into a number this site will act on.
 *
 * ── Why the adjustments are read rather than skipped ──
 *
 * Helper B found the hole and it is money: `claim-payments.ts` banks BPR02, which is *net* of any
 * provider-level adjustment, while posting the claim payments, which are *gross*. Both figures are
 * individually right; the difference is the PLB, and it reached the books nowhere. Twenty claims
 * adjudicated at $4,000.00 with a $57.50 DIR fee bank $3,942.50, post $4,000.00, and lose $57.50
 * in silence. DIR is one of the largest deductions an independent faces and this happened on every
 * remittance carrying one.
 *
 * Worse than dropped: a PLB segment fell to the parse loop's default branch, which appends to the
 * open claim — so whole-remittance money was filed as raw text against whichever prescription
 * happened to be last in the file.
 *
 * So the file is now checked by arithmetic before anything can be stored from it, which is what
 * CLAUDE.md requires of every reader that decides money. Two identities close on a well-formed
 * remittance:
 *
 *     per claim:  CLP03 charged − CLP04 paid − CLP05 patient responsibility = the CAS amounts
 *     per file:   BPR02 paid = the CLP payments less the PLB adjustments
 *
 * The second is the one that matters: it proves the file was read completely. A remittance whose
 * file identity does not close is read and shown and reported as a problem, never posted — the
 * same rule the books follow when their own totals do not add up.
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
  /**
   * CLP07, the payer's own claim control number.
   *
   * Kept because it is the handle the payer answers to. Chasing an underpayment, appealing a MAC or
   * asking why a claim was denied, this is the number the help desk asks for — and it is the only
   * identifier on the remittance that the pharmacy did not supply itself.
   */
  controlNumber: string | null;
  /** Every CAS adjustment against this claim, one row per triplet. */
  adjustments: Adjustment[];
  /** The segments this payment was read from, kept verbatim. */
  raw: string[];
};

/**
 * One adjustment: a reason, an amount, and where it was taken.
 *
 * A CAS segment carries up to six of these, not one — CAS01 is the group code, and then
 * reason/amount/quantity repeats through CAS17/18/19. Read one per segment and five in six are
 * lost, which is the standard way this file format is got wrong.
 *
 * `loop` matters as much as the codes. A CAS in the claim loop and a CAS in the service loop for
 * the same reason are different money, and a reader that flattens them adds the same deduction
 * twice on exactly the files where a deduction is large enough to notice.
 */
export type Adjustment = {
  /** CAS01: CO contractual, PR patient responsibility, OA other, PI payer initiated. */
  groupCode: string;
  /** The reason code, as the payer prints it. Never interpreted here. */
  reasonCode: string;
  amountCents: number;
  /** The units the adjustment applies to, where one is given. */
  quantity: number | null;
  loop: "claim" | "service";
};

/**
 * One PLB: money taken off the whole remittance that belongs to no single claim.
 *
 * DIR fees, recoupments, transaction fees, interest, an overpayment being clawed back. It is real
 * money and it is the difference between what the claims say and what the bank receives, so it is
 * never allowed to disappear into a raw segment.
 *
 * The sign is the format's, not arithmetic's: a positive PLB amount *reduces* the payment. Kept as
 * printed, and `balance` below does the subtracting, so nothing here has to remember which way
 * round it goes.
 */
export type ProviderAdjustment = {
  /** PLB03-1: the reason code, such as "72" for an authorised return or "CS" for an adjustment. */
  reasonCode: string;
  /** PLB03-2: the payer's own reference for it — an invoice or recoupment number. */
  reference: string | null;
  /** As printed. Positive reduces what the payer sends. */
  amountCents: number;
  raw: string;
};

export type Remittance = {
  /** BPR02, what the whole remittance came to. */
  totalPaidCents: number | null;
  /** BPR16, the date the money moves. */
  paidOn: string | null;
  /** TRN02, the trace or cheque number — how the pharmacy finds it on a bank statement. */
  traceNumber: string | null;
  /** N1*PR: the payer as it prints its own name. Never matched to a payor by similarity. */
  payer: string | null;
  /** N1*PR's identification code — the payer id a claim was routed to, which the name is not. */
  payerId: string | null;
  payee: string | null;
  /** DTM*405 at the header: the day the remittance was produced, which is not the day it pays. */
  producedOn: string | null;
  payments: RemittancePayment[];
  /** Provider-level money, belonging to no claim and still owed an explanation. */
  providerAdjustments: ProviderAdjustment[];
  /**
   * Whether the file's own arithmetic closes, and by how much where it does not.
   *
   * Null where there is not enough to check — no BPR02, or no payment carried an amount. A
   * difference here is not a rounding: it is a segment that was not read, and nothing from this
   * file should be posted until it is nought.
   */
  balance: { paidCents: number; claimsCents: number; adjustmentsCents: number; differenceCents: number } | null;
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

/**
 * Every adjustment in one CAS segment.
 *
 * The format repeats reason/amount/quantity after the group code — CAS02/03/04, CAS05/06/07, and
 * so on through CAS17/18/19 — up to six times. A triplet with no reason or no amount is the end of
 * the list rather than a nought, so reading stops there.
 */
export function adjustmentsFrom(fields: string[], loop: "claim" | "service"): Adjustment[] {
  const groupCode = (fields[1] ?? "").trim().toUpperCase();
  if (!groupCode) return [];
  const out: Adjustment[] = [];
  for (let i = 2; i + 1 < fields.length && out.length < 6; i += 3) {
    const reasonCode = (fields[i] ?? "").trim();
    const amountCents = x12Cents(fields[i + 1]);
    if (!reasonCode || amountCents === null) break;
    const q = (fields[i + 2] ?? "").trim();
    out.push({ groupCode, reasonCode, amountCents, quantity: q && /^-?\d+(\.\d+)?$/.test(q) ? Number(q) : null, loop });
  }
  return out;
}

/**
 * One PLB segment's adjustments.
 *
 * PLB01 is the provider, PLB02 the fiscal period end, and then reason/amount repeats: PLB03 is a
 * composite of `<reason><component><reference>` and PLB04 its amount, through PLB13/PLB14. The
 * reference half is the payer's own handle for the deduction and is what a person quotes when they
 * ring up to ask what it was.
 */
export function providerAdjustmentsFrom(fields: string[], component: string, raw: string): ProviderAdjustment[] {
  const out: ProviderAdjustment[] = [];
  for (let i = 3; i + 1 < fields.length && out.length < 6; i += 2) {
    const parts = (fields[i] ?? "").split(component);
    const reasonCode = (parts[0] ?? "").trim();
    const amountCents = x12Cents(fields[i + 1]);
    if (!reasonCode || amountCents === null) break;
    out.push({ reasonCode, reference: (parts[1] ?? "").trim() || null, amountCents, raw });
  }
  return out;
}

/**
 * The pharmacy's own reference, back to the prescription and its fill.
 *
 * Two spellings arrive. A plan's 835 carries what was submitted, "332359-1" or "332359". The
 * Medicare Transaction Facilitator carries the number padded to twelve digits with the fill
 * spelled out, "000000332359FILL1" — and every one of its payments sat unmatched for three weeks
 * because that string was filed whole, so no claim could ever equal it. Leading zeros are dropped:
 * the claims report prints the number bare.
 */
export function splitReference(reference: string): { rxNumber: string; fillNumber: number | null } {
  const r = reference.trim();
  const dash = /^0*(\d+)\s*-\s*(\d+)$/.exec(r);
  if (dash) return { rxNumber: dash[1], fillNumber: Number(dash[2]) };
  const fill = /^0*(\d+)\s*FILL\s*(\d+)$/i.exec(r);
  if (fill) return { rxNumber: fill[1], fillNumber: Number(fill[2]) };
  const bare = /^0*(\d+)$/.exec(r);
  if (bare) return { rxNumber: bare[1], fillNumber: null };
  return { rxNumber: r, fillNumber: null };
}

/**
 * Reads a remittance.
 *
 * The delimiters are taken from the ISA segment rather than assumed, because they vary by sender
 * and a file split on the wrong character reads as one enormous unusable segment. Where there is no
 * ISA — the CLI writes files that begin at ST — the common defaults are used and that is stated.
 */
export function parse835(text: string): Remittance {
  const out: Remittance = {
    totalPaidCents: null,
    paidOn: null,
    traceNumber: null,
    payer: null,
    payerId: null,
    payee: null,
    producedOn: null,
    payments: [],
    providerAdjustments: [],
    balance: null,
    problems: [],
  };
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
  /*
   * Whether the service loop has opened for the claim in hand, which is what tells a service-level
   * CAS from a claim-level one. Tracked rather than inferred from the fields already read: the
   * service date arrives on a DTM that sits *before* SVC in most files, so using it as the proxy
   * would file every claim-level adjustment as a service-level one.
   */
  let inService = false;
  const push = () => {
    if (current) out.payments.push(current);
    current = null;
    inService = false;
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
        if ((f[1] ?? "").toUpperCase() === "PR") {
          out.payer = (f[2] ?? "").trim() || null;
          // N1*PR*<name>*XV*<id>. The id is the join; the name is four companies' typing.
          out.payerId = (f[4] ?? "").trim() || null;
        }
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
          controlNumber: (f[7] ?? "").trim() || null,
          adjustments: [],
          raw: [seg],
        };
        break;
      }
      case "SVC":
        if (current) {
          inService = true;
          current.raw.push(seg);
          current.ndc11 = current.ndc11 ?? ndcFromServiceId(f[1], component);
          // A single-line pharmacy claim repeats its money at service level; the claim total wins,
          // because that is the figure the remittance itself balances to.
          if (current.paidCents === null) current.paidCents = x12Cents(f[3]);
        }
        break;
      case "CAS":
        /*
         * The adjustments, in the loop they were taken in.
         *
         * A CAS reached before any CLP is not a claim's; there is nowhere for it to belong and
         * inventing one would attach a deduction to the wrong prescription, so it is reported.
         */
        if (current) {
          current.raw.push(seg);
          current.adjustments.push(...adjustmentsFrom(f, inService ? "service" : "claim"));
        } else {
          out.problems.push(`An adjustment appears before any claim payment, so there is nothing for it to belong to: ${seg.slice(0, 120)}`);
        }
        break;
      case "PLB":
        /*
         * Provider-level money, and the segment that used to be filed against a stranger.
         *
         * PLB comes after the last claim loop, and the open payment was still open — so the
         * default branch appended a whole remittance's DIR fee to whichever prescription happened
         * to be last in the file. Closing the payment first is the fix; keeping the amounts is the
         * point.
         */
        push();
        out.providerAdjustments.push(...providerAdjustmentsFrom(f, component, seg));
        break;
      case "DTM":
        if (current) {
          current.raw.push(seg);
          // 472 is the service date; 232 and 233 bracket a period and are not one date.
          if ((f[1] ?? "").trim() === "472") current.serviceDate = x12Date(f[2]);
          else if (!current.serviceDate && (f[1] ?? "").trim() === "232") current.serviceDate = x12Date(f[2]);
        } else if ((f[1] ?? "").trim() === "405") {
          // The header's production date, which arrives before the first claim and was dropped by
          // the guard above. It is not the day the money moves — BPR16 is that — and the two differ.
          out.producedOn = x12Date(f[2]);
        }
        break;
      case "SE":
        push();
        break;
      default:
        /*
         * An unread segment is not kept, because one of them names the patient.
         *
         * This used to be `if (current) current.raw.push(seg)` — a catch-all that swept every
         * segment inside a claim loop into `raw`. NM1 sits inside that loop, and NM1*QC carries the
         * member's surname, first name and member id. So every payment object this parser returned
         * held a patient identifier, verbatim.
         *
         * Nothing stored it: `importRemittance` records the prescription, the NDC, the amounts, the
         * payer and the trace number, and never touches `raw`. No name has reached the database. But
         * the owner's rule is not "do not store names", it is — 11 September 2026 — "i do not want
         * the site to get patient names.. or at least to retain them." A name sitting in a live
         * object is one log line, one error report, one JSON.stringify away from being retained, and
         * it was being carried for nothing: no code outside this file reads `raw`.
         *
         * So `raw` now holds only what the parser understands — CLP, SVC, CAS and DTM — none of
         * which names a person. Everything else is read for its meaning where it has one, and
         * otherwise dropped, which is where a patient's name belongs.
         */
        break;
    }
  }
  push();

  if (out.payments.length === 0 && out.problems.length === 0) {
    out.problems.push("No claim payments were found in this file. It may be an acknowledgement rather than a remittance.");
  }

  /*
   * The arithmetic that says the file was read completely.
   *
   * BPR02 is what the payer is sending. The claim payments are gross; the provider-level
   * adjustments are what it kept back. If those three do not close, a segment was not read — and
   * the difference is money, because banking BPR02 while posting the claims gross is exactly how
   * $57.50 of DIR fee disappears without anything noticing.
   *
   * Reported rather than thrown. The remittance is still worth showing; it is only not worth
   * posting, and the difference names itself so somebody can see what is missing.
   */
  const amounts = out.payments.map((p) => p.paidCents).filter((c): c is number => c !== null);
  if (out.totalPaidCents !== null && amounts.length > 0) {
    const claimsCents = amounts.reduce((n, c) => n + c, 0);
    const adjustmentsCents = out.providerAdjustments.reduce((n, a) => n + a.amountCents, 0);
    const differenceCents = out.totalPaidCents - (claimsCents - adjustmentsCents);
    out.balance = { paidCents: out.totalPaidCents, claimsCents, adjustmentsCents, differenceCents };
    if (differenceCents !== 0) {
      out.problems.push(
        `This remittance does not add up and nothing from it should be posted: it pays $${(out.totalPaidCents / 100).toFixed(2)}, ` +
          `its ${amounts.length} claim payment${amounts.length === 1 ? "" : "s"} come to $${(claimsCents / 100).toFixed(2)}, ` +
          `and the provider-level adjustments take off $${(adjustmentsCents / 100).toFixed(2)} — ` +
          `leaving $${(Math.abs(differenceCents) / 100).toFixed(2)} ${differenceCents > 0 ? "more paid than the claims explain" : "unaccounted for"}. ` +
          "A segment was not read, and the difference is money.",
      );
    }
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
