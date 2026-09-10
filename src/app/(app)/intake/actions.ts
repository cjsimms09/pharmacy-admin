"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { CREDENTIAL_TYPES, DOCUMENT_CATEGORIES, TRAINING_TYPES } from "@/db/schema";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { storeFile } from "@/lib/files";
import { classifyDocument, describeError, hasApiKey } from "@/lib/ai";
import { addDays, todayIso } from "@/lib/dates";
import { readBusinessDocument, looksLikeX12Remittance, matchParty, duplicateBill, type BusinessDocT, BUSINESS_KINDS } from "@/lib/business-docs";
import { parseCents } from "@/lib/money";
// A "use server" module may export only async functions, so the list and its type live beside it.
import type { IntakeHint } from "./kinds";

/** The names Claude is given to match a document's party against, and the categories a bill may take. */
async function knownParties() {
  const { allSuppliers } = await import("@/lib/suppliers-registry");
  const { vendors, categories } = await import("@/lib/expenses");
  const [sup, ven, cats] = await Promise.all([allSuppliers(true), vendors(), categories()]);
  return { suppliers: sup.map((x) => x.name), vendors: ven.map((x) => x.name), categories: cats.map((c) => c.name) };
}

/**
 * Reads one stored file the way the queue does: a report the site knows, then an 835, then the
 * business reader, then the compliance classifier for anything the business reader hands over.
 * Returns what to store on the item.
 */
export async function readIntoIntake(
  bytes: Buffer,
  file: { fileName: string; mimeType: string },
  intakeId: string,
  docId: string,
  user: { id: string; name: string },
  hint?: IntakeHint,
): Promise<void> {
  /*
   * A named kind goes to its reader ahead of every guess — but only where naming it changes the
   * outcome.
   *
   * Balance on hand is the case that prompted this and the only one wired so far: it needs a count
   * date, no guess can ask for one, and the reader refuses without it. That is exactly how the
   * owner's upload died with nothing on the screen to do about it.
   *
   * Every other kind falls through to the recogniser below, which is B's and is generally right.
   * The choice is still recorded on the item, so the review page opens on the answer he gave.
   * Wiring the rest is worth doing only where a named kind would actually beat the guess.
   */
  if (hint?.kind === "balance_on_hand") {
    try {
      const { fileOnHand } = await import("@/lib/shelf");
      const r = await fileOnHand(bytes, file.fileName, { userId: user.id }, { countedOn: hint.countedOn ?? undefined, documentId: docId });
      const summary = r.ok
        ? `${r.items.toLocaleString("en-US")} items counted on ${r.countedOn}` +
          (r.replaced ? ", replacing the count already held for that day" : "") +
          (Object.keys(r.skipped).length > 0
            ? `; ${Object.entries(r.skipped).map(([why, n]) => `${n} ${why}`).join(", ")}`
            : "")
        : r.why;
      await db
        .update(schema.intakeItems)
        .set({
          status: r.ok ? "applied" : "extracted",
          ...(r.ok ? { appliedAt: new Date().toISOString() } : {}),
          resultJson: JSON.stringify({ kind: "report", routedAs: "on_hand", summary }),
        })
        .where(eq(schema.intakeItems.id, intakeId));
      // A refusal ends it either way: the reader has said what is wrong, and no model can supply a
      // count date the file does not carry. The sentence is on the item for somebody to act on.
      return;
    } catch (e) {
      void e;
    }
  }

  try {
    const { importDropped } = await import("@/lib/mailbox");
    const routed = await importDropped(bytes, file.fileName, { userId: user.id, userName: user.name }, docId);
    if (routed.recognised) {
      await db
        .update(schema.intakeItems)
        .set({ status: routed.imported ? "applied" : "extracted", resultJson: JSON.stringify({ kind: "report", routedAs: routed.routedAs, summary: routed.routeResult ?? "Recognised and filed." }) })
        .where(eq(schema.intakeItems.id, intakeId));
      return;
    }
  } catch (e) {
    void e;
  }

  /*
   * An 835 as a file needs no model: the parser reads it, the payments go to their fills, the
   * total goes to the bank by the month it was paid, and the file is kept as the remittance.
   */
  if (looksLikeX12Remittance(bytes, file.fileName)) {
    try {
      const { importRemittance } = await import("@/lib/claim-payments");
      const r = await importRemittance(bytes.toString("latin1"), file.fileName, { name: user.name, id: user.id }, { bank: true, documentId: docId });
      const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      await db.update(schema.documents).set({ category: "remittance", title: `Remittance ${r.payer ?? ""} ${r.paidOn ?? ""}`.trim() }).where(eq(schema.documents.id, docId));
      await db
        .update(schema.intakeItems)
        .set({
          status: "applied",
          appliedAt: new Date().toISOString(),
          resultJson: JSON.stringify({
            kind: "report",
            routedAs: "remittance",
            summary:
              `${r.payments} payments from ${r.payer ?? "the payer"} totalling ${money(r.amountCents)}, ${r.matched} matched to a claim, ${r.unmatched} waiting for theirs` +
              (r.alreadyHeld ? `, ${r.alreadyHeld} already held` : "") +
              (r.banked ? `; ${money(r.amountCents)} banked against ${r.paidOn?.slice(0, 7)}` : "") +
              (r.settles ? ". A plan's own remittance settles what the claims already carry, so nothing is counted as revenue twice." : "."),
          }),
        })
        .where(eq(schema.intakeItems.id, intakeId));
      return;
    } catch (e) {
      await db.update(schema.intakeItems).set({ status: "failed", error: describeError(e) }).where(eq(schema.intakeItems.id, intakeId));
      return;
    }
  }

  if (!(await hasApiKey())) {
    await db
      .update(schema.intakeItems)
      .set({ status: "failed", error: "This is not a report the site recognises, and there is no API key set for Claude to read it." })
      .where(eq(schema.intakeItems.id, intakeId));
    return;
  }

  try {
    const doc = await readBusinessDocument({ buffer: bytes, mimeType: file.mimeType, fileName: file.fileName }, await knownParties(), { userId: user.id, userName: user.name });
    if (doc.kind !== "compliance_document" && doc.kind !== "other") {
      await db.update(schema.intakeItems).set({ resultJson: JSON.stringify({ kind: "business", doc }) }).where(eq(schema.intakeItems.id, intakeId));
      return;
    }
    const people = await db.query.people.findMany({ where: eq(schema.people.active, true) });
    const result = await classifyDocument({ buffer: bytes, mimeType: file.mimeType, fileName: file.fileName }, people.map((p) => `${p.firstName} ${p.lastName}`), { userId: user.id, userName: user.name });
    await db.update(schema.intakeItems).set({ resultJson: JSON.stringify({ ...result, businessNotes: doc.notes ?? null }) }).where(eq(schema.intakeItems.id, intakeId));
  } catch (e) {
    await db.update(schema.intakeItems).set({ status: "failed", error: describeError(e) }).where(eq(schema.intakeItems.id, intakeId));
  }
}

