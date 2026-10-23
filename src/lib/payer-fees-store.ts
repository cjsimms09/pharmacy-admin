import "server-only";
import { asc, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { adjustmentLinesOnFile } from "./adjustment-report";
import { isOutOfBooks } from "./books-start";
import { monthName } from "./dates";
import { FEE_DECISION_ACTIONS, classifyFee, countPayerFees, feeKey, feesByMonth, lineSays, readFeeKey, type Decided, type FeeDecision, type FeeDecisionKind, type FeeLine, type MonthFees, type PayerFees } from "./payer-fees";

/**
 * What a person has said about particular lines: the latest word under each key, as the audit events the Money page writes.
 * A line he reopened comes back as the word "reopen", not as nothing: the same line may have been decided under another
 * spelling of its remittance, and the latest word across every spelling is the one that stands (payer-fees.ts). The key is
 * payer-fees.ts's, not a record's id, which is what lets a decision survive a better record of the same line arriving.
 */
export async function loadFeeDecisions(): Promise<FeeDecision[]> {
  const events = await db
    .select({ entityId: schema.auditEvents.entityId, action: schema.auditEvents.action, userName: schema.auditEvents.userName, at: schema.auditEvents.at })
    .from(schema.auditEvents)
    .where(inArray(schema.auditEvents.action, Object.values(FEE_DECISION_ACTIONS)))
    .orderBy(asc(schema.auditEvents.at), sql`rowid`);
  const latest = new Map<string, { action: string; by: string; at: string }>();
  for (const e of events) if (e.entityId) latest.set(e.entityId, { action: e.action, by: e.userName ?? "", at: e.at });
  const word: Record<string, FeeDecision["decision"]> = { [FEE_DECISION_ACTIONS.count]: "count", [FEE_DECISION_ACTIONS.leave_out]: "leave_out", [FEE_DECISION_ACTIONS.reopen]: "reopen" };
  return [...latest].map(([key, v]) => ({ key, decision: word[v.action], by: v.by, on: v.at }));
}

/**
 * Every record of what the payers took off the remittances, read from where it is kept, and counted once (payer-fees.ts).
 *
 * A Health Mart Atlas EFT is covered when its payment report has been read, which leaves either its claim payments
 * (origin "accesshealth:<EFT>") or its fees (expenses keyed "AHADJ|<EFT>|<code>|<reference>"). The fees it booked come
 * with it, so a disagreement with the other records can be seen. An AHADJ expense a person has voided stops counting
 * as a fee but the EFT stays covered: the report is believed over the adjustment report, and the difference is said.
 */
export async function loadPayerFees(): Promise<PayerFees> {
  const eft = new Map<string, number>();
  const booked = (await db.all(sql`select invoice_number n, amount_cents c from expenses where status = 'confirmed' and invoice_number like 'AHADJ|%'`)) as { n: string; c: number }[];
  for (const b of booked) {
    const e = b.n.split("|")[1] ?? "";
    if (e) eft.set(e, (eft.get(e) ?? 0) + Number(b.c));
  }
  const read = (await db.all(sql`select distinct origin o from claim_payments where origin like 'accesshealth:%'`)) as { o: string }[];
  for (const r of read) {
    const e = r.o.replace(/^accesshealth:/, "");
    if (e && !eft.has(e)) eft.set(e, 0);
  }

  const holdbacks = (await db.all(
    sql`select trace_number t, payer p, reason_code c, reference r, amount_cents a, received_on d from remittance_holdbacks where out_of_books = 0`,
  )) as { t: string | null; p: string | null; c: string; r: string | null; a: number; d: string | null }[];
  const from835: FeeLine[] = holdbacks.map((h) => ({
    remittance: h.t ?? "",
    month: (h.d ?? "").slice(0, 7),
    code: h.c,
    reference: h.r ?? "",
    takenCents: Number(h.a),
    payer: h.p ?? "",
  }));

  const { lines } = await adjustmentLinesOnFile();
  /* The owner, 11 September 2026: nothing from before 1 September is tracked or shown. The 835s are filtered the same way above. */
  const fromAdjustmentReport: FeeLine[] = lines
    .filter((l) => !isOutOfBooks(l.remitOn ?? l.postedOn))
    .map((l) => ({
      remittance: l.remittanceNumber,
      month: (l.remitOn ?? l.postedOn ?? "").slice(0, 7),
      code: l.code,
      reference: l.identifier,
      takenCents: -l.amountCents,
      payer: l.payer,
    }));

  return countPayerFees({ paymentReports: [...eft].map(([remittance, feeCents]) => ({ remittance, feeCents })), from835, fromAdjustmentReport, decisions: await loadFeeDecisions() });
}

export async function payerFeesByMonth(): Promise<Map<string, MonthFees>> {
  return feesByMonth(await loadPayerFees());
}

/** `changed` is false where the line already stood as he said: nothing was written, and nothing downstream needs to move. */
export type FeeDecisionResult = { ok: true; said: string; changed: boolean } | { ok: false; why: string };

const monthLabel = (m: string): string | null => (/^\d{4}-\d{2}$/.test(m) ? `${monthName(Number(m.slice(5, 7)))} ${m.slice(0, 4)}` : null);

/**
 * One press on the Money page: count a line as a fee, leave it out, or give it back to the rule ("reopen"). It is written as
 * an audit event keyed on the line (payer-fees.ts feeKey), which is what lets it survive every import and a better record
 * of the same line arriving. Refused, in words and with nothing written, for a line nobody can decide: one a better record
 * already carries (the figure counts it once there), one the rule is certain is not a fee (a balance forward), and one that
 * is no longer on file.
 */
export async function decideFee(by: { id: string; name: string }, key: string, to: FeeDecisionKind | "reopen"): Promise<FeeDecisionResult> {
  if (!readFeeKey(key)) return { ok: false, why: "That is not a line of a remittance. Nothing was changed." };
  const fees = await loadPayerFees();
  const found = [
    ...fees.held.map((l) => ({ l, current: null as Decided | null })),
    ...fees.counted.map((l) => ({ l, current: l.decided ?? null })),
    ...fees.leftOut.map((l) => ({ l, current: l.decided as Decided | null })),
  ].find((x) => feeKey(x.l) === key);
  if (!found) {
    const kept = fees.keptOut.find((l) => feeKey(l) === key);
    if (kept) return { ok: false, why: `That line is counted once already, from ${kept.alreadyIn}, so a decision on this copy of it would change nothing: ${lineSays(kept)}. Nothing was changed.` };
    const notFee = fees.notFees.find((l) => feeKey(l) === key);
    if (notFee) return { ok: false, why: `That line is not a fee, so there is nothing to decide. ${lineSays(notFee)}: ${notFee.why}. Nothing was changed.` };
    return { ok: false, why: "That line is not on file any more. Nothing was changed." };
  }
  const { l, current } = found;
  const says = lineSays(l);
  const counted = l.takenCents < 0 ? "Counted against the fees" : "Counted as a fee";
  if (to === "reopen" && !current) return { ok: false, why: `That line has no decision of yours to undo: ${says}. Nothing was changed.` };
  if (to !== "reopen" && current?.decision === to) {
    return { ok: true, changed: false, said: `Already ${to === "count" ? counted.toLowerCase() : "left out"}: ${says}. Nothing was changed.` };
  }
  const { audit } = await import("./audit");
  const verb = { count: counted, leave_out: "Left out", reopen: "Back to the rule" }[to];
  const when = monthLabel(l.month);
  await audit({ action: FEE_DECISION_ACTIONS[to], userId: by.id, userName: by.name, entity: "payer_fee", entityId: key, details: `${verb}: ${says}, ${when ?? "no date"}.` });
  const noDate = "The line carries no date, so no month's payer fees change; your word is kept for when a dated record of it arrives.";
  if (to === "count") return { ok: true, changed: true, said: `${counted}: ${says}. ${when ? `It ${l.takenCents < 0 ? "lowers" : "is in"} ${when}'s payer fees, and stays counted when the next import arrives.` : noDate}` };
  if (to === "leave_out") return { ok: true, changed: true, said: `Left out: ${says}. ${when ? `It is not in ${when}'s payer fees, and stays out when the next import arrives.` : noDate}` };
  const k = classifyFee(l);
  return { ok: true, changed: true, said: `Back to the rule: ${says}. ${k.fee ? "The rule counts it as a fee." : `The rule cannot count it (${k.why}), so it waits for your decision again.`}` };
}
