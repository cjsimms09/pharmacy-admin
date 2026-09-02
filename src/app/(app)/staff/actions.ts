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
  await audit({ action: "credential.create", userId: user.id, userName: user.name, entity: "credential", entityId: id, details: data.type });
  revalidatePath(redirectTo);
  revalidatePath("/");
  redirect(`${redirectTo}?saved=1`);
}

export async function updateCredential(id: string, formData: FormData) {
  const user = await requireManager();
  const parsed = credentialSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) fail(String(formData.get("redirectTo") ?? "/staff"), "Check the credential form.");
  const { redirectTo, personId: _p, ...data } = parsed.data;
  await db.update(schema.credentials).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(schema.credentials.id, id));
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
