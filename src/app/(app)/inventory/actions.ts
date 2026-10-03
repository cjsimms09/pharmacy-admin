"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";

const bool = z.string().optional().transform((v) => v === "on");
const optText = (max = 200) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));

const inventorySchema = z.object({
  inventoryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  takenAt: z.enum(["opening", "close", "24h"]),
  timeStarted: optText(20),
  timeEnded: optText(20),
  isKsAnnual: bool,
  isDeaBiennial: bool,
  isPicOutgoing: bool,
  isPicIncoming: bool,
  coversCii: bool,
  coversCiiiV: bool,
  coversDrugsOfConcern: bool,
  notes: optText(2000),
});

export async function createInventory(fd: FormData) {
  const user = await requireManager();
  const parsed = inventorySchema.safeParse(Object.fromEntries(fd.entries()));
  if (!parsed.success) redirect("/inventory?error=" + encodeURIComponent("Check the form: " + parsed.error.issues.map((i) => i.path.join(".")).join(", ")));
  const participantIds = fd.getAll("participantIds").map(String).filter(Boolean);
  const id = newId();
  await db.insert(schema.csInventories).values({ id, ...parsed.data, participantIds: JSON.stringify(participantIds), createdBy: user.id });
  await audit({ action: "cs_inventory.create", userId: user.id, userName: user.name, entity: "cs_inventory", entityId: id, details: parsed.data.inventoryDate });
  revalidatePath("/inventory");
  revalidatePath("/");
  redirect(`/inventory/${id}`);
}

export async function updateInventory(id: string, fd: FormData) {
  const user = await requireManager();
  const parsed = inventorySchema.safeParse(Object.fromEntries(fd.entries()));
  if (!parsed.success) redirect(`/inventory/${id}?error=` + encodeURIComponent("Check the form."));
  const participantIds = fd.getAll("participantIds").map(String).filter(Boolean);
  await db.update(schema.csInventories).set({ ...parsed.data, participantIds: JSON.stringify(participantIds) }).where(eq(schema.csInventories.id, id));
  await audit({ action: "cs_inventory.update", userId: user.id, userName: user.name, entity: "cs_inventory", entityId: id });
  revalidatePath("/inventory");
  revalidatePath(`/inventory/${id}`);
  revalidatePath("/");
  redirect(`/inventory/${id}?saved=1`);
}

export async function deleteInventory(id: string) {
  const user = await requireManager();
  await db.delete(schema.csInventories).where(eq(schema.csInventories.id, id));
  await audit({ action: "cs_inventory.delete", userId: user.id, userName: user.name, entity: "cs_inventory", entityId: id });
  revalidatePath("/inventory");
  revalidatePath("/");
  redirect("/inventory");
}
