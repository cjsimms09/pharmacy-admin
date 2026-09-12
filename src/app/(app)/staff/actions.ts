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
import { endEmployment, reinstate } from "@/lib/offboarding";
import type { DocumentCategory, CredentialType } from "@/db/schema";

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
  // Where training links and reminders go. Staff are not on the pharmacy network, so without
  // this the whole self-service loop falls back to the PIC chasing people in person.
  email: z.string().trim().email().optional().or(z.literal("")).transform((v) => (v ? v : null)),
  mobile: optText(40),
  active: bool,
  // Employed, or here for a fixed spell. A rotation carries its own window; outside it the
  // person is retained but not chased, which is the only way a five-week student can be tracked
  // properly without permanently occupying the dashboard.
  engagement: z.enum(["staff", "rotation"]).default("staff"),
  affiliation: optText(200),
  startsOn: optDate,
  endsOn: optDate,
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
  // Created from the new-employee screen, the next thing wanted is the checklist for this person,
  // not their empty record. Anywhere else, their record is right.
  const next = String(formData.get("next") ?? "");
  redirect(next === "new-hire" ? `/staff/new-hire?person=${id}` : `/staff/${id}`);
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
  noExpiry: bool,
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

/**
 * Records that somebody has left.
 *
 * Nothing is deleted and the wording on the screen says so, because the reason people delete
 * former employees is that they assume the alternative is clutter. It is not: the file has to be
 * producible for years and the person simply stops appearing in the places that ask staff to do
 * things.
 */
export async function endEmploymentAction(formData: FormData) {
  const user = await requireManager();
  const id = String(formData.get("personId") ?? "");
  // Usable from the staff list as well as the person's own page, so it comes back to whichever
  // one it was pressed from. A control that always throws you onto a different screen is a
  // control people stop using.
  const back = String(formData.get("back") ?? "") || `/staff/${id}`;
  try {
    const r = await endEmployment(
      id,
      { endedOn: String(formData.get("endedOn") ?? ""), reason: String(formData.get("reason") ?? "") },
      user,
    );
    await audit({ action: "person.ended", userId: user.id, userName: user.name, details: `${id} ${formData.get("endedOn")}` });
    revalidatePath(`/staff/${id}`);
    revalidatePath("/staff");
    revalidatePath("/");
    const bits = [`${r.name} is recorded as having left. Their whole file is kept and searchable.`];
    if (r.assignmentsCancelled > 0) {
      bits.push(`${r.assignmentsCancelled} outstanding training link${r.assignmentsCancelled === 1 ? "" : "s"} cancelled, so no more reminders go to them.`);
    }
    redirect(`${back}?saved=` + encodeURIComponent(bits.join(" ")));
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
  }
}

export async function reinstateAction(formData: FormData) {
  const user = await requireManager();
  const id = String(formData.get("personId") ?? "");
  const back = String(formData.get("back") ?? "") || `/staff/${id}`;
  try {
    const r = await reinstate(id, user);
    await audit({ action: "person.reinstated", userId: user.id, userName: user.name, details: id });
    revalidatePath(`/staff/${id}`);
    revalidatePath("/staff");
    revalidatePath("/");
    redirect(`${back}?saved=` + encodeURIComponent(`${r.name} is active again. Check their licence and training dates — some may have lapsed while they were away.`));
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
  }
}

/**
 * Records a credential the pharmacist-in-charge has physically seen.
 *
 * The full form asks for a number, an issuer, two dates and the document, and most of the time
 * what actually happened is that somebody put a card on the counter and it was current. Forcing
 * the long form on that means either a fabricated number or — far more often — nothing recorded
 * at all, and nothing recorded is the state this whole site exists to prevent.
 *
 * So this is the short path, and it is honest about being short: the record says it was sighted,
 * by whom, on what date, and that no document was attached. An inspector can tell that apart from
 * a scanned card at a glance, which is the point. The expiry date is still required, because a
 * credential with no date is the one thing worse than no credential — it passes every check while
 * telling you nothing.
 */
export async function markSighted(formData: FormData) {
  const user = await requireManager();
  const personId = String(formData.get("personId") ?? "");
  const type = String(formData.get("type") ?? "") as CredentialType;
  const expiresOn = String(formData.get("expiresOn") ?? "").trim();
  const noExpiry = formData.get("noExpiry") === "on";
  const number = String(formData.get("number") ?? "").trim() || null;
  const here = `/staff/${personId}`;

  if (!personId || !type) fail(here, "Pick a person and a credential.");
  if (!noExpiry && !expiresOn) {
    fail(here, "Put in the expiry date, or tick that it does not expire. A credential with no date passes every check while telling you nothing.");
  }
  if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) fail(here, "That is not a date.");

  await db.insert(schema.credentials).values({
    id: newId(),
    personId,
    type,
    number,
    expiresOn: noExpiry ? null : expiresOn,
    noExpiry,
    notes: `Sighted by ${user.name} on ${new Date().toISOString().slice(0, 10)}. The document itself was not attached.`,
  });
  await audit({ action: "credential.sighted", userId: user.id, userName: user.name, entity: "person", entityId: personId, details: type });
  revalidatePath(here);
  revalidatePath("/staff");
  revalidatePath("/");
  redirect(`${here}?saved=` + encodeURIComponent("Recorded as sighted. Attach the document when you have it — the record says it is not attached until you do."));
}
