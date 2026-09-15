/**
 * The Health Mart Atlas "AccessHealth Payment Data" PDF: one EFT, and every claim payment and adjustment inside it.
 *
 * Health Mart Atlas pays the pharmacy's plan money through ProviderPay one EFT at a time, and the EFT notice and the
 * portal's payer payment report bank that deposit (payer-payments-store.ts). What neither says is what the deposit is
 * made of. This report does: the EFT number and its total, then one section per plan, each claim the plan paid or took
 * back, and the remittance-level adjustments the plan held back, section by section.
 *
 * ── The layout, from the nine real reports of 31 August to 11 September 2026 ──
 *
 *   Sep 04, 2026
 *   EFT-00000000Total Paid: $37909.27
 *   <plan name>
 *   Fill DateRx NumberBilledAllowedDisp. FeeTaxCo-PayAmountRej.
 *   08/05/26000000       647.93       510.69         0.00         0.00        40.00       470.69
 *   08/07/26000000      1461.88         0.00         0.00         0.00         0.00         0.0070        ← rejection code 70
 *   12/31/26Adj-CS0000000         0.00        -0.33         0.00         0.00         0.00        -0.33 ← an adjustment
 *   Paid claims: 223Paid Amount: $7477.51
 *
 * The text layer runs fields together. The fill date's two-digit year is followed directly by the prescription number,
 * and a rejection code directly follows the amount's cents. A page break repeats the column line with no plan name
 * above it, which continues the section rather than starting one.
 *
 * ── What holds it together, measured on all nine ──
 *
 *   a section's Paid Amount = its claim rows' amounts + its adjustments;
 *   a section's Paid claims = its claim rows + its adjustment rows;
 *   the EFT's Total Paid    = the sections' Paid Amounts.
 *
 * All nine close to the cent under those three rules and under no other reading tried. A report that does not close is
 * refused whole: a claim payment read from a half-read EFT is worse than one not read, because only the second is
 * visibly missing.
 *
 * Pure.
 */

export type AhClaimRow = {
  fillDate: string;
  rxNumber: string;
  billedCents: number;
  allowedCents: number;
  dispensingFeeCents: number;
  taxCents: number;
  copayCents: number;
  /** What the plan paid on this claim in this EFT. Negative where it took money back. */
  amountCents: number;
  /** The rejection code printed after the amount, where there is one. */
  rejection: string | null;
};

export type AhAdjustment = {
  /** As printed. The reports print 12/31 of the year for every one seen. */
  on: string;
  /** The two-character code the report's own glossary names (AH, CS, WU, …). */
  code: string;
  /** Anything after the code: a sub-code ("-02") and the plan's reference. */
  reference: string | null;
  amountCents: number;
};

export type AhSection = {
  plan: string;
  claims: AhClaimRow[];
  adjustments: AhAdjustment[];
  statedClaims: number;
  statedPaidCents: number;
};

export type AccessHealthPayment = {
  eftNumber: string;
  paidOn: string;
  totalPaidCents: number;
  ncpdp: string | null;
  sections: AhSection[];
  claimRows: number;
  adjustmentCents: number;
  says: string;
};

