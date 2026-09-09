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
import { setSetting } from "@/lib/settings";
import { clearMailPassword, describeMailError, saveMailPassword, sweepMailbox, testMailbox, rereadInboxItem } from "@/lib/mailbox";

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
  await setSetting("training_attach_material", fd.get("training_attach_material") ? "yes" : "");
  // Whatever combination worked before may no longer be the one to prefer.
  await setSetting("mail_smtp_working", "");
  await audit({ action: "mail.smtp.update", userId: user.id, userName: user.name, details: `${host}:${port}` });
  revalidatePath(here);
  redirect(`${here}?saved=1&detail=${encodeURIComponent(host ? `Sending server set to ${host}${port ? `:${port}` : ""}. Send a test to check it.` : "Sending server cleared — the site will work it out from the address again.")}`);
}

/**
 * Sends the weekly note now, whatever the schedule says.
 *
 * Worth a button for the same reason the test message is: a weekly email that has never been
 * seen is one nobody trusts, and waiting a week to find out whether it works is not a test.
 */
export async function sendDigestNow() {
  await requireManager();
  const { sendWeeklyDigest } = await import("@/lib/digest");
  const r = await sendWeeklyDigest({ force: true });
  revalidatePath("/settings/email");
  redirect(`/settings/email?${r.sent ? "saved=1&detail" : "error"}=` + encodeURIComponent(r.reason));
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

/**
 * Takes an item off this list. It does not destroy what was stored.
 *
 * It used to. Pressing Delete deleted the document the attachment had been filed as, and its file
 * off the disk, with a button that said only "Delete" — so tidying an inbox threw away a supplier
 * invoice this pharmacy is required to keep for five years, left the invoice record pointing at a
 * document that no longer existed, and put a hole in the Schedule II archive that nothing on any
 * screen would have revealed.
 *
 * The inbox is a log of what arrived and what was made of it. Clearing a line off it is a
 * housekeeping act. Destroying a record the pharmacy is required to hold is not the same act and
 * must not be reachable from the same button — a document that should genuinely go is deleted from
 * the document vault, where what depends on it can be seen.
 */
export async function deleteInboxItem(id: string) {
  const user = await requireManager();
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, id) });
  if (!item) redirect("/inbox");

  /*
   * Nothing was ever stored, so there is nothing to keep.
   *
   * A rejected or ignored item has no document behind it — the attachment was never accepted. The
   * row is the whole of it, and removing the row loses nothing but the line.
   */
  await db.delete(schema.inboxItems).where(eq(schema.inboxItems.id, id));
  await audit({
    action: "inbox.clear",
    userId: user.id,
    userName: user.name,
    entity: "inbox_item",
    entityId: id,
    details: `${item.fileName ?? item.subject}${item.documentId ? " — the stored document was kept" : ""}`,
  });
  revalidatePath("/inbox");
  redirect("/inbox?ok=" + encodeURIComponent(
    item.documentId
      ? "Taken off this list. What was stored is untouched — it is still in the document vault and still filed wherever it was filed."
      : "Taken off this list. Nothing was stored for it, so nothing was lost.",
  ));
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

/** Reads a stored attachment again with today's rules — after a supplier's address was added, say. */
export async function rereadItem(itemId: string) {
  const user = await requireManager();
  try {
    const text = await rereadInboxItem(itemId, { userId: user.id, userName: user.name });
    revalidatePath("/inbox");
    redirect(`/inbox?ok=${encodeURIComponent(text)}`);
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    fail("/inbox", e instanceof Error ? e.message : "Could not read that again.");
  }
}


/**
 * A stored attachment the mailbox could not place, handed to the intake to be read and filed.
 *
 * Forwarding an invoice to the mailbox is the easiest way to get it here from a phone; this is
 * what happens next. The same document row is used, so the vault holds one copy.
 */
