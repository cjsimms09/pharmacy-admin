"use server";

import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { resolveByAnswer } from "@/lib/engine/needs-you";
import { engineRefresh } from "@/lib/engine/run";

/**
 * The one-press answers on Today. Each records the answer where the engine reads it, settles the line so it never
 * returns, refreshes the engine, and comes back to the list. None of them guesses: a field left blank is a refusal
 * with a reason, not a default.
 */

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function settle(lineId: string, reason: string) {
  await resolveByAnswer(lineId, new Date().toISOString());
  await engineRefresh(reason);
  revalidatePath("/v2/today");
}

export async function answerBankLine(fd: FormData): Promise<void> {
  const user = await requireManager();
  const lineId = str(fd, "lineId");
  const bankLineId = str(fd, "bankLineId");
  const action = str(fd, "action");
  const note = str(fd, "note");
  const { decideBankLine } = await import("@/app/(app)/money/bank");
  const by = { id: user.id, name: user.name };
  const said = `The owner, on Today, ${new Date().toISOString().slice(0, 10)}.`;
  let r: { ok: true; said: string } | { ok: false; why: string };
  if (action === "before_books") r = await decideBankLine(bankLineId, { kind: "before_books", note: note || `Predates the books. ${said}` }, by);
  else if (action === "noted") r = await decideBankLine(bankLineId, { kind: "noted", category: str(fd, "category") || "Noted", note: note || said }, by);
  else if (action === "books_bill") {
    const category = str(fd, "category");
    const vendor = str(fd, "vendor");
    if (!category || !vendor) {
      revalidatePath("/v2/today");
      return;
    }
    r = await decideBankLine(bankLineId, { kind: "books_bill", category, vendor, note: note || said }, by);
  } else if (action === "cheque") {
    const vendor = str(fd, "vendor");
    const category = str(fd, "category");
    if (!vendor || !category) {
      revalidatePath("/v2/today");
      return;
    }
    r = await decideBankLine(bankLineId, { kind: "books_bill", category, vendor, note: `A cheque to ${vendor}. ${note || said}` }, by);
  } else if (action === "deposit") {
    const payer = str(fd, "payer");
    if (!payer) {
      revalidatePath("/v2/today");
      return;
    }
    r = await decideBankLine(bankLineId, { kind: "deposit", payer, receiptKind: "third_party", note: note || said }, by);
  } else {
    revalidatePath("/v2/today");
    return;
  }
  if (r.ok) await settle(lineId, "answer: bank line");
  else {
    await audit({ action: "today.answer_refused", userId: user.id, userName: user.name, entity: "bank_line", entityId: bankLineId, details: r.why });
    revalidatePath("/v2/today");
  }
}

export async function rereadDocument(fd: FormData): Promise<void> {
  const user = await requireManager();
  const itemId = str(fd, "itemId");
  const { rereadInboxItem } = await import("@/lib/mailbox");
  await rereadInboxItem(itemId, { userId: user.id, userName: user.name });
  await engineRefresh("answer: read again");
  revalidatePath("/v2/today");
}

/** A line answered with "looked, leave it": settled for good, and said so in the log. */
/**
 * A payer's pot answered. "Wait" writes a wait on every open leg of that payer (claim_decisions, a fortnight for a
 * measured payer, a month for one never measured) so the standing itself goes quiet and the pot comes back on the day
 * named if nothing has arrived. "Chase" is the person's act; the line stays until the money does.
 */
export async function answerClaimPot(fd: FormData): Promise<void> {
  const user = await requireManager();
  const lineId = str(fd, "lineId");
  const payer = str(fd, "payer");
  const action = str(fd, "action");
  if (!lineId || !payer || action !== "wait") {
    revalidatePath("/v2/today");
    return;
  }
  const { db, schema } = await import("@/db");
  const { sql, eq } = await import("drizzle-orm");
  const { newId } = await import("@/lib/crypto");
  const { todayIso } = await import("@/lib/dates");
  const today = todayIso();
  const legs = (await db.all(sql`select leg_key, rx_number, fill_number, date_filled, bin, state from claim_standing where payer = ${payer} and state in ('due', 'unmeasured', 'programme', 'unpaid')`)) as { leg_key: string; rx_number: string; fill_number: number | null; date_filled: string; bin: string | null; state: string }[];
  const days = legs.some((l) => l.state === "due") ? 14 : 30;
  const revisitOn = new Date(Date.parse(`${today}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  let written = 0;
  for (const l of legs) {
    if (l.state !== "due" && l.state !== "unmeasured") continue;
    const existing = await db.query.claimDecisions.findFirst({ where: eq(schema.claimDecisions.legKey, l.leg_key) });
    const values = { decision: "wait" as const, note: `From Today: they pay later. ${user.name}`, decidedBy: user.name, decidedAt: now, revisitOn, resolvedAt: null };
    if (existing) await db.update(schema.claimDecisions).set(values).where(eq(schema.claimDecisions.id, existing.id));
    else await db.insert(schema.claimDecisions).values({ id: newId(), legKey: l.leg_key, rxNumber: l.rx_number, fillNumber: l.fill_number, dateFilled: l.date_filled, bin: l.bin, ...values });
    written++;
  }
  await audit({ action: "claim.wait_from_today", userId: user.id, userName: user.name, entity: "payer", entityId: payer, details: `${written} legs wait until ${revisitOn}` });
  await settle(lineId, "answer: payer pot waits");
}

export async function acknowledgeLine(fd: FormData): Promise<void> {
  const user = await requireManager();
  const lineId = str(fd, "lineId");
  const what = str(fd, "what");
  await audit({ action: "today.acknowledged", userId: user.id, userName: user.name, entity: "needs_you", entityId: lineId, details: what });
  await settle(lineId, "answer: acknowledged");
}

export async function closeMonthAction(fd: FormData): Promise<void> {
  const user = await requireManager();
  const month = str(fd, "month");
  const { closeMonth } = await import("@/lib/engine/month");
  const r = await closeMonth(month, new Date().toISOString());
  await audit({ action: "month.close", userId: user.id, userName: user.name, entity: "month", entityId: month, details: r.ok ? "closed" : r.why });
  if (r.ok) await settle(str(fd, "lineId"), "answer: month closed");
  else revalidatePath("/v2/today");
}
