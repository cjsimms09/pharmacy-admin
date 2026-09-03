"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { deleteFile } from "@/lib/files";
import { setSetting } from "@/lib/settings";
import { clearMailPassword, describeMailError, saveMailPassword, sweepMailbox, testMailbox } from "@/lib/mailbox";

function fail(path: string, msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(msg)}`);
}

export async function saveMailSettings(fd: FormData) {
  const user = await requireManager();
  const here = "/settings/email";
  const user_ = String(fd.get("mail_user") ?? "").trim();
  const host = String(fd.get("mail_host") ?? "").trim() || "imap.gmail.com";
  const port = String(fd.get("mail_port") ?? "").trim() || "993";
  const senders = String(fd.get("mail_allowed_senders") ?? "").trim();
  const enabled = fd.get("mail_enabled") ? "yes" : "no";
  const autoImport = fd.get("mail_auto_import") ? "yes" : "no";
  const supplierRules = String(fd.get("mail_supplier_rules") ?? "").trim();
  const password = String(fd.get("mail_password") ?? "").trim();

  if (user_ && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user_)) fail(here, "Enter the full email address, for example wwfrxadmin@gmail.com.");
  await setSetting("mail_user", user_);
  await setSetting("mail_host", host);
  await setSetting("mail_port", port);
  await setSetting("mail_allowed_senders", senders);
  await setSetting("mail_enabled", enabled);
  await setSetting("mail_auto_import", autoImport);
  await setSetting("mail_supplier_rules", supplierRules);
  if (password) {
    if (password.replace(/\s+/g, "").length < 12) fail(here, "The app password should be the 16-character code Google gives you (spaces are fine).");
    try {
      await saveMailPassword(password);
    } catch (e) {
      fail(here, e instanceof Error ? e.message : "Could not store the password.");
    }
  }
  await audit({ action: "mail.settings.update", userId: user.id, userName: user.name, details: `${user_} · ${enabled}` });
  const t = await testMailbox();
  revalidatePath(here);
  redirect(t.ok ? `${here}?saved=1&detail=${encodeURIComponent(t.detail)}` : `${here}?error=${encodeURIComponent("Settings saved, but the connection test failed: " + t.error)}`);
}

export async function removeMailPassword() {
  const user = await requireManager();
  await clearMailPassword();
  await setSetting("mail_enabled", "no");
  await audit({ action: "mail.password.clear", userId: user.id, userName: user.name });
  revalidatePath("/settings/email");
  redirect("/settings/email?saved=1");
}

export async function testMailSettings() {
  await requireManager();
  const t = await testMailbox();
  redirect(t.ok ? `/settings/email?saved=1&detail=${encodeURIComponent(t.detail)}` : `/settings/email?error=${encodeURIComponent(t.error)}`);
}

export async function sweepNow(from: "inbox" | "settings" = "inbox") {
  const user = await requireManager();
  const here = from === "inbox" ? "/inbox" : "/settings/email";
  let r;
  try {
    r = await sweepMailbox({ userId: user.id, userName: user.name });
  } catch (e) {
    fail(here, describeMailError(e));
  }
  revalidatePath("/inbox");
  revalidatePath("/settings/email");
  if (r.errors.length > 0 && r.stored + r.rejected + r.ignored === 0) fail(here, r.errors[0]);
  redirect(`${here}?saved=1&detail=${encodeURIComponent(`${r.stored} stored, ${r.rejected} rejected, ${r.ignored} ignored`)}`);
}

export async function deleteInboxItem(id: string) {
  const user = await requireManager();
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, id) });
  if (!item) redirect("/inbox");
  if (item.documentId) {
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) });
    if (doc) {
      await db.delete(schema.documents).where(eq(schema.documents.id, doc.id));
      await deleteFile(doc.storageKey).catch(() => {});
    }
  }
  await db.delete(schema.inboxItems).where(eq(schema.inboxItems.id, id));
  await audit({ action: "inbox.delete", userId: user.id, userName: user.name, entity: "inbox_item", entityId: id, details: item.fileName ?? item.subject });
  revalidatePath("/inbox");
  redirect("/inbox");
}
