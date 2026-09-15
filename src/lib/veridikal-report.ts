/**
 * Veridikal's monthly client summaries: the eVoucher Program and the Denial Conversion Activity workbooks.
 *
 * Veridikal Technologies runs manufacturer programmes that pay the pharmacy after the plan has adjudicated: an
 * **eVoucher** covers part of the patient's copay, and a **denial conversion** has a manufacturer pay the ingredient cost
 * of a claim the plan denied. It pays in one ACH per batch ("VERIDIKAL TECHNO/ACH Pmt VT - <batch date>"), and these
 * workbooks are what that ACH is made of: one row per claim, with a totals row.
 *
 * ── What the owner's July samples showed (money map section 15) ──
 *
 *   every money column adds to the totals row;
 *   Total Due to Pharmacy is, on every row,
 *     eVoucher:          Voucher Amount + eVoucher Fee            (and Voucher Amount = Original 3rd Party Copay − Patient Out Of Pocket)
 *     Denial Conversion: Ing Cost Pd by Manufacturer + Denial Conversion Fee
 *   so the fees are paid **to** the pharmacy;
 *   the report's Total Due equals its Veridikal bank credit to the cent;
 *   the Deposit Date (an Excel date number) is Veridikal's batch date, printed in the bank line, not the bank's date;
 *   a month tab and a "Total" tab carry the same rows;
 *   an unnamed column holds a number distinct on every row: Veridikal's own transaction number.
 *
 * Every one of those is checked on every report, and a report that fails any is refused whole. The Fax Admin Fee was
 * nought on every sample row, so whether it is added or taken away is unknown: a row with one is refused until a
 * report shows it.
 *
 * Pure.
 */

import { excelSerialToIso } from "./xlsx";

export type VeridikalProgram = "evoucher" | "denial_conversion";

export type VeridikalRow = {
  /** Veridikal's own number for the row: the re-read key. */
  transaction: string;
  nabp: string | null;
  bin: string | null;
  pcn: string | null;
  groupId: string | null;
  fillDate: string;
  /** Leading zeros removed, as the claims hold it. */
  rxNumber: string;
  ndc11: string | null;
  /** Veridikal's batch date. */
  depositOn: string;
  /** The voucher (eVoucher) or the manufacturer's ingredient payment (Denial Conversion): what the programme owed for the claim. */
  paymentCents: number;
  /** Paid to the pharmacy for handling the claim. */
  feeCents: number;
  /** payment + fee. */
  totalDueCents: number;
  patientOutOfPocketCents: number;
  /** eVoucher only: what Veridikal expects the plan to pay, and the plan's copay before the voucher. Null on Denial Conversion. */
  thirdPartyDueCents: number | null;
  originalCopayCents: number | null;
};

/** The claim fields a row is checked against. */
export type ClaimForCheck = { remitCents: number | null; evoucherCents: number | null; copayCents: number | null; patientTotalCents: number | null };

export type RowCheck = { compared: boolean; agrees: boolean; differences: { what: string; reportCents: number; claimCents: number }[] };

/**
 * One row against the claim it settles, which is the owner's check: *"the veridikal report shows how much we should be
 * expecting from the primary payor as well, this should match what we show from claims."*
 *
 *   eVoucher           Total Due From Third Party = the plan's share (remit less voucher, money map section 15)
 *                      Original 3rd Party Copay   = the claim's copay, as the plan adjudicated it
 *                      Patient Out Of Pocket      = what the claim says the patient was left owing
 *                      Voucher Amount             = the claim's voucher
 *   Denial Conversion  the plan's share is nought, and the remit is the manufacturer's ingredient payment
 *                      Patient Out Of Pocket      = what the claim says the patient was left owing
 *
 * A reversal row (negative) is not compared: it takes back an earlier row, and the claim it reverses may already be
 * reversed on the site. A disagreement never refuses the report — it is still Veridikal's statement of what it paid —
 * but it means the claim or the plan's expected payment is wrong, so it is said.
 */
