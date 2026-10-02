/**
 * The reconciliation service's adjustment report: the fees and adjustments payers took on remittances.
 *
 * The owner, 2 October 2026, on the account's "no payer fees": "that cant be true. DIR fees are mostly
 * proactive and at POS now. but there are 'adjustments' made.." — and he sent September's report:
 * thirty lines, $363.40, Express Scripts' origination fee (provider-level adjustment code AH) on four
 * remittances and Health Mart Atlas's adjustments (CS) on twenty-six. The site holds no 835 for most
 * of those remittances, so this report is the record of them. Point-of-sale concessions are inside the
 * paid amounts already; these are what is taken after the sale.
 *
 * Shape: one row per adjustment — Location, Location Name, Adjustment Code, Adjustment Identifier,
 * Adjustment Amount, Remittance Number, Remit Date, Posted Date, Payer Name, Document Sequence Number,
 * Line Item Number — then a blank row and a footer carrying the total. The footer is the arithmetic
 * gate: a report whose lines do not add to its own total is refused, not stored.
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export type AdjustmentLine = {
  code: string;
  identifier: string;
  /** As printed: negative where the payer took money. */
  amountCents: number;
  remittanceNumber: string;
  remitOn: string | null;
  postedOn: string | null;
  payer: string;
  lineItem: string;
};

export type AdjustmentReport =
  | { ok: true; lines: AdjustmentLine[]; totalCents: number; periodFrom: string | null; periodTo: string | null; says: string }
  | { ok: false; why: string };

/** X12 provider-level adjustment reason codes, the ones a pharmacy sees. */
export const PLB_CODES: Record<string, string> = {
  AH: "origination fee",
  CS: "adjustment",
  WO: "overpayment recovery",
  FB: "forwarding balance",
  L6: "interest owed",
  "72": "authorized return",
  "50": "late charge",
  "51": "interest penalty",
  "90": "early payment allowance",
  BD: "bad debt",
  BN: "bonus",
  IR: "IRS withholding",
};

const splitCsv = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

const cents = (s: string): number | null => {
  const t = s.replace(/[$,\s]/g, "");
  if (!t || !/^-?\(?\d+(\.\d+)?\)?$/.test(t)) return null;
  const neg = t.startsWith("(") || t.startsWith("-");
  const n = Math.round(Math.abs(parseFloat(t.replace(/[()\-]/g, ""))) * 100);
  return neg ? -n : n;
};

const mdy = (s: string): string | null => {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

export const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function parseAdjustmentReport(text: string, fileName = ""): AdjustmentReport {
  const rows = text.split(/\r?\n/).map(splitCsv).filter((r) => r.some((c) => c !== ""));
  if (rows.length === 0) return { ok: false, why: "The file is empty." };
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (name: string) => head.indexOf(name.toLowerCase());
  const cCode = col("Adjustment Code");
  const cId = col("Adjustment Identifier");
  const cAmt = col("Adjustment Amount");
  const cRemit = col("Remittance Number");
  const cRemitOn = col("Remit Date");
  const cPosted = col("Posted Date");
  const cPayer = col("Payer Name");
  const cLine = col("Line Item Number");
  if ([cCode, cAmt, cRemit, cRemitOn, cPayer].some((i) => i < 0)) {
    return { ok: false, why: "Not an adjustment report: the header does not carry Adjustment Code, Adjustment Amount, Remittance Number, Remit Date and Payer Name." };
  }
  const lines: AdjustmentLine[] = [];
  let footer: number | null = null;
  for (const r of rows.slice(1)) {
    const code = r[cCode] ?? "";
    const amount = cents(r[cAmt] ?? "");
    if (!code) {
      if (amount !== null) footer = (footer ?? 0) + amount;
      continue;
    }
    if (amount === null) return { ok: false, why: `A line for ${r[cPayer] ?? "a payer"} on remittance ${r[cRemit] ?? "?"} carries no readable amount.` };
    lines.push({
      code,
      identifier: r[cId] ?? "",
      amountCents: amount,
      remittanceNumber: r[cRemit] ?? "",
      remitOn: mdy(r[cRemitOn] ?? ""),
      postedOn: cPosted >= 0 ? mdy(r[cPosted] ?? "") : null,
      payer: r[cPayer] ?? "",
      lineItem: cLine >= 0 ? (r[cLine] ?? "") : "",
    });
  }
  if (footer === null) return { ok: false, why: "The report carries no total line, so its lines cannot be checked against anything." };
  const sum = lines.reduce((n, l) => n + l.amountCents, 0);
  if (sum !== footer) return { ok: false, why: `The lines add to ${money(sum)} and the report's own total says ${money(footer)}; refused rather than stored wrong.` };
  const period = fileName.match(/_(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})\.csv$/i);
  const byPayer = new Map<string, { n: number; cents: number; codes: Set<string> }>();
  for (const l of lines) {
    const e = byPayer.get(l.payer) ?? { n: 0, cents: 0, codes: new Set<string>() };
    e.n++;
    e.cents += l.amountCents;
    e.codes.add(l.code);
    byPayer.set(l.payer, e);
  }
  const says =
    `${lines.length} adjustment${lines.length === 1 ? "" : "s"}, ${money(sum)} ${sum < 0 ? "taken" : "returned"}: ` +
    [...byPayer]
      .sort((a, b) => a[1].cents - b[1].cents)
      .map(([payer, v]) => `${payer} ${v.n} (${money(v.cents)}, ${[...v.codes].map((c) => `${c} ${PLB_CODES[c] ?? "adjustment"}`).join(", ")})`)
      .join("; ");
  return {
    ok: true,
    lines,
    totalCents: footer,
    periodFrom: period ? `${period[1]}-${period[2]}-${period[3]}` : null,
    periodTo: period ? `${period[4]}-${period[5]}-${period[6]}` : null,
    says,
  };
}

