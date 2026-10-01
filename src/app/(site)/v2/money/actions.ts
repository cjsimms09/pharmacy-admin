"use server";

import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { engineRefresh } from "@/lib/engine/run";
import { resolveByAnswer } from "@/lib/engine/needs-you";

/**
 * The answers on Money. Each writes through decideBankLine (the one door for a line a person settles), settles the
 * Today line that pointed at it, refreshes the engine and returns to the month. A blank field is a refusal with a
 * reason in the log, never a default.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function answerMoneyLine(fd: FormData): Promise<void> {
  const user = await requireManager();
  const month = str(fd, "month");
  const bankLineId = str(fd, "bankLineId");
  const action = str(fd, "action");
  const note = str(fd, "note");
  const back = `/v2/money?month=${month}&tab=${str(fd, "tab") || "bank"}`;
  const { decideBankLine } = await import("@/app/(app)/money/bank");
  const by = { id: user.id, name: user.name };
  const said = `The owner, on Money, ${new Date().toISOString().slice(0, 10)}.`;
  let r: { ok: true; said: string } | { ok: false; why: string } = { ok: false, why: "nothing chosen" };
  if (action === "before_books") r = await decideBankLine(bankLineId, { kind: "before_books", note: note || `Predates the books. ${said}` }, by);
  else if (action === "noted") r = await decideBankLine(bankLineId, { kind: "noted", category: str(fd, "category") || "Noted", note: note || said }, by);
  else if (action === "standing") {
    const name = str(fd, "standing");
    r = name ? await decideBankLine(bankLineId, { kind: "standing", name, note: note || said }, by) : { ok: false, why: "no standing cost chosen" };
  } else if (action === "books_bill" || action === "cheque") {
    const category = str(fd, "category");
    const vendor = str(fd, "vendor");
    r = category && vendor ? await decideBankLine(bankLineId, { kind: "books_bill", category, vendor, note: `${action === "cheque" ? `A cheque to ${vendor}. ` : ""}${note || said}` }, by) : { ok: false, why: "category and payee are both needed" };
  } else if (action === "deposit") {
    const payer = str(fd, "payer");
    r = payer ? await decideBankLine(bankLineId, { kind: "deposit", payer, receiptKind: "third_party", note: note || said }, by) : { ok: false, why: "payer needed" };
  }
  if (r.ok) {
    await resolveByAnswer(`bank_line|${bankLineId}`, new Date().toISOString());
    await engineRefresh("answer: money line");
  } else {
    await audit({ action: "money.answer_refused", userId: user.id, userName: user.name, entity: "bank_line", entityId: bankLineId, details: r.why });
  }
  revalidatePath("/v2/money");
  revalidatePath("/v2/today");
  const { redirect } = await import("next/navigation");
  redirect(back);
}

export async function closeMonthFromMoney(fd: FormData): Promise<void> {
  const user = await requireManager();
  const month = str(fd, "month");
  const { closeMonth } = await import("@/lib/engine/month");
  const r = await closeMonth(month, new Date().toISOString());
  await audit({ action: "month.close", userId: user.id, userName: user.name, entity: "month", entityId: month, details: r.ok ? "closed" : r.why });
  if (r.ok) {
    await resolveByAnswer(`close|${month}`, new Date().toISOString());
    await engineRefresh("answer: month closed");
  }
  revalidatePath("/v2/money");
  revalidatePath("/v2/today");
  const { redirect } = await import("next/navigation");
  redirect(`/v2/money?month=${month}&tab=close${r.ok ? "" : `&error=${encodeURIComponent(r.why)}`}`);
}
