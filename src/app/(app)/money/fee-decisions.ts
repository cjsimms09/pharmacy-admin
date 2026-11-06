"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireManager } from "@/lib/auth";
import { decideFee } from "@/lib/payer-fees-store";
import { engineAfter } from "@/lib/engine/run";

/**
 * One press on a payer-fee line on the Money page: count it, leave it out, or give it back to the rule. What the press does to
 * the line, and why one is refused, are decideFee's (payer-fees-store.ts). The accounts are stored by the engine, so a press
 * that changed something asks for a pass, and says that the account follows it rather than that it already has.
 */
export async function decidePayerFee(fd: FormData) {
  const user = await requireManager();
  const back = `/money?period=${encodeURIComponent(String(fd.get("period") ?? ""))}`;
  const word = String(fd.get("to") ?? "");
  const to = word === "count" || word === "leave_out" || word === "reopen" ? word : null;
  if (!to) redirect(`${back}&error=${encodeURIComponent("That press carried no decision. Nothing was changed.")}`);
  const r = await decideFee({ id: user.id, name: user.name }, String(fd.get("key") ?? ""), to);
  if (!r.ok) redirect(`${back}&error=${encodeURIComponent(r.why)}`);
  if (!r.changed) redirect(`${back}&ok=${encodeURIComponent(r.said)}`);
  engineAfter("payer fee decided");
  revalidatePath("/money");
  revalidatePath("/money/monthly");
  redirect(`${back}&ok=${encodeURIComponent(`${r.said} The Payer fees on remittances card shows it now. The account is stored by the engine, which takes decisions up at its next pass: this press asked for one, and one runs on the half-hour at the latest.`)}`);
}
