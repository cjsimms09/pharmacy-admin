"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { decisionFromForm, type FormFields } from "@/lib/bank-decision-form";
import { parseRules, withRule, type PayeeRule } from "@/lib/bank-payee";
import { getSettings, setSetting } from "@/lib/settings";
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

const formatMoney = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * One answer for every line of a payee, and the answer kept for the payee's later lines.
 *
 * The owner, 12 November 2026: "there need to be an EASY way for me to match payments or debits, categorize and fix." The lines are the
 * ones the form was given (every unplaced line of that payee and direction, in any month), each named through `decideBankLine` as the
 * single-line form does, so a refusal on one line (an archived category, a line placed meanwhile) leaves that line as it was and says so.
 * With "keep this answer" ticked the answer is stored as a rule (bank-payee.ts) and applied to the payee's lines as later statements are
 * read (`applyPayeeRules`). A counter-deposit run needs dates per line and is not offered in bulk.
 */
export async function nameBankGroup(fd: FormData): Promise<void> {
  const user = await requireManager();
  const month = String(fd.get("month") ?? "").trim();
  const back = `/money/bank-review?month=${encodeURIComponent(month)}`;
  const stem = String(fd.get("stem") ?? "").trim();
  const direction: "out" | "in" = String(fd.get("direction") ?? "") === "in" ? "in" : "out";
  const keep = String(fd.get("keep") ?? "") === "yes";
  const fields: FormFields = {};
  for (const k of ["what", "category", "vendor", "payer", "receiptKind", "standing", "note"] as const) fields[k] = String(fd.get(k) ?? "");
  const anchor = `#group-${encodeURIComponent(stem)}`;
  if (fields.what === "register_run") redirect(`${back}&error=${encodeURIComponent("A counter deposit needs its register days, line by line. Name those one at a time.")}${anchor}`);
  const today = new Date().toISOString().slice(0, 10);
  const by = `${user.name}, ${today}`;
  const said = `The owner, on the bank page, ${today}.`;

  const ids = fd.getAll("lineId").map(String);
  const rows = ids.length ? await db.select().from(schema.bankLines).where(inArray(schema.bankLines.id, ids)) : [];
  let named = 0;
  let cents = 0;
  const refused: string[] = [];
  for (const row of rows) {
    if (row.placedAs !== "unplaced") continue;
    const read = decisionFromForm(fields, row.amountCents, said);
    if (!read.ok) {
      refused.push(read.why);
      break; // the same form fails the same way on every line: say it once
    }
    const r = await decideBankLine(row.id, read.decision, { id: user.id, name: user.name });
    if (r.ok) {
      named++;
      cents += row.amountCents;
    } else refused.push(r.why);
  }
  if (keep && named > 0 && stem) {
    const rule: PayeeRule = { stem, direction, what: fields.what ?? "", category: fields.category || undefined, vendor: fields.vendor || undefined, standing: fields.standing || undefined, payer: fields.payer || undefined, receiptKind: fields.receiptKind || undefined, by };
    await setSetting("bank_payee_rules", JSON.stringify(withRule(parseRules((await getSettings()).bank_payee_rules), rule)));
  }
  await audit({ action: "bank.group_decided", userId: user.id, userName: user.name, details: `${stem} (${direction}): ${named} line${named === 1 ? "" : "s"} named as ${fields.what}${keep ? ", kept as a rule" : ""}${refused.length ? `; refused: ${refused[0]}` : ""}` });
  revalidatePath("/money/bank-review");
  revalidatePath("/money");
  if (named === 0) redirect(`${back}&error=${encodeURIComponent(refused[0] ?? "Nothing was named.")}${anchor}`);
  redirect(`${back}&ok=${encodeURIComponent(`${named} line${named === 1 ? "" : "s"} named, ${formatMoney(cents)}.${keep ? " Remembered: the next statement's lines from this payee name themselves." : ""}${refused.length ? ` ${refused.length} refused: ${refused[0]}` : ""}`)}`);
}