export type AccessHealthRead = { ok: true; report: AccessHealthPayment } | { ok: false; why: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COLUMNS = /^Fill Date\s*Rx Number\s*Billed\s*Allowed\s*Disp\.?\s*Fee\s*Tax\s*Co-?Pay\s*Amount\s*Rej\.?$/i;
const M = String.raw`(-?[\d,]*\d\.\d{2})`;
const CLAIM = new RegExp(String.raw`^(\d{2})\/(\d{2})\/(\d{2})(\d{4,9})\s+${M}\s+${M}\s+${M}\s+${M}\s+${M}\s+(-?[\d,]*\d\.\d{2})(\S*)$`);
const ADJUSTMENT = new RegExp(String.raw`^(\d{2})\/(\d{2})\/(\d{2})Adj-([A-Z0-9]{2})(\S*)\s+${M}\s+${M}\s+${M}\s+${M}\s+${M}\s+${M}$`);
const FOOTER = /^Paid claims:\s*(\d+)\s*Paid Amount:\s*(-?)\$?(-?)([\d,]+\.\d{2})$/i;
const PAGE = /Page \d+ of$/i;

/** Dollars as text to cents, without floating point. */
function cents(s: string): number {
  const t = s.replace(/[$,]/g, "");
  const m = /^(-?)(\d*)\.(\d{2})$/.exec(t);
  if (!m) return NaN;
  const v = Number(m[2] || "0") * 100 + Number(m[3]);
  return m[1] === "-" ? -v : v;
}
const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The adjustments this site books, and the ones it holds, for one report.
 *
 * Agreed with session 1 (money map section 12): an **AH — Origination Fee** is a fee the network keeps back from the
 * plans' money, so it reduces what the prescriptions earned. It is a revenue offset on the accrual account, in the
 * EFT's month, the treatment DIR fees get. On the cash account nothing is booked, because the deposit is already net
 * of it. Every other code is held, named, until its meaning is settled (CS waits on the owner, Q-AH-1).
 *
 * Keyed on the EFT, the code and the report's reference, so a report read twice books nothing twice. Two AH rows with
 * the same reference in one EFT are told apart by their order, `#2` onwards.
 */
export type AhPosting = { key: string; code: string; plan: string; on: string; amountCents: number; description: string };
export type AhHeld = { code: string; plan: string; reference: string | null; amountCents: number };

export function adjustmentPostings(report: AccessHealthPayment): { post: AhPosting[]; held: AhHeld[] } {
  const post: AhPosting[] = [];
  const held: AhHeld[] = [];
  const seen = new Map<string, number>();
  for (const s of report.sections) {
    for (const a of s.adjustments) {
      if (a.code !== "AH") {
        held.push({ code: a.code, plan: s.plan, reference: a.reference, amountCents: a.amountCents });
        continue;
      }
      const base = `AHADJ|${report.eftNumber}|AH|${a.reference ?? "-"}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      post.push({
        key: n === 1 ? base : `${base}#${n}`,
        code: a.code,
        plan: s.plan,
        on: report.paidOn,
        /* The report prints the fee as money taken away; as a revenue offset it is entered as a positive charge. */
        amountCents: -a.amountCents,
        description: `Health Mart Atlas origination fee on ${report.eftNumber} (${s.plan})`,
      });
    }
  }
  return { post, held };
}

export function looksLikeAccessHealthPayment(text: string): boolean {
  return /Health Mart Atlas/.test(text) && /EFT-\d+\s*Total Paid:/i.test(text) && /Fill Date\s*Rx Number\s*Billed\s*Allowed/i.test(text);
}