export function checkRowAgainstClaim(program: VeridikalProgram, row: VeridikalRow, claim: ClaimForCheck): RowCheck {
  if (row.paymentCents < 0 || row.totalDueCents < 0) return { compared: false, agrees: true, differences: [] };
  const remit = claim.remitCents ?? 0;
  const voucher = claim.evoucherCents ?? 0;
  const differences: RowCheck["differences"] = [];
  const check = (what: string, reportCents: number | null, claimCents: number) => {
    if (reportCents !== null && reportCents !== claimCents) differences.push({ what, reportCents, claimCents });
  };
  if (program === "evoucher") {
    check("the plan's expected payment", row.thirdPartyDueCents, remit - voucher);
    check("the plan's copay", row.originalCopayCents, claim.copayCents ?? 0);
    check("what the patient paid", row.patientOutOfPocketCents, claim.patientTotalCents ?? 0);
    check("the voucher", row.paymentCents, voucher);
  } else {
    check("the manufacturer's payment against the remit", row.paymentCents, remit);
    check("what the patient paid", row.patientOutOfPocketCents, claim.patientTotalCents ?? 0);
  }
  return { compared: true, agrees: differences.length === 0, differences };
}

export type VeridikalReport = {
  program: VeridikalProgram;
  /** The tab the rows were taken from. */
  sheet: string;
  rows: VeridikalRow[];
  paymentCents: number;
  feeCents: number;
  totalDueCents: number;
  /** Total Due per Veridikal batch date: what each ACH should be. */
  byDeposit: { on: string; cents: number }[];
  says: string;
};

export type VeridikalRead = { ok: true; report: VeridikalReport } | { ok: false; why: string };

type Sheet = { name: string; rows: string[][] };

const TITLES: [RegExp, VeridikalProgram][] = [
  [/^eVoucher Program\s*-\s*Client Summary$/i, "evoucher"],
  [/^Denial Conversion Activity\s*-\s*Client Summary$/i, "denial_conversion"],
];

const PROGRAM_NAME: Record<VeridikalProgram, string> = { evoucher: "eVoucher", denial_conversion: "Denial Conversion" };

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function programOf(sheet: Sheet): VeridikalProgram | null {
  const first = sheet.rows.flat().map((c) => String(c ?? "").trim()).find((c) => c !== "");
  return first ? TITLES.find(([re]) => re.test(first))?.[1] ?? null : null;
}