function fail(path: string, msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(msg)}`);
}

/**
 * Drop anything in. The file is stored first, so it is never lost even if reading it fails, then
 * Claude proposes what it is and where it belongs. Nothing is filed until the PIC confirms on the
 * review screen — every field there is editable.
 */
export async function dropFiles(fd: FormData) {
  const user = await requireManager();
  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) fail("/intake", "Choose at least one file to add.");
  /*
   * No key is needed for a report the site can read itself, so the door is not shut on the way in.
   * A file Claude would have to read is refused later, per file, with the reason attached to it.
   */

  const people = await db.query.people.findMany({ where: eq(schema.people.active, true) });
  const names = people.map((p) => `${p.firstName} ${p.lastName}`);

  // Optional hints, for a stack that shares an answer. They override what Claude reads rather
  // than being fed to it: the person filing knows whose stack this is, and a model reading a
  // faded surname off a phone photo does not. Everything else still comes from the document.
  const hintPersonId = String(fd.get("hintPersonId") ?? "").trim() || null;
  const hintCredentialType = String(fd.get("hintCredentialType") ?? "").trim() || null;
  /*
   * What the person says the file is, and — for a count — the day it represents.
   *
   * A typed date beats the report's own, because the person adding it knows whether this morning's
   * print is this morning's shelf or yesterday's. Where they leave it blank the file's own date
   * stands, and where neither exists the reader refuses and says so.
   */
  const hintKind = String(fd.get("hintKind") ?? "").trim() || null;
  const hintCountedOn = String(fd.get("hintCountedOn") ?? "").trim() || null;
  const hinted = people.find((p) => p.id === hintPersonId) ?? null;

  const ids: string[] = [];

  for (const file of files) {
    let stored;
    try {
      // Reports and 835s are welcome here too: the queue reads them itself before any model looks.
      stored = await storeFile(file, { allowReportTypes: true });
    } catch (e) {
      fail("/intake", e instanceof Error ? e.message : "Upload failed.");
    }
    const docId = newId();
    await db.insert(schema.documents).values({
      id: docId,
      category: "other",
      title: file.name.replace(/\.[^.]+$/, "").slice(0, 160),
      fileName: file.name.slice(0, 200),
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      uploadedBy: user.id,
    });
    const intakeId = newId();
    await db.insert(schema.intakeItems).values({ id: intakeId, documentId: docId, createdBy: user.id });
    ids.push(intakeId);

    const bytes = Buffer.from(await file.arrayBuffer());
    await readIntoIntake(bytes, { fileName: file.name, mimeType: stored.mimeType }, intakeId, docId, { id: user.id, name: user.name }, { kind: hintKind, countedOn: hintCountedOn });
    /* The optional hints still apply where the compliance classifier answered. */
    if (hinted || hintCredentialType) {
      const it = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, intakeId) });
      const r = it ? (JSON.parse(it.resultJson) as Record<string, unknown>) : null;
      if (r && r.kind !== "report" && r.kind !== "business") {
        const withHints = {
          ...r,
          ...(hinted ? { kind: r.kind === "unknown" ? "person_credential" : r.kind, personName: `${hinted.firstName} ${hinted.lastName}` } : {}),
          ...(hintCredentialType ? { credentialType: hintCredentialType, kind: "person_credential" } : {}),
        };
        await db.update(schema.intakeItems).set({ resultJson: JSON.stringify(withHints) }).where(eq(schema.intakeItems.id, intakeId));
      }
    }
  }
  await audit({
    action: "intake.dropped",
    userId: user.id,
    userName: user.name,
    details: `${files.length} file(s)` + (hintKind ? `, told they are ${hintKind}` : "") + (hintCountedOn ? `, counted on ${hintCountedOn}` : ""),
  });
  revalidatePath("/intake");
  if (ids.length === 1) {
    const it = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, ids[0]) });
    if (it?.status === "applied") {
      const v = JSON.parse(it.resultJson) as { summary?: string };
      redirect(`/intake?saved=1&outcome=${encodeURIComponent(v.summary ?? "Recognised and loaded.")}`);
    }
    redirect(`/intake/${ids[0]}`);
  }
  redirect("/intake");
}

const CRED_SET = new Set<string>(CREDENTIAL_TYPES);
const TRAINING_SET = new Set<string>(TRAINING_TYPES);
const CATEGORY_SET = new Set<string>(DOCUMENT_CATEGORIES);

/** File a reviewed item: update the document, and create the credential, training or CE entry. */
export async function applyIntake(id: string, fd: FormData) {
  const user = await requireManager();
  const here = `/intake/${id}`;
  const item = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, id) });
  if (!item) fail("/intake", "That item is no longer here.");
  if (item.status === "applied") redirect("/intake");

  const g = (k: string) => String(fd.get(k) ?? "").trim();
  const orNull = (v: string) => (v ? v : null);
  const kind = g("kind");
  const personId = orNull(g("personId"));
  const category = CATEGORY_SET.has(g("category")) ? (g("category") as (typeof DOCUMENT_CATEGORIES)[number]) : "other";
  const title = g("title") || "Document";
  const expiresOn = orNull(g("expiresOn"));
  const issuedOn = orNull(g("issuedOn"));

  if ((kind === "person_credential" || kind === "person_training") && !personId) {
    fail(here, "Choose whose document this is, or change where it is filed.");
  }

  let credentialId: string | null = null;

  if (kind === "person_credential" || kind === "pharmacy_credential") {
    const type = CRED_SET.has(g("credentialType")) ? (g("credentialType") as (typeof CREDENTIAL_TYPES)[number]) : "other";
    // Renewing something already on file replaces its dates rather than leaving two rows behind.
    const existing = personId
      ? await db.query.credentials.findFirst({ where: (c, { and, eq: e }) => and(e(c.personId, personId), e(c.type, type)) })
      : await db.query.credentials.findFirst({ where: (c, { and, isNull, eq: e }) => and(isNull(c.personId), e(c.type, type)) });
    const replace = existing && g("replaceExisting") === "on";
    if (replace) {
      credentialId = existing!.id;
      await db
        .update(schema.credentials)
        .set({ number: orNull(g("number")) ?? existing!.number, issuer: orNull(g("issuer")), issuedOn, expiresOn, label: orNull(g("label")), updatedAt: new Date().toISOString() })
        .where(eq(schema.credentials.id, existing!.id));
    } else {
      credentialId = newId();
      await db.insert(schema.credentials).values({
        id: credentialId,
        personId: kind === "person_credential" ? personId : null,
        type,
        label: orNull(g("label")),
        number: orNull(g("number")),
        issuer: orNull(g("issuer")),
        issuedOn,
        expiresOn,
      });
    }
  }

  if (kind === "person_training") {
    const type = TRAINING_SET.has(g("trainingType")) ? (g("trainingType") as (typeof TRAINING_TYPES)[number]) : "other";
    const completedOn = g("completedOn") || issuedOn || todayIso();
    await db.insert(schema.trainings).values({
      id: newId(),
      personId: personId!,
      type,
      label: orNull(g("label")),
      completedOn,
      cycleYear: Number(g("cycleYear")) || Number(completedOn.slice(0, 4)),
      expiresOn: expiresOn ?? addDays(completedOn, 365),
      provider: orNull(g("issuer")),
      documentId: item.documentId,
      createdBy: user.id,
    });
  }

  await db
    .update(schema.documents)
    .set({
      category,
      title: title.slice(0, 200),
      personId: kind.startsWith("person_") ? personId : null,
      credentialId,
      effectiveOn: issuedOn,
      expiresOn,
      notes: orNull(g("notes")),
    })
    .where(eq(schema.documents.id, item.documentId));

  await db.update(schema.intakeItems).set({ status: "applied", appliedAt: new Date().toISOString() }).where(eq(schema.intakeItems.id, id));
  await audit({ action: "intake.applied", userId: user.id, userName: user.name, entity: "document", entityId: item.documentId, details: `${kind} · ${title}` });

  revalidatePath("/intake");
  revalidatePath("/documents");
  revalidatePath("/staff");
  revalidatePath("/");
  if (personId) revalidatePath(`/staff/${personId}`);
  const remaining = await db.query.intakeItems.findMany({ where: eq(schema.intakeItems.status, "extracted") });
  redirect(remaining.length > 0 ? `/intake?saved=1` : `/intake?saved=1&done=1`);
}

/** Keep the file in the vault but stop showing it as needing review. */
export async function dismissIntake(id: string) {
  const user = await requireManager();
  await db.update(schema.intakeItems).set({ status: "discarded" }).where(eq(schema.intakeItems.id, id));
  await audit({ action: "intake.dismissed", userId: user.id, userName: user.name, entity: "intake_item", entityId: id });
  revalidatePath("/intake");
  redirect("/intake?saved=1");
}

/** Remove the item and the file it brought in. */
export async function deleteIntake(id: string) {
  const user = await requireManager();
  const item = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, id) });
  if (item) {
    await db.delete(schema.documents).where(eq(schema.documents.id, item.documentId));
    await db.delete(schema.intakeItems).where(eq(schema.intakeItems.id, id));
  }
  await audit({ action: "intake.deleted", userId: user.id, userName: user.name, entity: "intake_item", entityId: id });
  revalidatePath("/intake");
  redirect("/intake?saved=1");
}

/** Read a stored file again — used when the first attempt failed or the scan was replaced. */
export async function retryIntake(id: string) {
  const user = await requireManager();
  const here = `/intake/${id}`;
  const item = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, id) });
  if (!item) fail("/intake", "That item is no longer here.");
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) });
  if (!doc) fail("/intake", "The file behind this item is missing.");
  const { readFile } = await import("@/lib/files");
  try {
    const buffer = await readFile(doc.storageKey);
    await db.update(schema.intakeItems).set({ status: "extracted", error: null }).where(eq(schema.intakeItems.id, id));
    await readIntoIntake(buffer, { fileName: doc.fileName, mimeType: doc.mimeType }, id, doc.id, { id: user.id, name: user.name });
    const after = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, id) });
    if (after?.status === "failed") fail(here, after.error ?? "Could not read it.");
  } catch (e) {
    await db.update(schema.intakeItems).set({ status: "failed", error: describeError(e) }).where(eq(schema.intakeItems.id, id));
    fail(here, describeError(e));
  }
  revalidatePath(here);
  redirect(here);
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Files a business document where its money goes. Every field on the review card is editable,
 * so what arrives here is the person's answer, with Claude's reading as the default.
 */
export async function applyBusiness(id: string, fd: FormData) {
  const user = await requireManager();
  const here = `/intake/${id}`;
  const item = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, id) });
  if (!item) fail("/intake", "That item is no longer here.");
  if (item.status === "applied") redirect("/intake");
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) });
  if (!doc) fail("/intake", "The file behind this item is missing.");
  const parsed = JSON.parse(item.resultJson) as { kind: string; doc?: BusinessDocT };
  const read = parsed.doc;
  const g = (k: string) => String(fd.get(k) ?? "").trim();
  const orNull = (v: string) => (v ? v : null);
  const kind = g("kind") as (typeof BUSINESS_KINDS)[number];
  if (!BUSINESS_KINDS.includes(kind)) fail(here, "Say what kind of document this is.");
  const dateOk = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const ctx = { userId: user.id, userName: user.name };
  let where = "";
  let outcome = "";

  if (kind === "wholesaler_invoice") {
    const { allSuppliers, addSupplier, rememberSenderEmails } = await import("@/lib/suppliers-registry");
    const { fileInvoice, writeInvoiceLines } = await import("@/lib/invoices");
    const { readFile, deleteFile } = await import("@/lib/files");
    let supplierId = orNull(g("supplierId"));
    let supplierName: string | null = null;
    if (supplierId === "new") {
      const name = g("newSupplierName");
      if (!name) fail(here, "Give the new supplier a name.");
      supplierId = await addSupplier({ name, senderEmails: g("newSupplierEmail") });
      supplierName = name;
      await audit({ action: "supplier.add", userId: user.id, userName: user.name, entity: "supplier", entityId: supplierId, details: `${name}, from the intake` });
    } else if (supplierId) {
      supplierName = (await allSuppliers(true)).find((x) => x.id === supplierId)?.name ?? null;
    }
    if (!supplierId || !supplierName) fail(here, "Say which wholesaler this invoice is from, or add it.");
    const buf = await readFile(doc.storageKey);
    const filed = await fileInvoice(buf, { fileName: doc.fileName, mimeType: doc.mimeType, supplier: supplierName, supplierId, from: "", subject: "" }, ctx);
    const set: Record<string, unknown> = {};
    const num = g("documentNumber");
    const date = g("documentDate");
    const total = parseCents(g("totalCents"));
    const paidOn = g("paidOn");
    if (num) set.invoiceNumber = num;
    if (dateOk(date)) set.invoiceDate = date;
    if (total !== null && total > 0) set.totalCents = total;
    if (dateOk(paidOn)) set.paidOn = paidOn;
    if (Object.keys(set).length) await db.update(schema.supplierInvoices).set(set).where(eq(schema.supplierInvoices.id, filed.id));

    /*
     * Where it came from is learned here, rather than typed on a settings page later.
     *
     * The owner: "Once we get an invoice from a supplier and I tell the system it's an invoice from
     * that supplier it should automatically save that email as where invoices come from." The site
     * has both halves at this exact moment — the message the attachment arrived on knows the sender,
     * and he has just said which wholesaler it is. Asking him to go and type it in is asking him to
     * tell the site something it watched happen.
     *
     * The rule is in `learn-sender.ts`: the full address and never the bare domain, nothing already
     * covered, and nothing another supplier already claims. Filing an invoice must not fail because
     * the register could not be updated, so this cannot throw the filing over.
     */
    let learned: string | null = null;
    try {
      const arrival = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.documentId, doc.id) });
      if (arrival?.fromAddress) {
        const { learnSender } = await import("@/lib/learn-sender");
        const all = await allSuppliers(true);
        const mine = all.find((x) => x.id === supplierId);
        if (mine) {
          const r = learnSender({ id: mine.id, name: mine.name, senderEmails: mine.senderEmails }, arrival.fromAddress, all.map((x) => ({ id: x.id, name: x.name, senderEmails: x.senderEmails })));
          if (r.learn) {
            await rememberSenderEmails(mine.id, r.senderEmails);
            learned = r.why;
            await audit({ action: "supplier.sender.learned", userId: user.id, userName: user.name, entity: "supplier", entityId: mine.id, details: r.why });
          }
        }
      }
    } catch {
      // The invoice is filed either way; a register that could not be updated is not a filing failure.
    }
    try {
      const { pdfText } = await import("@/lib/pdf-text");
      const text = doc.mimeType === "application/pdf" ? pdfText(buf) : "";
      await writeInvoiceLines(filed.id, text, { allowModel: true, user: { id: user.id, name: user.name } });
    } catch {
      /* Lines are read again from the invoices page. */
    }
    // The invoice filer stored its own copy; the intake's row is withdrawn so the vault holds one.
    if (filed.documentId !== doc.id) {
      const others = await db.query.documents.findMany({ where: eq(schema.documents.storageKey, doc.storageKey), columns: { id: true } });
      await db.delete(schema.documents).where(eq(schema.documents.id, doc.id));
      if (others.every((o) => o.id === doc.id)) await deleteFile(doc.storageKey).catch(() => {});
    }
    where = "/inventory/invoices";
    outcome = filed.duplicateOf
      ? `Already on file as ${filed.duplicateOf}; the copy is kept and the money is not counted twice.`
      : `Filed as a ${supplierName} invoice${filed.needsReview ? ", held with the Schedule II records until its schedule is confirmed" : ""}.`;
  } else if (kind === "bill") {
    const { vendors, saveVendor, saveExpense, categories } = await import("@/lib/expenses");
    const cats = await categories();
    let vendorId = orNull(g("vendorId"));
    if (vendorId === "new") {
      const name = g("newVendorName");
      if (!name) fail(here, "Give the new vendor a name.");
      vendorId = await saveVendor({ name, senderEmails: g("newVendorEmail"), categoryId: orNull(g("categoryId")), cadence: (g("newVendorCadence") as "monthly" | "irregular") || "irregular" });
      await audit({ action: "vendor.add", userId: user.id, userName: user.name, entity: "vendor", entityId: vendorId, details: `${name}, from the intake` });
    }
    const categoryId = orNull(g("categoryId"));
    const invoiceDate = g("documentDate");
    const amountCents = parseCents(g("totalCents"));
    const paidOn = g("paidOn");
    if (!dateOk(invoiceDate)) fail(here, "The bill needs its date, as YYYY-MM-DD.");
    if (amountCents === null || amountCents === 0) fail(here, "The bill needs its amount.");
    if (!categoryId || !cats.some((c) => c.id === categoryId)) fail(here, "Say which category the bill belongs to.");
    const held = await db.query.expenses.findMany({ columns: { vendorId: true, invoiceNumber: true, amountCents: true, invoiceDate: true, status: true } });
    const dup = duplicateBill(held.filter((h) => h.status !== "void"), vendorId, g("documentNumber"), amountCents, invoiceDate);
    if (dup && g("force") !== "on") fail(here, `A bill from this vendor with ${dup.invoiceNumber ? `number ${dup.invoiceNumber}` : `the same amount and date`} is already on Spending. Tick "file it anyway" if this is a different bill.`);
    const vendorName = vendorId ? (await vendors()).find((v) => v.id === vendorId)?.name : null;
    const expenseId = await saveExpense({
      vendorId,
      categoryId,
      invoiceNumber: orNull(g("documentNumber")),
      invoiceDate,
      paidOn: dateOk(paidOn) ? paidOn : null,
      amountCents,
      description: orNull(g("description")) ?? read?.summary ?? null,
      documentId: doc.id,
      status: "confirmed",
      source: "manual",
      createdBy: user.id,
    });
    await db.update(schema.documents).set({ category: "bill", title: `${vendorName ?? read?.party ?? "Bill"} ${g("documentNumber") || invoiceDate}`.slice(0, 200), effectiveOn: invoiceDate }).where(eq(schema.documents.id, doc.id));
    await audit({ action: "expense.add", userId: user.id, userName: user.name, entity: "expense", entityId: expenseId, details: `${vendorName ?? read?.party ?? "bill"} ${money(amountCents)} from the intake` });
    where = "/expenses";
    outcome = `${money(amountCents)} from ${vendorName ?? read?.party ?? "the vendor"} is on Spending${dateOk(paidOn) ? `, paid ${paidOn}` : ", not yet paid"}.`;
  } else if (kind === "remittance") {
    const { recordClaimPayment } = await import("@/lib/claim-payments");
    const { addCashReceipt } = await import("@/lib/expenses");
    const payer = g("payer") || read?.remittance?.payer || read?.party || "the payer";
    const paidOn = g("paidOn");
    const trace = orNull(g("traceNumber"));
    const facilitator = /transaction facilitator|\bmtf\b/i.test(payer);
    const claims = read?.remittance?.claims ?? [];
    let posted = 0;
    let matched = 0;
    let sum = 0;
    for (const c of claims) {
      if (!c.rxNumber || !c.paidCents) continue;
      const r = await recordClaimPayment(
        {
          rxNumber: c.rxNumber,
          fillNumber: c.fillNumber ?? null,
          dateFilled: c.serviceDate ?? null,
          source: facilitator ? "mtf" : "plan",
          payer,
          amountCents: c.paidCents,
          revenueCents: facilitator ? c.paidCents : 0,
          receivedOn: dateOk(paidOn) ? paidOn : null,
          reference: [trace, c.rxNumber].filter(Boolean).join("/"),
          notes: `From ${doc.fileName}, read from the remittance advice.`,
        },
        { name: user.name },
      );
      posted++;
      sum += c.paidCents;
      if (r.matched) matched++;
    }
    const total = parseCents(g("totalCents")) ?? read?.remittance?.totalPaidCents ?? sum;
    let banked = false;
    let bankRefused: string | null = null;
    if (g("bank") === "on" && dateOk(paidOn) && total > 0) {
      /*
       * Filed by hand, and gated like anything else a reader produces.
       *
       * This path used to pass no `sourceKey`, no `receivedOn` and no `documentId`. Both gates in
       * `addCashReceipt` are keyed on the source key, so both were skipped: filing the same
       * remittance twice through this screen banked it twice, unconditionally, and with no document
       * on the row the undo could not take it back out again. The automated path has always passed a
       * proper key; this one is the same money arriving through a person.
       *
       * The key is built the same way `importRemittance` builds it, so a remittance filed here and
       * the same remittance arriving later by mailbox are one deposit and not two.
       */
      const r = await addCashReceipt({
        month: paidOn.slice(0, 7),
        kind: facilitator ? "facilitator" : "third_party",
        amountCents: total,
        payer,
        notes: `From ${doc.fileName}${trace ? `, trace ${trace}` : ""}.`,
        documentId: doc.id,
        sourceKey: `835|${(payer ?? "").trim().toLowerCase()}|${trace ?? doc.fileName}|${paidOn}`,
        receivedOn: paidOn,
        reference: trace ?? null,
        createdBy: user.id,
      });
      if (r.duplicate) bankRefused = r.why;
      else banked = true;
    }
    await db.update(schema.documents).set({ category: "remittance", title: `Remittance ${payer} ${paidOn || ""}`.trim().slice(0, 200), effectiveOn: dateOk(paidOn) ? paidOn : null }).where(eq(schema.documents.id, doc.id));
    await audit({ action: "remittance.filed", userId: user.id, userName: user.name, entity: "document", entityId: doc.id, details: `${payer} ${money(total)} ${posted} payments from the intake` });
    where = "/claims";
    outcome = `${posted} payments from ${payer} posted, ${matched} matched to a claim${banked ? `; ${money(total)} banked against ${paidOn.slice(0, 7)}` : bankRefused ? `; not banked — ${bankRefused}` : ""}${facilitator ? "" : ". A plan's own remittance settles what the claims already carry, so nothing is counted twice"}.`;
  } else if (kind === "rebate_statement") {
    const { saveExpense, categories, addCategory, addCashReceipt } = await import("@/lib/expenses");
    const { allSuppliers } = await import("@/lib/suppliers-registry");
    const supplierId = orNull(g("supplierId"));
    const supplierName = supplierId ? (await allSuppliers(true)).find((x) => x.id === supplierId)?.name ?? null : null;
    const amountCents = parseCents(g("totalCents"));
    const date = g("documentDate");
    if (amountCents === null || amountCents <= 0) fail(here, "The rebate the statement settles, in dollars.");
    if (!dateOk(date)) fail(here, "The statement's date, or the last day of the period it covers.");
    let cat = (await categories()).find((c) => c.name === "Wholesaler rebates") ?? null;
    if (!cat) cat = await addCategory({ name: "Wholesaler rebates", kind: "cost_of_goods" });
    const receivedOn = g("paidOn");
    const expenseId = await saveExpense({
      categoryId: cat.id,
      invoiceNumber: orNull(g("documentNumber")),
      invoiceDate: date,
      paidOn: dateOk(receivedOn) ? receivedOn : null,
      amountCents: -amountCents,
      description: `${supplierName ?? read?.party ?? "Wholesaler"} rebate statement${read?.periodFrom ? ` ${read.periodFrom} to ${read.periodTo ?? ""}` : ""}`.trim(),
      documentId: doc.id,
      status: "confirmed",
      source: "manual",
      createdBy: user.id,
    });
    let banked = false;
    if (g("bank") === "on" && dateOk(receivedOn)) {
      await addCashReceipt({ month: receivedOn.slice(0, 7), kind: "rebate", amountCents, payer: supplierName ?? read?.party ?? null, notes: `From ${doc.fileName}.`, createdBy: user.id });
      banked = true;
    }
    await db.update(schema.documents).set({ category: "supplier_statement", title: `${supplierName ?? read?.party ?? "Wholesaler"} rebate statement ${date}`.slice(0, 200), effectiveOn: date }).where(eq(schema.documents.id, doc.id));
    await audit({ action: "expense.add", userId: user.id, userName: user.name, entity: "expense", entityId: expenseId, details: `rebate statement ${money(amountCents)} from the intake` });
    where = "/expenses";
    outcome = `${money(amountCents)} of rebate on Spending under Wholesaler rebates for ${date.slice(0, 7)}; it replaces the estimate for that month${banked ? `, and is banked against ${receivedOn.slice(0, 7)}` : ""}.`;
  } else {
    const category =
      kind === "supplier_statement" || kind === "credit_memo" ? "supplier_statement" : kind === "bank_statement" ? "bank_statement" : kind === "sales_summary" ? "report" : "other";
    const title = g("title") || read?.summary || doc.fileName;
    await db.update(schema.documents).set({ category, title: title.slice(0, 200), notes: orNull(g("notes")) ?? read?.notes ?? null, effectiveOn: dateOk(g("documentDate")) ? g("documentDate") : null }).where(eq(schema.documents.id, doc.id));
    where = "/records";
    outcome =
      kind === "sales_summary"
        ? "Filed in the vault. The figures are read from the report's own export: email or drop the CSV and it loads itself."
        : kind === "bank_statement"
          ? "Filed in the vault. Reading the bank's statement in is the next thing to build; until then bank the deposits on the books page."
          : `Filed in the vault under ${category.replace(/_/g, " ")}.`;
  }

  await db.update(schema.intakeItems).set({ status: "applied", appliedAt: new Date().toISOString(), resultJson: JSON.stringify({ ...parsed, filedAs: kind, outcome }) }).where(eq(schema.intakeItems.id, id));
  await audit({ action: "intake.applied", userId: user.id, userName: user.name, entity: "document", entityId: item.documentId, details: `${kind} · ${outcome.slice(0, 160)}` });
  for (const p of ["/intake", "/expenses", "/money", "/money/monthly", "/inventory/invoices", "/claims", "/records", "/"]) revalidatePath(p);
  const remaining = await db.query.intakeItems.findMany({ where: eq(schema.intakeItems.status, "extracted") });
  redirect(`/intake?saved=1${remaining.length === 0 ? "&done=1" : ""}&outcome=${encodeURIComponent(outcome)}&where=${encodeURIComponent(where)}`);
}

/** Read again as a different kind than Claude chose, keeping its figures: the review page re-renders for the kind asked. */
export async function readAgainAs(id: string, kind: string) {
  await requireManager();
  const item = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, id) });
  if (!item) fail("/intake", "That item is no longer here.");
  redirect(`/intake/${id}?as=${encodeURIComponent(kind)}`);
}