export function readAccessHealthPayment(text: string, ownNcpdp: string | null = null): AccessHealthRead {
  if (!looksLikeAccessHealthPayment(text)) return { ok: false, why: "Not a Health Mart Atlas AccessHealth payment report." };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const head = lines.map((l) => /^EFT-(\d+)\s*Total Paid:\s*(-?)\$?([\d,]+\.\d{2})$/i.exec(l)).find(Boolean);
  const dated = lines.map((l) => /^([A-Z][a-z]{2}) (\d{2}), (\d{4})$/.exec(l)).find(Boolean);
  if (!head) return { ok: false, why: "The report's EFT number and Total Paid could not be read." };
  if (!dated || !MONTHS.includes(dated[1])) return { ok: false, why: `EFT-${head[1]}: the report's date could not be read.` };
  const eftNumber = `EFT-${head[1]}`;
  const paidOn = `${dated[3]}-${String(MONTHS.indexOf(dated[1]) + 1).padStart(2, "0")}-${dated[2]}`;
  const totalPaidCents = (head[2] === "-" ? -1 : 1) * cents(head[3]);
  const ncpdp = lines.map((l) => /\((\d{7})\)$/.exec(l)).find(Boolean)?.[1] ?? null;
  if (ownNcpdp && ncpdp && ncpdp !== ownNcpdp) return { ok: false, why: `${eftNumber} was paid to NCPDP ${ncpdp}, not this pharmacy's ${ownNcpdp}. Nothing was read.` };

  const problems: string[] = [];
  const sections: (AhSection & { closed: boolean })[] = [];
  let current: (AhSection & { closed: boolean }) | null = null;
  let previous = "";
  /*
   * The plan a section belongs to.
   *
   * Every plan name is printed twice: above its section, and again straight after its own Paid claims line. So after
   * a footer the text runs "<plan just ended>", "<next plan>", and the column line follows, sometimes with a page
   * footer in between (three of the nine real reports break a page exactly there). The name is therefore the last text
   * line since the previous footer, page footers skipped. Never the line directly above the column line, which is
   * the page footer whenever a new plan starts a page.
   */
  let pendingName: string | null = null;
  const pageLine = (s: string) => PAGE.test(s) || /^\d+$/.test(s);

  for (const line of lines) {
    if (COLUMNS.test(line)) {
      /* A page break inside a plan repeats the column line under the page footer: the same plan, carried on. */
      if (!(current && !current.closed && pageLine(previous))) {
        const plan = pendingName;
        if (!plan) problems.push("a section of claims begins with no plan name before it");
        else if (current && current.closed && plan === current.plan) problems.push(`a new section repeats the name of the ${plan} section just closed`);
        current = { plan: plan ?? "(unnamed plan)", claims: [], adjustments: [], statedClaims: -1, statedPaidCents: 0, closed: false };
        sections.push(current);
        pendingName = null;
      }
    } else if (CLAIM.test(line)) {
      const m = CLAIM.exec(line)!;
      if (!current || current.closed) {
        problems.push("claim rows appear outside any plan section");
        continue;
      }
      const fig = [m[5], m[6], m[7], m[8], m[9], m[10]].map(cents);
      if (fig.some(Number.isNaN)) {
        problems.push("a claim row has a figure that could not be read");
        continue;
      }
      current.claims.push({
        fillDate: `20${m[3]}-${m[1]}-${m[2]}`,
        rxNumber: m[4],
        billedCents: fig[0],
        allowedCents: fig[1],
        dispensingFeeCents: fig[2],
        taxCents: fig[3],
        copayCents: fig[4],
        amountCents: fig[5],
        rejection: m[11] || null,
      });
    } else if (ADJUSTMENT.test(line)) {
      const m = ADJUSTMENT.exec(line)!;
      if (!current || current.closed) {
        problems.push("an adjustment appears outside any plan section");
        continue;
      }
      current.adjustments.push({ on: `20${m[3]}-${m[1]}-${m[2]}`, code: m[4], reference: m[5] || null, amountCents: cents(m[11]) });
    } else if (FOOTER.test(line)) {
      const m = FOOTER.exec(line)!;
      if (!current || current.closed) {
        problems.push("a section total appears with no section above it");
        continue;
      }
      current.statedClaims = Number(m[1]);
      current.statedPaidCents = (m[2] || m[3] ? -1 : 1) * cents(m[4]);
      current.closed = true;
    } else if (/^\d{1,2}\/\d{1,2}\/\d{2}/.test(line) && !PAGE.test(line)) {
      /* Anything else that starts like a row is a row this reader does not understand, and says so. */
      problems.push("a line that starts like a claim row could not be read");
    } else if (!pageLine(line)) {
      pendingName = line;
    }
    previous = line;
  }

  if (sections.length === 0) problems.push("no plan sections were found");
  for (const s of sections) {
    if (!s.closed) {
      problems.push(`the ${s.plan} section has no Paid claims / Paid Amount line`);
      continue;
    }
    const paid = s.claims.reduce((n, c) => n + c.amountCents, 0) + s.adjustments.reduce((n, a) => n + a.amountCents, 0);
    if (paid !== s.statedPaidCents) problems.push(`the ${s.plan} section's rows come to ${money(paid)} against its Paid Amount of ${money(s.statedPaidCents)}`);
    if (s.claims.length + s.adjustments.length !== s.statedClaims) problems.push(`the ${s.plan} section holds ${s.claims.length + s.adjustments.length} rows against its Paid claims of ${s.statedClaims}`);
  }
  const sectionsCents = sections.reduce((n, s) => n + s.statedPaidCents, 0);
  if (sections.length && sectionsCents !== totalPaidCents) problems.push(`the sections come to ${money(sectionsCents)} against the EFT's Total Paid of ${money(totalPaidCents)}`);

  if (problems.length) {
    const unique = [...new Set(problems)];
    return { ok: false, why: `${eftNumber} (${paidOn}, ${money(totalPaidCents)}) does not hold together: ${unique.slice(0, 5).join("; ")}${unique.length > 5 ? `; and ${unique.length - 5} more` : ""}. Nothing was read from it.` };
  }

  const claimRows = sections.reduce((n, s) => n + s.claims.length, 0);
  const adjustmentCents = sections.reduce((n, s) => n + s.adjustments.reduce((k, a) => k + a.amountCents, 0), 0);
  return {
    ok: true,
    report: {
      eftNumber,
      paidOn,
      totalPaidCents,
      ncpdp,
      sections: sections.map(({ closed: _closed, ...s }) => s),
      claimRows,
      adjustmentCents,
      says:
        `Health Mart Atlas ${eftNumber} of ${paidOn}: ${money(totalPaidCents)} from ${sections.length} plan${sections.length === 1 ? "" : "s"}, ` +
        `${claimRows} claim row${claimRows === 1 ? "" : "s"}${adjustmentCents ? ` and ${money(adjustmentCents)} of remittance-level adjustments` : ""}. Every section and the total add up.`,
    },
  };
}
