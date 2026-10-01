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
