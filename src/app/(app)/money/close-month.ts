"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";

/**
 * Closing a month from the books page. The owner, 2 October 2026, having asked "can we close sept?" and been told it
 * was ready: "dont see close button?" — the only close control had been on the retired screens. Closing marks the
 * month done; it does not freeze its figures, which the engine recomputes overnight if a late document arrives.
 */
export async function closeMonthFromBooks(fd: FormData): Promise<void> {
  const user = await requireManager();
  const month = String(fd.get("month") ?? "").trim();
  const back = `/money?period=${encodeURIComponent(month)}`;
  if (!/^\d{4}-\d{2}$/.test(month)) redirect(`${back}&error=${encodeURIComponent("Say which month, as YYYY-MM.")}`);
  const { closeMonth } = await import("@/lib/engine/month");
  const r = await closeMonth(month, new Date().toISOString());
  await audit({ action: "month.close", userId: user.id, userName: user.name, entity: "month", entityId: month, details: r.ok ? "closed from the books page" : r.why });
  revalidatePath("/money");
  redirect(`${back}&${r.ok ? `ok=${encodeURIComponent(`${month} is closed.`)}` : `error=${encodeURIComponent(r.why)}`}`);
}
