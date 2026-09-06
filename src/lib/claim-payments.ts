import "server-only";
import nodePath from "node:path";
import { db, schema } from "@/db";
import { eq, isNull } from "drizzle-orm";
import { newId } from "./crypto";
import type { LaterPayment } from "./fills";

/**
 * Money that reaches a claim after it was adjudicated.
 *
 * A claim's revenue is not settled on the day it is transmitted. A Medicare Transaction Facilitator
 * payment arrives weeks later. So does a DIR reconciliation, a copay card posted after the fact, or
 * a secondary that adjudicated late. Held only as what the daily report said on the day, every one
 * of those is money the pharmacy received and this system never counted — and a fill sits on the
 * "dispensed at a loss" list because of a payment that has since arrived.
 *
 * Kept as rows of its own rather than added into the claim, because what was paid on the day has to
 * stay distinguishable from what arrived afterwards. That distinction is the whole point when a
 * payer is being judged: the plan paid what the plan paid, and a facilitator payment on top of it
 * is not the plan's money and must not flatter it.
 *
 * Matched on the fill — prescription, fill number, date and NDC — rather than on a claim id,
 * because a remittance names a prescription and this system's ids mean nothing to anybody outside
 * it. It is also the only join that holds where the fill went to two payers and so has two claim
 * rows.
 */

export type RecordPayment = {
  rxNumber: string;
  fillNumber?: number | null;
  dateFilled?: string | null;
  ndc11?: string | null;
  source: "mtf" | "dir" | "copay_card" | "secondary" | "manual";
  payer?: string | null;
  amountCents: number;
  receivedOn?: string | null;
  reference?: string | null;
  notes?: string | null;
};

/**
 * Records a payment, attaching it to the claim it belongs to where one can be found.
 *
 * The claim id is a convenience, not the key: a payment for a prescription this system has not
 * loaded yet is still recorded, and picks up its claim when the claim arrives. Losing money because
 * the remittance beat the daily report would be an ordering nobody outside this code knows about.
 */
export async function recordClaimPayment(p: RecordPayment, user: { name: string }): Promise<{ id: string; matched: boolean }> {
  const rx = p.rxNumber.trim();
  if (!rx) throw new Error("A payment has to name the prescription it is for.");
  if (!Number.isFinite(p.amountCents) || p.amountCents === 0) throw new Error("Give the amount received.");

  const claim = await findClaim(rx, p.fillNumber ?? null, p.dateFilled ?? null, p.ndc11 ?? null);
  const id = newId();
  await db.insert(schema.claimPayments).values({
    id,
    claimId: claim?.id ?? null,
    rxNumber: rx,
    fillNumber: p.fillNumber ?? claim?.fillNumber ?? null,
    dateFilled: p.dateFilled ?? claim?.dateFilled ?? null,
    ndc11: p.ndc11 ?? claim?.ndc11 ?? null,
    source: p.source,
    payer: p.payer ?? null,
    amountCents: Math.round(p.amountCents),
    receivedOn: p.receivedOn ?? null,
    reference: p.reference ?? null,
    notes: p.notes ?? null,
    recordedBy: user.name,
  });
  return { id, matched: claim !== null };
}

async function findClaim(rxNumber: string, fillNumber: number | null, dateFilled: string | null, ndc11: string | null) {
  const rows = await db.query.claims.findMany({
    where: eq(schema.claims.rxNumber, rxNumber),
    columns: { id: true, fillNumber: true, dateFilled: true, ndc11: true },
  });
  if (rows.length === 0) return null;
  // The most specific match wins; a remittance that names only the prescription still lands.
  const fits = rows.filter(
    (r) =>
      (fillNumber === null || r.fillNumber === fillNumber) &&
      (dateFilled === null || r.dateFilled === dateFilled) &&
      (ndc11 === null || r.ndc11 === ndc11),
  );
  return fits[0] ?? null;
}

/** Every later payment, in the shape the fill grouping takes. */
export async function laterPayments(): Promise<LaterPayment[]> {
  const rows = await db.query.claimPayments.findMany();
  return rows.map((r) => ({
    rxNumber: r.rxNumber,
    fillNumber: r.fillNumber,
    dateFilled: r.dateFilled,
    ndc11: r.ndc11,
    source: r.source,
    payer: r.payer,
    amountCents: r.amountCents,
  }));
}

/**
 * Attaches payments recorded before their claim arrived.
 *
 * Run after a claims load. Cheap, and it means a remittance that beat the daily report is not money
 * quietly sitting against nothing.
 */
export async function matchOrphanPayments(): Promise<{ matched: number }> {
  const orphans = await db.query.claimPayments.findMany({ where: isNull(schema.claimPayments.claimId) });
  let matched = 0;
  for (const p of orphans) {
    const claim = await findClaim(p.rxNumber, p.fillNumber, p.dateFilled, p.ndc11);
    if (!claim) continue;
    await db.update(schema.claimPayments).set({ claimId: claim.id }).where(eq(schema.claimPayments.id, p.id));
    matched++;
  }
  return { matched };
}

