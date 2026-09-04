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
  if (!(await hasApiKey())) fail("/intake", "Add your Anthropic API key under Settings → Connections so dropped files can be read and sorted for you.");

  const people = await db.query.people.findMany({ where: eq(schema.people.active, true) });
  const names = people.map((p) => `${p.firstName} ${p.lastName}`);

  // Optional hints, for a stack that shares an answer. They override what Claude reads rather
  // than being fed to it: the person filing knows whose stack this is, and a model reading a
  // faded surname off a phone photo does not. Everything else still comes from the document.
  const hintPersonId = String(fd.get("hintPersonId") ?? "").trim() || null;
  const hintCredentialType = String(fd.get("hintCredentialType") ?? "").trim() || null;
  const hinted = people.find((p) => p.id === hintPersonId) ?? null;

  const ids: string[] = [];

  for (const file of files) {
    let stored;
    try {
      stored = await storeFile(file);
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
    try {
      const result = await classifyDocument({ buffer: Buffer.from(await file.arrayBuffer()), mimeType: stored.mimeType, fileName: file.name }, names, {
        userId: user.id,
        userName: user.name,
      });
      const withHints = {
        ...result,
        ...(hinted ? { kind: result.kind === "unknown" ? "person_credential" : result.kind, personName: `${hinted.firstName} ${hinted.lastName}` } : {}),
        ...(hintCredentialType ? { credentialType: hintCredentialType, kind: "person_credential" } : {}),
      };
      await db.update(schema.intakeItems).set({ resultJson: JSON.stringify(withHints) }).where(eq(schema.intakeItems.id, intakeId));
    } catch (e) {
      await db.update(schema.intakeItems).set({ status: "failed", error: describeError(e) }).where(eq(schema.intakeItems.id, intakeId));
    }
  }
  await audit({ action: "intake.dropped", userId: user.id, userName: user.name, details: `${files.length} file(s)` });
  revalidatePath("/intake");
  redirect(ids.length === 1 ? `/intake/${ids[0]}` : "/intake");
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
  const people = await db.query.people.findMany({ where: eq(schema.people.active, true) });
  try {
    const buffer = await readFile(doc.storageKey);
    const result = await classifyDocument(
      { buffer, mimeType: doc.mimeType, fileName: doc.fileName },
      people.map((p) => `${p.firstName} ${p.lastName}`),
      { userId: user.id, userName: user.name },
    );
    await db.update(schema.intakeItems).set({ status: "extracted", error: null, resultJson: JSON.stringify(result) }).where(eq(schema.intakeItems.id, id));
  } catch (e) {
    await db.update(schema.intakeItems).set({ status: "failed", error: describeError(e) }).where(eq(schema.intakeItems.id, id));
    fail(here, describeError(e));
  }
  revalidatePath(here);
  redirect(here);
}
