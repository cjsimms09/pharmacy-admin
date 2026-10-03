"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { decisionFromForm, type FormFields } from "@/lib/bank-decision-form";
import { decideBankLine } from "../bank";

/**
 * The owner names a bank line on the bank page itself. The reading of the form is pure (bank-decision-form.ts); the
 * writing is `decideBankLine`, the same path Today uses, so a line named here and a line named there are one record.
 * A refusal goes back to the row with its reason; nothing is defaulted.
 */
export async function nameBankLine(fd: FormData): Promise<void> {
  const user = await requireManager();
  const month = String(fd.get("month") ?? "").trim();
  const lineId = String(fd.get("lineId") ?? "").trim();
  const amountCents = Number(fd.get("amountCents") ?? 0);
  const back = `/money/bank-review?month=${encodeURIComponent(month)}`;
  const fields: FormFields = {};
  for (const k of ["what", "category", "vendor", "payer", "receiptKind", "standing", "from", "to", "note"] as const) fields[k] = String(fd.get(k) ?? "");
  const said = `The owner, on the bank page, ${new Date().toISOString().slice(0, 10)}.`;
  const read = decisionFromForm(fields, amountCents, said);
  if (!read.ok) redirect(`${back}&error=${encodeURIComponent(read.why)}#line-${lineId}`);
  const r = await decideBankLine(lineId, read.decision, { id: user.id, name: user.name });
  if (!r.ok) {
    await audit({ action: "bank.line_refused", userId: user.id, userName: user.name, entity: "bank_line", entityId: lineId, details: r.why });
    redirect(`${back}&error=${encodeURIComponent(r.why)}#line-${lineId}`);
  }
  revalidatePath("/money/bank-review");
  revalidatePath("/money");
  redirect(`${back}&ok=${encodeURIComponent(r.said)}#line-${lineId}`);
}