/** What has arrived after the day, by where it came from, for a page that has to show it. */
export async function laterPaymentSummary(): Promise<{ source: string; payments: number; amountCents: number; unmatched: number }[]> {
  const rows = await db.query.claimPayments.findMany();
  const by = new Map<string, { source: string; payments: number; amountCents: number; unmatched: number }>();
  for (const r of rows) {
    const e = by.get(r.source) ?? { source: r.source, payments: 0, amountCents: 0, unmatched: 0 };
    e.payments++;
    e.amountCents += r.amountCents;
    if (!r.claimId) e.unmatched++;
    by.set(r.source, e);
  }
  return [...by.values()].sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * Recovers the patient's residual for claims loaded before it was being kept.
 *
 * The daily report's "Total" column was parsed and thrown away, so every claim already held has a
 * patient payment of nothing — which on a deductible fill is the whole of the money. The raw row is
 * stored against each claim, so it can be recovered without asking for the files again.
 */
export async function backfillPatientTotals(): Promise<{ read: number; filled: number }> {
  const rows = await db.query.claims.findMany({ columns: { id: true, rawJson: true, patientTotalCents: true } });
  let filled = 0;
  let read = 0;
  for (const r of rows) {
    if (r.patientTotalCents !== null || !r.rawJson) continue;
    read++;
    try {
      const raw = JSON.parse(r.rawJson) as Record<string, string>;
      const printed = raw["Total"] ?? raw["Patient Total"] ?? raw["patientTotal"];
      if (printed === undefined) continue;
      const n = Number(String(printed).replace(/[$,()\s]/g, ""));
      if (!Number.isFinite(n)) continue;
      const negative = /^\(.*\)$/.test(String(printed).trim());
      await db
        .update(schema.claims)
        .set({ patientTotalCents: Math.round(n * 100) * (negative ? -1 : 1) })
        .where(eq(schema.claims.id, r.id));
      filled++;
    } catch {
      // A row whose raw text cannot be read is left as it was rather than guessed at.
    }
  }
  return { read, filled };
}

/**
 * Loads an 835 remittance and records what it paid against the fills it names.
 *
 * The whole point of the Medicare Transaction Facilitator CLI: it downloads these files on a
 * schedule, and until they are read the money in them reaches the bank and nothing here knows.
 *
 * Loading the same file twice is safe. A payment is identified by the remittance's trace number
 * and the claim's own reference, which is what makes a re-download of the same day harmless —
 * and re-downloading is exactly what a scheduled task does.
 */
export async function importRemittance(
  text: string,
  fileName: string,
  user: { name: string },
): Promise<{ payments: number; alreadyHeld: number; matched: number; unmatched: number; amountCents: number; skipped: number; problems: string[] }> {
  const { parse835, payableOnly } = await import("./x12-835");
  const r = parse835(text);
  const { keep, skipped } = payableOnly(r);
  const out = { payments: 0, alreadyHeld: 0, matched: 0, unmatched: 0, amountCents: 0, skipped: skipped.length, problems: [...r.problems] };

  const held = await db.query.claimPayments.findMany({ columns: { reference: true, rxNumber: true, amountCents: true } });
  const seen = new Set(held.map((h) => `${h.reference ?? ""}|${h.rxNumber}|${h.amountCents}`));

  for (const p of keep) {
    const reference = [r.traceNumber, p.reference].filter(Boolean).join("/") || fileName;
    if (seen.has(`${reference}|${p.rxNumber}|${p.paidCents}`)) {
      out.alreadyHeld++;
      continue;
    }
    const rec = await recordClaimPayment(
      {
        rxNumber: p.rxNumber,
        fillNumber: p.fillNumber,
        dateFilled: p.serviceDate,
        ndc11: p.ndc11,
        // Named for who sent it rather than assumed: this reader takes any 835, not only the MTF's.
        source: /transaction facilitator|\bmtf\b/i.test(r.payer ?? "") ? "mtf" : "secondary",
        payer: r.payer,
        amountCents: p.paidCents!,
        receivedOn: r.paidOn,
        reference,
        notes: `From ${fileName}${r.traceNumber ? `, trace ${r.traceNumber}` : ""}.`,
      },
      user,
    );
    out.payments++;
    out.amountCents += p.paidCents!;
    if (rec.matched) out.matched++;
    else out.unmatched++;
    seen.add(`${reference}|${p.rxNumber}|${p.paidCents}`);
  }
  return out;
}

/**
 * Where the remittances are, which is wherever the CLI was told to put them.
 *
 * Asking the MTF settings rather than keeping a second folder of our own: the CLI is configured
 * once with a download directory, a scheduled task fills it, and anything that reads somewhere else
 * reads an empty folder for ever while the money piles up next door.
 */
export async function remittanceDir(): Promise<string> {
  try {
    const { mtfStatus } = await import("./mtf");
    const s = await mtfStatus();
    if (s.dir) return s.dir;
  } catch {
    // No MTF configuration yet — fall back to a folder beside the database.
  }
  const base = nodePath.dirname(nodePath.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
  return nodePath.join(base, "remittances");
}

/**
 * Reads every remittance in the watched folder that has not been read before.
 *
 * A folder rather than an email, because that is what the CLI produces: it is given a download
 * directory and it fills it on a schedule. Point it at this one and the money appears here without
 * anybody carrying a file across.
 */
export async function sweepRemittances(user: { name: string }): Promise<{
  files: number;
  read: number;
  payments: number;
  amountCents: number;
  matched: number;
  unmatched: number;
  problems: string[];
}> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = await remittanceDir();
  const out = { files: 0, read: 0, payments: 0, amountCents: 0, matched: 0, unmatched: 0, problems: [] as string[] };
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // Not created yet. Said plainly by the caller rather than treated as an error here.
    return out;
  }
  const wanted = entries.filter((e) => /\.(835|txt|rmt|edi|dat)$/i.test(e) || /^\d{8}/.test(e));
  out.files = wanted.length;

  for (const file of wanted) {
    try {
      const text = await fs.readFile(path.join(dir, file), "utf8");
      if (!/\bCLP\b/.test(text)) continue; // Not a remittance; left where it is.
      const r = await importRemittance(text, file, user);
      out.read++;
      out.payments += r.payments;
      out.amountCents += r.amountCents;
      out.matched += r.matched;
      out.unmatched += r.unmatched;
      out.problems.push(...r.problems);
    } catch (e) {
      out.problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/**
 * What the Medicare Transaction Facilitator has actually paid, and when.
 *
 * A refund channel is only worth having if somebody can see what came out of it. The payments land
 * on individual fills, which is right for working out whether a fill made money — and useless for
 * the question actually asked at the end of a month, which is how much this brought in.
 *
 * Counted by the date the money was received rather than the date the prescription was filled. A
 * remittance settles weeks after the fill, so counting by fill date would credit this month's
 * receipts to a month that closed long ago, and the figure would never agree with the bank.
 */
export type MoneyByMonth = { month: string; payments: number; amountCents: number };

export type FacilitatorMoney = {
  source: string;
  monthToDateCents: number;
  monthToDatePayments: number;
  lastMonthCents: number;
  allTimeCents: number;
  allTimePayments: number;
  months: MoneyByMonth[];
  /** The largest payments this month, so the figure can be checked against a remittance. */
  thisMonth: { rxNumber: string; dateFilled: string | null; ndc11: string | null; itemName: string | null; amountCents: number; receivedOn: string | null; reference: string | null }[];
  /** Payments naming a prescription this site has not loaded — money real but unattached. */
  unmatchedCents: number;
  unmatched: number;
  /** Payments with no received date, which cannot be put in a month. */
  undatedCents: number;
};

export async function facilitatorMoney(source = "mtf", today = new Date()): Promise<FacilitatorMoney> {
  const rows = (await db.query.claimPayments.findMany()).filter((r) => r.source === source);
  const claims = await db.query.claims.findMany({ columns: { id: true, itemName: true } });
  const nameOf = new Map(claims.map((c) => [c.id, c.itemName]));

  const monthOf = (iso: string | null) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : null);
  const thisMonth = today.toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

  const by = new Map<string, MoneyByMonth>();
  let unmatchedCents = 0;
  let unmatched = 0;
  let undatedCents = 0;

  for (const r of rows) {
    const m = monthOf(r.receivedOn);
    if (m === null) undatedCents += r.amountCents;
    else {
      const e = by.get(m) ?? { month: m, payments: 0, amountCents: 0 };
      e.payments++;
      e.amountCents += r.amountCents;
      by.set(m, e);
    }
    if (!r.claimId) {
      unmatched++;
      unmatchedCents += r.amountCents;
    }
  }

  const months = [...by.values()].sort((a, b) => b.month.localeCompare(a.month));
  const mtd = by.get(thisMonth) ?? { month: thisMonth, payments: 0, amountCents: 0 };

  return {
    source,
    monthToDateCents: mtd.amountCents,
    monthToDatePayments: mtd.payments,
    lastMonthCents: by.get(lastMonth)?.amountCents ?? 0,
    allTimeCents: rows.reduce((n, r) => n + r.amountCents, 0),
    allTimePayments: rows.length,
    months,
    thisMonth: rows
      .filter((r) => monthOf(r.receivedOn) === thisMonth)
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 50)
      .map((r) => ({
        rxNumber: r.rxNumber,
        dateFilled: r.dateFilled,
        ndc11: r.ndc11,
        itemName: r.claimId ? (nameOf.get(r.claimId) ?? null) : null,
        amountCents: r.amountCents,
        receivedOn: r.receivedOn,
        reference: r.reference,
      })),
    unmatchedCents,
    unmatched,
    undatedCents,
  };
}
