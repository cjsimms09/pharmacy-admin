"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { engineRefresh } from "@/lib/engine/run";
import { resolveByAnswer } from "@/lib/engine/needs-you";
import { setRule } from "@/lib/engine/rules";

/**
 * The answers on Claims. A decision is written on the claim leg (claim_decisions, keyed by the leg so the next
 * import cannot lose it), the engine recomputes the standing, and the screen returns to where it was. A blank field
 * is a refusal with its reason on the screen, never a default.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
type ClaimDecision = (typeof schema.CLAIM_DECISIONS)[number];
const DECISIONS = new Set<string>(schema.CLAIM_DECISIONS);

function back(fd: FormData, error?: string): string {
  const tab = str(fd, "tab") || "ar";
  const payer = str(fd, "payer");
  return `/v2/claims?tab=${tab}${payer ? `&payer=${encodeURIComponent(payer)}` : ""}${error ? `&error=${encodeURIComponent(error)}` : ""}`;
}

async function finish(fd: FormData, reason: string, error?: string): Promise<void> {
  if (!error) await engineRefresh(reason);
  revalidatePath("/v2/claims");
  revalidatePath("/v2/today");
  revalidatePath("/v2/money");
  const { redirect } = await import("next/navigation");
  redirect(back(fd, error));
}

export async function decideClaim(fd: FormData): Promise<void> {
  const user = await requireManager();
  const legKey = str(fd, "legKey");
  const decision = str(fd, "decision");
  const note = str(fd, "note");
  const revisitOn = str(fd, "revisitOn");
  if (!legKey || !DECISIONS.has(decision)) return finish(fd, "", "No decision chosen.");
  if (decision === "wait" && !/^\d{4}-\d{2}-\d{2}$/.test(revisitOn)) return finish(fd, "", "Waiting needs the day to ask again.");
  const now = new Date().toISOString();
  const existing = await db.query.claimDecisions.findFirst({ where: eq(schema.claimDecisions.legKey, legKey) });
  const values = { decision: decision as ClaimDecision, note: note || null, decidedBy: user.name, decidedAt: now, revisitOn: decision === "wait" ? revisitOn : null, resolvedAt: null };
  if (existing) await db.update(schema.claimDecisions).set(values).where(eq(schema.claimDecisions.id, existing.id));
  else
    await db.insert(schema.claimDecisions).values({
      id: newId(),
      legKey,
      rxNumber: str(fd, "rxNumber"),
      fillNumber: str(fd, "fillNumber") ? Number(str(fd, "fillNumber")) : null,
      dateFilled: str(fd, "dateFilled"),
      bin: str(fd, "bin") || null,
      ...values,
    });
  await audit({ action: "claim.decision", userId: user.id, userName: user.name, entity: "claim_leg", entityId: legKey, details: `${decision}${revisitOn ? ` until ${revisitOn}` : ""}${note ? `: ${note}` : ""}${existing ? ` (was ${existing.decision})` : ""}` });
  const payer = str(fd, "payer");
  if (payer) await resolveByAnswer(`claims_due|${payer}`, now);
  return finish(fd, "answer: claim decision");
}

export async function undoDecision(fd: FormData): Promise<void> {
  const user = await requireManager();
  const legKey = str(fd, "legKey");
  if (!legKey) return finish(fd, "", "Nothing to undo.");
  await db.update(schema.claimDecisions).set({ resolvedAt: new Date().toISOString() }).where(eq(schema.claimDecisions.legKey, legKey));
  await audit({ action: "claim.decision_undone", userId: user.id, userName: user.name, entity: "claim_leg", entityId: legKey, details: "undone" });
  return finish(fd, "answer: claim decision undone");
}

/** A payment that found no claim, tied by hand to the one claim on its prescription and day. Refuses where there is not exactly one. */
export async function tiePayment(fd: FormData): Promise<void> {
  const user = await requireManager();
  const paymentId = str(fd, "paymentId");
  const p = paymentId ? await db.query.claimPayments.findFirst({ where: eq(schema.claimPayments.id, paymentId) }) : null;
  if (!p) return finish(fd, "", "That payment is no longer there.");
  if (p.claimId) return finish(fd, "", "That payment is already tied.");
  if (!p.dateFilled) return finish(fd, "", "The payment names no fill date, so there is nothing to tie it by.");
  const candidates = await db.query.claims.findMany({ where: and(eq(schema.claims.rxNumber, p.rxNumber), eq(schema.claims.dateFilled, p.dateFilled), eq(schema.claims.status, "paid")) });
  if (candidates.length !== 1) return finish(fd, "", candidates.length === 0 ? "No paid claim on that prescription and day." : `${candidates.length} claims share that prescription and day; the site will not guess between them.`);
  await db.update(schema.claimPayments).set({ claimId: candidates[0].id, notes: sql`coalesce(${schema.claimPayments.notes}, '') || ${` Tied by ${user.name} to the one claim on that prescription and day.`}` }).where(eq(schema.claimPayments.id, p.id));
  await audit({ action: "claim.payment_tied", userId: user.id, userName: user.name, entity: "claim_payment", entityId: p.id, details: `to claim ${candidates[0].id}` });
  return finish(fd, "answer: payment tied");
}

/** The owner's own merge: show this payer under another name. Written as a payer_alias rule, which engine/payers.ts reads first. */
export async function aliasPayer(fd: FormData): Promise<void> {
  const user = await requireManager();
  const payer = str(fd, "aliasOf");
  const canonical = str(fd, "canonical");
  if (!payer || !canonical) return finish(fd, "", "Both names are needed.");
  await setRule({ kind: "payer_alias", key: payer, value: { canonical }, saidBy: user.name });
  await audit({ action: "claim.payer_alias", userId: user.id, userName: user.name, entity: "payer", entityId: payer, details: `shown as ${canonical}` });
  fd.set("payer", canonical);
  return finish(fd, "answer: payer alias");
}