/** Whether a workbook is one of the two summaries, by its own title and its header. */
export function looksLikeVeridikalReport(sheets: Sheet[]): boolean {
  return sheets.some((s) => programOf(s) !== null && s.rows.some((r) => r.some((c) => /^rx\s*(#|number)$/i.test(String(c ?? "").trim())) && r.some((c) => /^deposit date$/i.test(String(c ?? "").trim()))));
}

/** A money cell as cents. Blank is nought; anything that is not a number is refused by returning null. */
function cents(v: string | undefined): number | null {
  const t = String(v ?? "").trim().replace(/[$,\s]/g, "");
  if (t === "") return 0;
  const negative = /^\(.*\)$/.test(t) || t.startsWith("-");
  const bare = t.replace(/^\(|\)$/g, "").replace(/^-/, "");
  if (!/^\d+(\.\d+)?$/.test(bare)) return null;
  return Math.round(Number(bare) * 100) * (negative ? -1 : 1);
}

function dateOf(v: string | undefined): string | null {
  const t = String(v ?? "").trim();
  if (/^\d{5}(\.\d+)?$/.test(t)) return excelSerialToIso(Number(t));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

type Parsed = { rows: VeridikalRow[]; key: string[] } | { why: string };

function parseSheet(sheet: Sheet, program: VeridikalProgram, ownNcpdp: string | null): Parsed {
  const rows = sheet.rows.map((r) => r.map((c) => String(c ?? "").trim()));
  const h = rows.findIndex((r) => r.some((c) => /^rx\s*(#|number)$/i.test(c)));
  if (h < 0) return { why: `the "${sheet.name}" tab has no header row.` };
  const head = rows[h];
  const col = (re: RegExp) => head.findIndex((c) => re.test(c));
  const need = {
    nabp: col(/^nabp$/i),
    bin: col(/^bin$/i),
    pcn: col(/^pcn$/i),
    group: col(/^group id$/i),
    fill: col(/^fill date$/i),
    rx: col(/^rx\s*(#|number)$/i),
    ndc: col(/^ndc$/i),
    deposit: col(/^deposit date$/i),
    due: col(/^total due to pharmacy$/i),
    oop: col(/^patient out of pocket$/i),
    payment: program === "evoucher" ? col(/^voucher amount$/i) : col(/^ing cost pd by manufacturer$/i),
    fee: program === "evoucher" ? col(/^evoucher fee$/i) : col(/^denial conversion fee$/i),
  };
  const missing = Object.entries(need).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) return { why: `the ${PROGRAM_NAME[program]} header is missing ${missing.join(", ")}.` };
  const copay = program === "evoucher" ? col(/^original 3rd party copay$/i) : -1;
  const thirdParty = program === "evoucher" ? col(/^total due from third party$/i) : -1;
  const fax = program === "denial_conversion" ? col(/^fax admin fee$/i) : -1;
  if (program === "evoucher" && copay < 0) return { why: "the eVoucher header has no Original 3rd Party Copay, which checks each voucher." };

  const body = rows.slice(h + 1).filter((r) => r.some((c) => c !== ""));
  const data = body.filter((r) => /\d/.test(r[need.rx] ?? ""));
  const totals = body.filter((r) => /^totals?$/i.test(r.find((c) => c !== "") ?? ""));
  if (data.length === 0) return { why: `the "${sheet.name}" tab has no rows.` };
  if (totals.length !== 1) return { why: `the "${sheet.name}" tab has ${totals.length} totals rows, so its rows cannot be checked against one.` };
  const strays = body.length - data.length - totals.length;
  if (strays > 0) return { why: `the "${sheet.name}" tab has ${strays} row${strays === 1 ? "" : "s"} that are neither a claim nor the totals.` };

  // Veridikal's transaction number: the unnamed column holding a number on every row.
  const txnCol = head.findIndex((c, i) => c === "" && data.every((r) => /^\d{4,}$/.test(r[i] ?? "")));
  if (txnCol < 0) return { why: "no transaction-number column: an unnamed column with a number on every row." };

  const moneyCols = [need.due, need.oop, need.payment, need.fee, copay, fax, thirdParty].filter((i) => i >= 0);
  for (const i of moneyCols) {
    let sum = 0;
    for (const r of data) {
      const c = cents(r[i]);
      if (c === null) return { why: `a "${head[i]}" cell is not a number.` };
      sum += c;
    }
    const stated = cents(totals[0][i]);
    if (stated === null || stated !== sum) return { why: `the "${head[i]}" rows come to ${money(sum)} against a total of ${stated === null ? "an unreadable figure" : money(stated)}.` };
  }

  const out: VeridikalRow[] = [];
  const keys: string[] = [];
  for (const [n, r] of data.entries()) {
    const at = `row ${n + 1} of the "${sheet.name}" tab`;
    const payment = cents(r[need.payment])!;
    const fee = cents(r[need.fee])!;
    const due = cents(r[need.due])!;
    const oop = cents(r[need.oop])!;
    // Before the formula, which a Fax Admin Fee would break whichever way it runs: the true reason is the fee.
    if (fax >= 0 && cents(r[fax])! !== 0) {
      return { why: `${at} carries a Fax Admin Fee. No report so far has had one, so whether it is paid to the pharmacy or taken from it is not known; the report is held for a person.` };
    }
    if (due !== payment + fee) return { why: `${at}: Total Due to Pharmacy ${money(due)} is not the payment ${money(payment)} plus the fee ${money(fee)}.` };
    if (program === "evoucher") {
      const original = cents(r[copay])!;
      if (payment !== original - oop) return { why: `${at}: the voucher ${money(payment)} is not the copay ${money(original)} less what the patient paid ${money(oop)}.` };
    }
    const nabp = r[need.nabp] || null;
    if (ownNcpdp && nabp !== ownNcpdp) return { why: `${at} is for NABP ${nabp ?? "(blank)"}, not this pharmacy's ${ownNcpdp}.` };
    const fillDate = dateOf(r[need.fill]);
    const depositOn = dateOf(r[need.deposit]);
    if (!fillDate || !depositOn) return { why: `${at}: its ${fillDate ? "deposit" : "fill"} date could not be read.` };
    const rx = /^0*(\d+)$/.exec(r[need.rx].replace(/\s+/g, ""));
    if (!rx) return { why: `${at}: its prescription number could not be read.` };
    const ndc = (r[need.ndc] ?? "").replace(/\D/g, "");
    out.push({
      transaction: r[txnCol],
      nabp,
      bin: r[need.bin] || null,
      pcn: r[need.pcn] || null,
      groupId: r[need.group] || null,
      fillDate,
      rxNumber: rx[1],
      ndc11: ndc.length === 11 ? ndc : null,
      depositOn,
      paymentCents: payment,
      feeCents: fee,
      totalDueCents: due,
      patientOutOfPocketCents: oop,
      thirdPartyDueCents: thirdParty >= 0 ? cents(r[thirdParty]) : null,
      originalCopayCents: copay >= 0 ? cents(r[copay]) : null,
    });
    keys.push([r[txnCol], rx[1], fillDate, depositOn, payment, fee].join("|"));
  }
  const dupes = keys.length - new Set(out.map((r) => r.transaction)).size;
  if (dupes > 0) return { why: `${dupes} transaction number${dupes === 1 ? " is" : "s are"} repeated on the "${sheet.name}" tab, so a row cannot be told from its copy.` };
  return { rows: out, key: keys };
}

export function readVeridikalReport(sheets: Sheet[], ownNcpdp: string | null = null): VeridikalRead {
  const mine = sheets.map((s) => ({ s, program: programOf(s) })).filter((x): x is { s: Sheet; program: VeridikalProgram } => x.program !== null);
  if (mine.length === 0) return { ok: false, why: "Not a Veridikal client summary." };
  const programs = new Set(mine.map((x) => x.program));
  if (programs.size > 1) return { ok: false, why: "The workbook mixes the eVoucher and Denial Conversion summaries." };
  const program = mine[0].program;
  const name = PROGRAM_NAME[program];

  /*
   * One tab's rows, never two. The "Total" tab carries every month; the month tabs, together, must carry exactly the
   * same rows, or one of the two is not the report it says it is.
   */
  const parsed = mine.map((x) => ({ sheet: x.s, p: parseSheet(x.s, program, ownNcpdp) }));
  const bad = parsed.find((x) => "why" in x.p);
  if (bad && "why" in bad.p) return { ok: false, why: `Veridikal ${name}: ${bad.p.why}` };
  const good = parsed as { sheet: Sheet; p: { rows: VeridikalRow[]; key: string[] } }[];
  const total = good.find((x) => /^total/i.test(x.sheet.name));
  const months = good.filter((x) => x !== total);
  let chosen = total ?? months[0];
  if (total && months.length) {
    const a = months.flatMap((m) => m.p.key).sort().join("\n");
    const b = [...total.p.key].sort().join("\n");
    if (a !== b) return { ok: false, why: `Veridikal ${name}: the month tabs and the "Total" tab do not carry the same rows.` };
  }
  if (!total && months.length > 1) {
    const merged = months.flatMap((m) => m.p.rows);
    if (new Set(merged.map((r) => r.transaction)).size !== merged.length) return { ok: false, why: `Veridikal ${name}: a transaction number appears on two month tabs.` };
    chosen = { sheet: { name: months.map((m) => m.sheet.name).join(" + "), rows: [] }, p: { rows: merged, key: months.flatMap((m) => m.p.key) } };
  }

  const rows = chosen.p.rows;
  const sum = (f: (r: VeridikalRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const deposits = new Map<string, number>();
  for (const r of rows) deposits.set(r.depositOn, (deposits.get(r.depositOn) ?? 0) + r.totalDueCents);
  const byDeposit = [...deposits].sort(([a], [b]) => a.localeCompare(b)).map(([on, c]) => ({ on, cents: c }));
  const report: VeridikalReport = {
    program,
    sheet: chosen.sheet.name,
    rows,
    paymentCents: sum((r) => r.paymentCents),
    feeCents: sum((r) => r.feeCents),
    totalDueCents: sum((r) => r.totalDueCents),
    byDeposit,
    says: `Veridikal ${name}: ${rows.length} row${rows.length === 1 ? "" : "s"}, ${money(sum((r) => r.paymentCents))} ${program === "evoucher" ? "in vouchers" : "from manufacturers"} and ${money(sum((r) => r.feeCents))} in fees paid to the pharmacy, ${money(sum((r) => r.totalDueCents))} due in ${byDeposit.map((d) => `${money(d.cents)} for the ${d.on} batch`).join(", ")}. Every column adds to its total and every row to its own figures.`,
  };
  return { ok: true, report };
}