/** The lines on every adjustment report on file, each counted once across overlapping reports. */
export async function adjustmentLinesOnFile(): Promise<{ lines: AdjustmentLine[]; reports: number; refused: string[] }> {
  const docs = await db.query.documents.findMany({ where: eq(schema.documents.category, "adjustment_report"), columns: { id: true, fileName: true, storageKey: true, title: true } });
  const { readFile } = await import("./files");
  const seen = new Set<string>();
  const lines: AdjustmentLine[] = [];
  const refused: string[] = [];
  for (const d of docs) {
    const text = (await readFile(d.storageKey)).toString("utf8");
    const r = parseAdjustmentReport(text, d.fileName);
    if (!r.ok) {
      refused.push(`${d.title || d.fileName}: ${r.why}`);
      continue;
    }
    for (const l of r.lines) {
      const k = `${l.remittanceNumber}|${l.code}|${l.identifier}|${l.lineItem}|${l.amountCents}|${l.remitOn ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(l);
    }
  }
  return { lines, reports: docs.length - refused.length, refused };
}

/** By the remittance's month: what payers took, positive, in cents — the sign the account's fee line uses. */
export function takenByMonth(lines: AdjustmentLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const month = (l.remitOn ?? l.postedOn ?? "").slice(0, 7);
    if (!month) continue;
    out.set(month, (out.get(month) ?? 0) - l.amountCents);
  }
  return out;
}

/**
 * By month, leaving out any remittance whose 835 is on file with its provider-level segments read (remittance_holdbacks):
 * the 835 is the primary record and the report must not count the same fee twice once it arrives.
 */
export async function adjustmentsByMonth(remittancesWith835: Set<string> = new Set()): Promise<Map<string, number>> {
  const { lines } = await adjustmentLinesOnFile();
  const on835 = (n: string) => n !== "" && [...remittancesWith835].some((t) => t !== "" && (t.includes(n) || n.includes(t)));
  return takenByMonth(lines.filter((l) => !on835(l.remittanceNumber)));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Files a stored document as the month's adjustment report, or refuses it in words. The mailbox calls this for the
 * monthly email ("going to have this emailed to site once monthly, make sure it gets received and read correctly.." —
 * the owner, 2 October 2026) and the same call filed the first one he sent by hand. Audited either way.
 */
export async function fileAdjustmentReport(docId: string, text: string, fileName: string, by: string): Promise<{ ok: boolean; says: string }> {
  const { audit } = await import("./audit");
  const r = parseAdjustmentReport(text, fileName);
  if (!r.ok) {
    await db.update(schema.documents).set({ title: `Adjustment report, refused: ${fileName}`, notes: r.why }).where(eq(schema.documents.id, docId));
    await audit({ action: "adjustment_report.refused", userId: null, userName: by, entity: "document", entityId: docId, details: `${fileName}: ${r.why}` });
    return { ok: false, says: `Adjustment report refused, kept as a document: ${r.why}` };
  }
  const monthOf = r.periodTo ?? r.lines.map((l) => l.remitOn ?? "").sort().pop() ?? null;
  const monthName = monthOf ? `${MONTHS[Number(monthOf.slice(5, 7)) - 1]} ${monthOf.slice(0, 4)}` : fileName;
  await db
    .update(schema.documents)
    .set({ category: "adjustment_report", title: `Adjustment report, ${monthName}`, ...(r.periodTo ? { effectiveOn: r.periodTo } : {}), notes: r.says })
    .where(eq(schema.documents.id, docId));
  await audit({ action: "adjustment_report.read", userId: null, userName: by, entity: "document", entityId: docId, details: `${monthName}: ${r.says}` });
  return { ok: true, says: `Adjustment report, ${monthName}: ${r.says}. Taken off revenue in each remittance's month.` };
}
