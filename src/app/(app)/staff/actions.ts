"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { CREDENTIAL_TYPES, PERSON_ROLES } from "@/db/schema";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { storeFile } from "@/lib/files";
import type { DocumentCategory } from "@/db/schema";

/** Default filing category for a document attached to a credential. */
function categoryFor(type: string): DocumentCategory {
  if (type.endsWith("_insurance")) return "insurance";
  if (type === "psao_agreement" || type === "wholesaler_account") return "agreement";
  if (type === "pharmacy_registration") return "pharmacy_registration";
  if (type === "dea_registration") return "dea_registration";
  if (type === "controlled_substance_poa") return "controlled_substance_poa";
  if (type === "cpr") return "cpr_card";
  if (type === "immunization_training") return "immunization_training";
  if (["pharmacist_license", "technician_registration", "intern_registration"].includes(type)) return "license";
  return "other";
}

/** Stores an uploaded file (if any) and links it to a credential. Returns an error message on failure. */
async function attachFile(fd: FormData, opts: { credentialId: string; personId: string | null; type: string; label: string | null; expiresOn: string | null; effectiveOn: string | null; userId: string }): Promise<string | null> {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  try {
    const stored = await storeFile(file);
    await db.insert(schema.documents).values({
      id: newId(),
      category: categoryFor(opts.type),
      title: opts.label || CREDENTIAL_TITLES[opts.type] || "Document",
      fileName: file.name.slice(0, 200),
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      personId: opts.personId,
      credentialId: opts.credentialId,
      effectiveOn: opts.effectiveOn,
      expiresOn: opts.expiresOn,
      uploadedBy: opts.userId,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "The file could not be saved.";
  }
}

const CREDENTIAL_TITLES: Record<string, string> = {
  pharmacy_registration: "Pharmacy registration",
  dea_registration: "DEA registration",
  csos_certificate: "CSOS certificate",
  kmap_enrollment: "KMAP enrollment",
  liability_insurance: "Professional liability insurance",
  property_insurance: "Property / comprehensive insurance",
  workers_comp_insurance: "Workers' compensation insurance",
  cyber_insurance: "Cyber liability insurance",
  business_license: "Business license",
  sales_tax_permit: "Sales tax permit",
  psao_agreement: "PSAO agreement",
  wholesaler_account: "Wholesaler agreement",
  pharmacist_license: "Pharmacist license",
  technician_registration: "Technician registration",
  intern_registration: "Intern registration",
  cpr: "CPR card",
  immunization_training: "Immunization training certificate",
};

const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).transform((v) => (v ? v : null));
const optText = (max = 500) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const bool = z.string().optional().transform((v) => v === "on" || v === "true");

const personSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  role: z.enum(PERSON_ROLES),
  title: optText(100),
  isPic: bool,
  administersVaccines: bool,
  active: bool,
  hiredOn: optDate,
  endedOn: optDate,
  notes: optText(2000),
});

