"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { engineRefresh } from "@/lib/engine/run";

/**
 * The answers on Documents: read an arrival again, teach the site what a sender's files are, take an arrival back
 * out, sweep the mailbox now, add a document by hand. Each writes through the library that owns it and returns to
 * the tab.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function back(fd: FormData, note?: string, error?: string): string {
  const tab = str(fd, "tab") || "arrived";
  return `/v2/documents?tab=${tab}${note ? `&ok=${encodeURIComponent(note)}` : ""}${error ? `&error=${encodeURIComponent(error)}` : ""}`;
}

async function finish(fd: FormData, reason: string, note?: string, error?: string): Promise<void> {
  if (!error) await engineRefresh(reason);
  revalidatePath("/v2/documents");
  revalidatePath("/v2/today");
  const { redirect } = await import("next/navigation");
  redirect(back(fd, note, error));
}

export async function rereadArrival(fd: FormData): Promise<void> {
  const user = await requireManager();
  const itemId = str(fd, "itemId");
  if (!itemId) return finish(fd, "", undefined, "Which arrival?");
  const { rereadInboxItem } = await import("@/lib/mailbox");
  try {
    const text = await rereadInboxItem(itemId, { userId: user.id, userName: user.name });
    return finish(fd, "answer: arrival re-read", text);
  } catch (e) {
    return finish(fd, "", undefined, e instanceof Error ? e.message : String(e));
  }
}

/** This sender's files are this kind: a rule the sweep applies from the next arrival on. */
export async function teachArrival(fd: FormData): Promise<void> {
  const user = await requireManager();
  const itemId = str(fd, "itemId");
  const category = str(fd, "category");
  const note = str(fd, "note");
  if (!itemId || !category) return finish(fd, "", undefined, "Which arrival, and what is it?");
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item?.fromAddress) return finish(fd, "", undefined, "That arrival has no sender to learn from.");
  const { teachSender, describeRule } = await import("@/lib/intake-recognise-store");
  const kept = await teachSender({ fromAddress: item.fromAddress, category, fileName: item.fileName, subject: item.subject, wasGuessedAs: item.routedAs, note: note || null, taughtBy: user.name });
  if (!kept) return finish(fd, "", undefined, "Nothing could be learned from that arrival.");
  await audit({ action: "inbox.teach", userId: user.id, userName: user.name, entity: "inbox_item", entityId: itemId, details: describeRule(kept.rule) });
  return finish(fd, "answer: sender taught", `${describeRule(kept.rule)}${kept.replaced ? " (replaces the earlier rule)" : ""}`);
}

export async function undoArrival(fd: FormData): Promise<void> {
  const user = await requireManager();
  const itemId = str(fd, "itemId");
  if (!itemId) return finish(fd, "", undefined, "Which arrival?");
  const { undoInboxItem } = await import("@/lib/inbox-undo-store");
  const r = await undoInboxItem(itemId, { id: user.id, name: user.name });
  await audit({ action: "inbox.undo", userId: user.id, userName: user.name, entity: "inbox_item", entityId: itemId, details: r.said });
  return finish(fd, "answer: arrival undone", `Taken back out. ${r.said}`);
}

export async function sweepNow(fd: FormData): Promise<void> {
  const user = await requireManager();
  const { sweepMailbox } = await import("@/lib/mailbox");
  try {
    const r = await sweepMailbox({ userId: user.id, userName: user.name });
    return finish(fd, "sweep from Documents", `${r.stored} stored, ${r.rejected} rejected, ${r.ignored} ignored${r.imported ? `, ${r.imported} loaded` : ""}`);
  } catch (e) {
    return finish(fd, "", undefined, e instanceof Error ? e.message : String(e));
  }
}

/** A document added by hand, through the same door the old screen used. */
export async function addDocument(fd: FormData): Promise<void> {
  await requireManager();
  const { uploadDocument } = await import("@/app/(app)/documents/actions");
  fd.set("redirectTo", "/v2/documents?tab=add");
  const r = await uploadDocument(fd);
  if (!r.ok) return finish(fd, "", undefined, r.error);
  return finish(fd, "document added", "Filed.");
}