export async function sortInboxItem(itemId: string) {
  const { requireManager } = await import("@/lib/auth");
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { newId } = await import("@/lib/crypto");
  const { readFile } = await import("@/lib/files");
  const { readIntoIntake } = await import("../intake/actions");
  const user = await requireManager();
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item?.documentId) redirect("/inbox?error=" + encodeURIComponent("Nothing was stored for that line."));
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) });
  if (!doc) redirect("/inbox?error=" + encodeURIComponent("The file behind that line is missing."));
  const existing = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.documentId, doc.id) });
  const intakeId = existing?.id ?? newId();
  if (!existing) await db.insert(schema.intakeItems).values({ id: intakeId, documentId: doc.id, createdBy: user.id });
  else await db.update(schema.intakeItems).set({ status: "extracted", error: null }).where(eq(schema.intakeItems.id, intakeId));
  const bytes = await readFile(doc.storageKey);
  await readIntoIntake(bytes, { fileName: doc.fileName, mimeType: doc.mimeType }, intakeId, doc.id, { id: user.id, name: user.name });
  const { audit } = await import("@/lib/audit");
  await audit({ action: "inbox.sorted", userId: user.id, userName: user.name, entity: "document", entityId: doc.id, details: `${doc.fileName} handed to the intake` });
  revalidatePath("/inbox");
  revalidatePath("/intake");
  redirect(`/intake/${intakeId}`);
}

/**
 * Say who a file came from, from the line it arrived on, and never be asked again.
 *
 * A catalogue that arrives from an address the register does not know is refused for naming a
 * supplier the site has never heard of — which is right, because loading ParMed's prices under
 * McKesson would send orders to the wrong place. What was wrong is what happened next: the only
 * way out was to leave the inbox, find the Suppliers page, add the supplier, remember to type the
 * address it sends from, come back, and press "read it again". Three steps across two screens,
 * with nothing on the screen that had the problem saying any of it.
 *
 * So it is one press here. Pick the supplier, or type a new one; the address the file came from is
 * recorded against them, so every future file from it places itself; and the file is read again at
 * once, so the answer is on screen rather than promised. That is the whole of "I should only have
 * to do this once".
 */