function fail(path: string, msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(msg)}`);
}

export async function createPerson(formData: FormData) {
  const user = await requireManager();
  const parsed = personSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) fail("/staff/new", "Check the form: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const id = newId();
  await db.insert(schema.people).values({ id, ...parsed.data, active: true });
  await audit({ action: "person.create", userId: user.id, userName: user.name, entity: "person", entityId: id, details: `${parsed.data.firstName} ${parsed.data.lastName}` });
  revalidatePath("/staff");
  redirect(`/staff/${id}`);
}

export async function updatePerson(id: string, formData: FormData) {
  const user = await requireManager();
  const parsed = personSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) fail(`/staff/${id}`, "Check the form: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  await db.update(schema.people).set({ ...parsed.data, updatedAt: new Date().toISOString() }).where(eq(schema.people.id, id));
  await audit({ action: "person.update", userId: user.id, userName: user.name, entity: "person", entityId: id });
  revalidatePath("/staff");
  revalidatePath(`/staff/${id}`);
  redirect(`/staff/${id}?saved=1`);
}

const credentialSchema = z.object({
  personId: z.string().optional().transform((v) => (v ? v : null)),
  type: z.enum(CREDENTIAL_TYPES),
  label: optText(100),
  number: optText(100),
  issuer: optText(100),
  issuedOn: optDate,
  expiresOn: optDate,
  notes: optText(1000),
  redirectTo: z.string().default("/staff"),
});

export async function addCredential(formData: FormData) {
  const user = await requireManager();
  const parsed = credentialSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) fail(String(formData.get("redirectTo") ?? "/staff"), "Check the credential form.");
  const { redirectTo, ...data } = parsed.data;
  const id = newId();
  await db.insert(schema.credentials).values({ id, ...data });
  const fileError = await attachFile(formData, { credentialId: id, personId: data.personId, type: data.type, label: data.label, expiresOn: data.expiresOn, effectiveOn: data.issuedOn, userId: user.id });
  await audit({ action: "credential.create", userId: user.id, userName: user.name, entity: "credential", entityId: id, details: data.type });
  revalidatePath(redirectTo);
  revalidatePath("/");
  redirect(fileError ? `${redirectTo}?error=${encodeURIComponent(fileError)}` : `${redirectTo}?saved=1`);
}

export async function updateCredential(id: string, formData: FormData) {
  const user = await requireManager();
  const parsed = credentialSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) fail(String(formData.get("redirectTo") ?? "/staff"), "Check the credential form.");
  const { redirectTo, personId: _p, ...data } = parsed.data;
  await db.update(schema.credentials).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.credentials.id, id));
  const existing = await db.query.credentials.findFirst({ where: eq(schema.credentials.id, id) });
  await attachFile(formData, { credentialId: id, personId: existing?.personId ?? null, type: data.type, label: data.label, expiresOn: data.expiresOn, effectiveOn: data.issuedOn, userId: user.id });
  await audit({ action: "credential.update", userId: user.id, userName: user.name, entity: "credential", entityId: id });
  revalidatePath(redirectTo);
  revalidatePath("/");
  redirect(`${redirectTo}?saved=1`);
}

export async function deleteCredential(id: string, redirectTo: string) {
  const user = await requireManager();
  await db.delete(schema.credentials).where(eq(schema.credentials.id, id));
  await audit({ action: "credential.delete", userId: user.id, userName: user.name, entity: "credential", entityId: id });
  revalidatePath(redirectTo);
  revalidatePath("/");
  redirect(redirectTo);
}

const ceSchema = z.object({
  personId: z.string().min(1),
  completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.coerce.number().min(0.1).max(100),
  title: z.string().trim().min(1).max(200),
  provider: optText(200),
  acpeNumber: optText(100),
  isBoardCourse: bool,
  isLive: bool,
});

export async function addCe(formData: FormData) {
  const user = await requireManager();
  const parsed = ceSchema.safeParse(Object.fromEntries(formData.entries()));
  const personId = String(formData.get("personId") ?? "");
  if (!parsed.success) fail(`/staff/${personId}`, "Check the CE form.");
  const { hours, ...rest } = parsed.data;
  const id = newId();
  await db.insert(schema.ceEntries).values({ id, ...rest, hours: Math.round(hours * 10) });
  await audit({ action: "ce.create", userId: user.id, userName: user.name, entity: "ce", entityId: id });
  revalidatePath(`/staff/${personId}`);
  redirect(`/staff/${personId}?saved=1`);
}

export async function deleteCe(id: string, personId: string) {
  const user = await requireManager();
  await db.delete(schema.ceEntries).where(eq(schema.ceEntries.id, id));
  await audit({ action: "ce.delete", userId: user.id, userName: user.name, entity: "ce", entityId: id });
  revalidatePath(`/staff/${personId}`);
  redirect(`/staff/${personId}`);
}
