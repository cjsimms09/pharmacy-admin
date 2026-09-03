"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { DOCUMENT_CATEGORIES } from "@/db/schema";
import { newId } from "@/lib/crypto";
import { requireManager } from "@/lib/auth";
import { sendTestEmail } from "@/lib/send-mail";
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

/**
 * The sending server, on its own.
 *
 * A separate action rather than a second use of saveMailSettings, because that one reads every
 * field off the form and writes it — so a small form carrying two fields would silently blank the
 * address, the allowed senders and the supplier rules. A form that quietly erases settings it
 * does not mention is the kind of bug nobody notices until the mailbox stops being swept.
 */
export async function saveSendingServer(fd: FormData) {
  const user = await requireManager();
  const here = "/settings/email";
  const host = String(fd.get("mail_smtp_host") ?? "").trim();
  const port = String(fd.get("mail_smtp_port") ?? "").trim();
  if (port && !/^\d{2,5}$/.test(port)) fail(here, "The port should be a number — 465 for SSL, 587 for STARTTLS.");
  await setSetting("mail_smtp_host", host);
  await setSetting("mail_smtp_port", port);
  // Whatever combination worked before may no longer be the one to prefer.
  await setSetting("mail_smtp_working", "");
  await audit({ action: "mail.smtp.update", userId: user.id, userName: user.name, details: `${host}:${port}` });
  revalidatePath(here);
  redirect(`${here}?saved=1&detail=${encodeURIComponent(host ? `Sending server set to ${host}${port ? `:${port}` : ""}. Send a test to check it.` : "Sending server cleared — the site will work it out from the address again.")}`);
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

/**
 * Actually sends something, which nothing here could do before.
 *
 * Reading a mailbox and sending from it are different servers with different ports, and the site
 * could test only the first. So a training email that never arrived looked exactly like one that
 * was never attempted — which is the single worst failure mode for a feature whose whole job is
 * to reach people.
 */
export async function sendTestMail(formData: FormData) {
  await requireManager();
  const to = String(formData.get("to") ?? "");
  const r = await sendTestEmail(to);
  revalidatePath("/settings/email");
  redirect(
    r.ok
      ? `/settings/email?saved=1&detail=${encodeURIComponent(`Sent to ${to} via ${r.via}. If it does not appear within a minute or two, check the spam folder — a first message from a new sender often lands there.`)}`
      : `/settings/email?error=${encodeURIComponent(r.error)}`,
  );
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

/**
 * Files an emailed document against a person.
 *
 * A technician emails her CPR card and it lands here as an attachment with no owner. Everything
 * needed to make it count — whose it is, what it is, when it expires — is knowable only to the
 * person reading the email, so this is where it gets attached. It also creates the credential,
 * for the same reason uploading a card does: the distinction between a file and a thing that
 * expires is one the software cares about and nobody using it does.
 */
export async function fileInboxItem(fd: FormData) {
  const user = await requireManager();
  const itemId = String(fd.get("itemId") ?? "");
  const personId = String(fd.get("personId") ?? "");
  const category = String(fd.get("category") ?? "") as (typeof DOCUMENT_CATEGORIES)[number];
  const expiresOn = String(fd.get("expiresOn") ?? "").trim() || null;
  const noExpiry = fd.get("noExpiry") !== null;
  const issuedOn = String(fd.get("issuedOn") ?? "").trim() || null;
  const number = String(fd.get("number") ?? "").trim() || null;

  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item?.documentId) fail("/inbox", "That attachment is no longer here.");
  if (!personId) fail("/inbox", "Choose whose document it is.");

  const CRED: Record<string, "cpr" | "immunization_training" | "immunization_protocol" | "pharmacist_license" | "technician_registration" | undefined> = {
    cpr_card: "cpr",
    immunization_training: "immunization_training",
    immunization_protocol: "immunization_protocol",
  };
  const person = await db.query.people.findFirst({ where: eq(schema.people.id, personId) });
  const credType =
    CRED[category] ??
    (category === "license"
      ? person?.role === "technician"
        ? "technician_registration"
        : "pharmacist_license"
      : undefined);

  let credentialId: string | null = null;
  if (credType) {
    const held = await db.query.credentials.findFirst({
      where: and(eq(schema.credentials.personId, personId), eq(schema.credentials.type, credType)),
    });
    if (held) {
      credentialId = held.id;
      await db
        .update(schema.credentials)
        .set({
          // Newer paperwork wins on dates — that is the point of sending it in — but a number
          // already recorded is not replaced by a blank one.
          expiresOn: expiresOn ?? held.expiresOn,
          issuedOn: issuedOn ?? held.issuedOn,
          number: number ?? held.number,
          noExpiry: held.noExpiry || noExpiry,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.credentials.id, held.id));
    } else {
      credentialId = newId();
      await db.insert(schema.credentials).values({ id: credentialId, personId, type: credType, number, issuedOn, expiresOn, noExpiry });
    }
  }

  await db
    .update(schema.documents)
    .set({ personId, category, credentialId, expiresOn, noExpiry, effectiveOn: issuedOn })
    .where(eq(schema.documents.id, item.documentId));

  await audit({ action: "inbox.file", userId: user.id, userName: user.name, details: `${category} for ${personId}` });
  revalidatePath("/inbox");
  revalidatePath(`/staff/${personId}`);
  revalidatePath("/compliance");
  revalidatePath("/");
  redirect("/inbox?saved=1");
}