export async function attributeInboxItem(fd: FormData) {
  const user = await requireManager();
  const itemId = String(fd.get("itemId") ?? "");
  const chosen = String(fd.get("supplierId") ?? "").trim();
  const newName = String(fd.get("newSupplier") ?? "").trim();

  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item) fail("/inbox", "That line is no longer here.");
  const from = (item.fromAddress ?? "").trim().toLowerCase();
  if (!from) fail("/inbox", "That line carries no sending address, so there is nothing to remember it by.");
  if (!chosen && !newName) fail("/inbox", "Pick a supplier, or type the name of a new one.");

  const { allSuppliers, addSupplier, updateSupplier, addressesOf, normaliseAddresses } = await import("@/lib/suppliers-registry");
  const all = await allSuppliers(true);

  let supplierId = chosen;
  let supplierName = all.find((s) => s.id === chosen)?.name ?? newName;
  if (!supplierId) {
    // Typing a name that already exists is a correction, not a duplicate: the register keeps one row per supplier.
    const already = all.find((s) => s.name.trim().toLowerCase() === newName.toLowerCase());
    if (already) {
      supplierId = already.id;
      supplierName = already.name;
    } else {
      supplierId = await addSupplier({ name: newName, catalogName: newName, addresses: from, active: true } as never);
      supplierName = newName;
      await audit({ action: "supplier.add", userId: user.id, userName: user.name, entity: "supplier", entityId: supplierId, details: `${newName}, from the inbox` });
    }
  }

  // Whether it was picked or just made, the address it sends from goes on the register.
  const supplier = (await allSuppliers(true)).find((s) => s.id === supplierId);
  if (supplier) {
    const held = addressesOf(supplier);
    if (!held.map((a) => a.toLowerCase()).includes(from)) {
      await updateSupplier(supplierId, {
        ...(supplier as unknown as Record<string, unknown>),
        addresses: normaliseAddresses([...held, from].join(", ")),
      } as never);
      await audit({ action: "supplier.address.add", userId: user.id, userName: user.name, entity: "supplier", entityId: supplierId, details: `${from} is ${supplierName}` });
    }
  }

  // And read it again now, with the rule that was just made.
  try {
    const text = await rereadInboxItem(itemId, { userId: user.id, userName: user.name });
    revalidatePath("/inbox");
    revalidatePath("/suppliers");
    redirect(`/inbox?ok=${encodeURIComponent(`${from} is ${supplierName} from now on. ${text}`)}`);
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    revalidatePath("/inbox");
    revalidatePath("/suppliers");
    fail("/inbox", `${from} is recorded as ${supplierName}, but the file still would not read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * "That is not what this is." Said once, on the line that has the problem, and never asked again.
 *
 * BACKLOG item 5 in the owner's words: the inbox should work out what arrived, *and* he has to be
 * able to tell it what arrived. The second half is the important one. A guess that cannot be
 * overridden is worse than no guess, because the document goes somewhere wrong and goes there
 * silently — so the override lives here, on the page, on the line, in a sentence.
 *
 * What is kept is a rule about the sender rather than a fact about this file, which is the whole
 * point: next Sunday's file from the same address places itself. The rule is narrowed to a
 * fragment of the file name when the file's own columns said something different, because a
 * supplier who sends invoices and catalogues from one address must not have their catalogue filed
 * as an invoice by a rule made in good faith about an invoice.
 */
export async function teachInboxItem(fd: FormData) {
  const user = await requireManager();
  const itemId = String(fd.get("itemId") ?? "");
  const category = String(fd.get("category") ?? "").trim();
  const note = String(fd.get("note") ?? "").trim() || null;
  if (!category) fail("/inbox", "Pick what this document is.");

  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item) fail("/inbox", "That line is no longer here.");
  const from = (item.fromAddress ?? "").trim().toLowerCase();
  if (!from) fail("/inbox", "That line carries no sending address, so there is nothing to remember it by.");

  const { teachSender, recogniseStored } = await import("@/lib/intake-recognise-store");
  const { categoryFor } = await import("@/lib/intake-recognise");
  if (!categoryFor(category)) fail("/inbox", "That is not something the site knows how to keep.");

  /*
   * Whether the file's own contents pointed somewhere else, which decides the shape of the rule.
   * Read now rather than remembered, so the rule is written against what is true today.
   */
  const before = await recogniseStored(itemId);
  const contentDisagreed = Boolean(before?.ranked.some((g) => g.category !== category && g.sure === "certain"));

  const kept = await teachSender({
    fromAddress: from,
    category,
    fileName: item.fileName,
    subject: item.subject,
    wasGuessedAs: before?.best?.category ?? item.routedAs ?? null,
    contentDisagreed,
    note,
    taughtBy: user.id,
  });
  if (!kept) fail("/inbox", "That could not be remembered as a rule.");

  await audit({
    action: "inbox.taught",
    userId: user.id,
    userName: user.name,
    entity: "inbox_item",
    entityId: itemId,
    details: `${from} → ${category}${kept.rule.fileName ? ` (files named like “${kept.rule.fileName}”)` : ""}${note ? `: ${note}` : ""}`,
  });

  /*
   * And read it again now, with the rule that was just made, so the answer is on screen rather
   * than promised. The same principle as naming a supplier from this page.
   */
  let text = "";
  try {
    text = await rereadInboxItem(itemId, { userId: user.id, userName: user.name });
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    text = `It still would not read: ${e instanceof Error ? e.message : String(e)}`;
  }
  const { describeRule } = await import("@/lib/intake-recognise-store");
  revalidatePath("/inbox");
  redirect(`/inbox?ok=${encodeURIComponent(`${describeRule(kept.rule)}${kept.replaced ? " (replacing what was there before.)" : ""} ${text}`)}`);
}

/** Undoing a rule, from the same page that lists them. A rule nobody can remove is a rule nobody dares write. */
export async function forgetIntakeRule(id: string) {
  const user = await requireManager();
  const { forgetRule } = await import("@/lib/intake-recognise-store");
  await forgetRule(id);
  await audit({ action: "inbox.rule.forget", userId: user.id, userName: user.name, entity: "intake_rule", entityId: id, details: "Rule removed from the inbox" });
  revalidatePath("/inbox");
  redirect("/inbox?ok=" + encodeURIComponent("Forgotten. Mail from that sender will be worked out from scratch again."));
}

/**
 * A document the recogniser placed wrongly, loaded again as what a person says it is.
 *
 * The owner: "I NEED TO BE ABLE TO MAKE SURE IT DID THE RIGHT THING WITH THE DOCUMENT AND NEED TO
 * BE ABLE TO FIX ANY ISSUES WITH HOW IT WAS RECEIVED OR SORTED." Until now a wrong decision was a
 * dead end — the line explained what it had done and there was nothing to press. Asked which of
 * the things that could go wrong worries him most, he said this one: a document filed as the wrong
 * kind.
 *
 * It runs the same loading path the sweep runs, told the answer rather than asked for one, against
 * the file already stored. So a catalogue read as an invoice becomes a catalogue by the same code
 * that would have loaded it correctly in the first place, and there is no second implementation of
 * loading to keep in step with the first.
 *
 * What it does not do is undo. Where the wrong reading already changed the tables — a catalogue
 * loaded as claims — re-routing loads the right thing and leaves the wrong thing where it is. That
 * is the harder half and it is honest to say so on the screen rather than imply a repair that did
 * not happen.
 */
export async function reRouteInboxItem(fd: FormData) {
  const itemId = String(fd.get("itemId") ?? "");
  const kind = String(fd.get("kind") ?? "").trim();
  if (!itemId || !kind) fail("/inbox", "Choose what the document is before re-routing it.");

  const { requireManager } = await import("@/lib/auth");
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { readFile } = await import("@/lib/files");
  const { importDropped } = await import("@/lib/mailbox");
  const { audit } = await import("@/lib/audit");
  const user = await requireManager();

  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item?.documentId) fail("/inbox", "Nothing was stored for that line, so there is nothing to re-route.");
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item!.documentId!) });
  if (!doc) fail("/inbox", "The file behind that line is missing.");

  try {
    const buf = await readFile(doc!.storageKey);
    const was = item!.routedAs ?? "unrecognised";
    const r = await importDropped(
      buf,
      doc!.fileName,
      { userId: user.id, userName: user.name },
      doc!.id,
      kind as Parameters<typeof importDropped>[4],
    );
    /*
     * The line records that a person decided this, and what it was before. An inbox that quietly
     * rewrites its own history is one nobody can audit — and "it always said catalogue" is exactly
     * what somebody would remember afterwards.
     */
    await db
      .update(schema.inboxItems)
      .set({
        routedAs: r.routedAs,
        routeResult: `Re-routed by ${user.name} from "${was}". ${r.routeResult ?? ""}`.trim(),
        status: r.imported ? "stored" : item!.status,
      })
      .where(eq(schema.inboxItems.id, itemId));
    await audit({
      action: "inbox.rerouted",
      userId: user.id,
      userName: user.name,
      entity: "document",
      entityId: doc!.id,
      details: `${doc!.fileName}: ${was} → ${kind}. ${r.routeResult ?? "nothing loaded"}`.slice(0, 300),
    });
    revalidatePath("/inbox");
    redirect(`/inbox?ok=${encodeURIComponent(`Re-routed as ${kind}. ${r.routeResult ?? "Nothing was loaded."}`)}`);
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    fail("/inbox", e instanceof Error ? e.message : "Could not re-route that document.");
  }
}
