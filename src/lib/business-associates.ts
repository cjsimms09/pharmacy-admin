import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso, daysBetween } from "./dates";

/**
 * The vendors who can see patient information, and the agreements that let them.
 *
 * HIPAA requires a business associate agreement with every one of them — 45 CFR 164.502(e) — and
 * the failure is never that nobody signed one. It is that three years later nobody can find it,
 * or it lapsed and the relationship carried on regardless, and the first anyone hears of either
 * is during a breach investigation, when it is the most expensive possible moment to find out.
 *
 * So they are tracked like anything else that expires, and the annual BAA review closes itself
 * off this register rather than asking the pharmacist-in-charge to assert something from memory.
 * A pharmacy that can produce a dated, complete register on request has already answered the
 * hardest question an investigator asks.
 */

export type BaRow = {
  id: string;
  name: string;
  service: string | null;
  contactName: string | null;
  contactEmail: string | null;
  signedOn: string | null;
  expiresOn: string | null;
  noExpiry: boolean;
  documentId: string | null;
  endedOn: string | null;
  notes: string | null;
  /** What is wrong with this entry, if anything. */
  problem: string | null;
  daysLeft: number | null;
};

/** The register, worst first: nothing signed, then lapsed, then expiring, then in order. */
export async function register(): Promise<BaRow[]> {
  const rows = await db.query.businessAssociates.findMany({ orderBy: (b, { asc }) => [asc(b.name)] });
  const today = todayIso();

  const withState = rows.map((b) => {
    const daysLeft = b.expiresOn && !b.noExpiry ? daysBetween(today, b.expiresOn) : null;
    let problem: string | null = null;
    if (b.endedOn && b.endedOn <= today) {
      problem = null; // finished relationships are history, not a problem
    } else if (!b.signedOn) {
      problem = "No signed agreement is recorded. Until one is, this vendor should not have access to patient information.";
    } else if (!b.documentId) {
      problem = "The agreement is recorded but the document itself is not attached, so it cannot be produced on request.";
    } else if (daysLeft !== null && daysLeft < 0) {
      problem = `Expired ${-daysLeft} days ago and the relationship is still open.`;
    } else if (daysLeft !== null && daysLeft <= 60) {
      problem = `Expires in ${daysLeft} days.`;
    }
    return { ...b, daysLeft, problem };
  });

  const rank = (b: (typeof withState)[number]) =>
    b.endedOn ? 4 : !b.signedOn ? 0 : !b.documentId ? 1 : (b.daysLeft ?? 999) < 0 ? 2 : (b.daysLeft ?? 999) <= 60 ? 3 : 5;
  return withState.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Whether the register is in a state the PIC could put in front of an investigator today. */
export async function registerStatus(): Promise<{ total: number; live: number; problems: number; ok: boolean; summary: string }> {
  const rows = await register();
  const live = rows.filter((b) => !b.endedOn);
  const problems = live.filter((b) => b.problem);
  return {
    total: rows.length,
    live: live.length,
    problems: problems.length,
    ok: rows.length > 0 && problems.length === 0,
    summary:
      rows.length === 0
        ? "No business associates are recorded at all. Every vendor that can see patient information needs an agreement, and a register with nothing in it is not evidence that there are none."
        : problems.length === 0
          ? `${live.length} current agreement${live.length === 1 ? "" : "s"}, all signed, attached and in date.`
          : `${problems.length} of ${live.length} need attention: ${problems.map((b) => b.name).join(", ")}.`,
  };
}

export async function upsert(
  input: {
    id?: string;
    name: string;
    service?: string | null;
    contactName?: string | null;
    contactEmail?: string | null;
    signedOn?: string | null;
    expiresOn?: string | null;
    noExpiry?: boolean;
    documentId?: string | null;
    endedOn?: string | null;
    notes?: string | null;
  },
  user: { name: string },
): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error("Name the vendor.");
  if (input.expiresOn && input.noExpiry) {
    throw new Error("An agreement either runs to a date or does not expire — not both. Clear one of them.");
  }

  const values = {
    name,
    service: input.service?.trim() || null,
    contactName: input.contactName?.trim() || null,
    contactEmail: input.contactEmail?.trim() || null,
    signedOn: input.signedOn || null,
    expiresOn: input.noExpiry ? null : input.expiresOn || null,
    noExpiry: Boolean(input.noExpiry),
    endedOn: input.endedOn || null,
    notes: input.notes?.trim() || null,
    updatedAt: new Date().toISOString(),
  };

  if (input.id) {
    // A document is only ever added, never cleared by an edit that did not mention one.
    const set = input.documentId ? { ...values, documentId: input.documentId } : values;
    await db.update(schema.businessAssociates).set(set).where(eq(schema.businessAssociates.id, input.id));
    return input.id;
  }
  const id = newId();
  await db.insert(schema.businessAssociates).values({ ...values, id, documentId: input.documentId ?? null, createdBy: user.name });
  return id;
}

export async function remove(id: string): Promise<void> {
  await db.delete(schema.businessAssociates).where(eq(schema.businessAssociates.id, id));
}
