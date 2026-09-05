import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { canonicalSupplier } from "./pioneer-catalog";
import type { InvoiceSchedule } from "@/db/schema";

/**
 * The wholesalers this pharmacy buys from, as records rather than as routing rules.
 *
 * This began as a line of free text under the email settings — a fragment, an equals sign, a
 * name — which was enough to route a file and nothing else. A supplier is not a routing rule. It
 * is a party the pharmacy has a DEA-registered relationship with, whose invoices are records it
 * is required to keep for years, and whose silence is itself reportable.
 *
 * The addresses they send from are the load-bearing part. An invoice only files itself if the
 * sender is recognised, so a wholesaler who quietly changes their billing address stops being
 * recorded — and the pharmacy goes on believing its records are complete. Holding those addresses
 * here, against a named supplier, is what lets the site say "nothing from McKesson for 21 days"
 * rather than nothing at all.
 */

export type Supplier = typeof schema.suppliers.$inferSelect;

export async function allSuppliers(includeInactive = false): Promise<Supplier[]> {
  const rows = await db.query.suppliers.findMany({ orderBy: (s, { asc }) => [asc(s.name)] });
  return includeInactive ? rows : rows.filter((r) => r.active);
}

/** Every address any supplier sends from, lowercased, for matching an incoming message. */
export function addressesOf(supplier: Supplier): string[] {
  return supplier.senderEmails
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Which supplier a message came from.
 *
 * Matched on the sender address rather than on the subject, because the address is the part a
 * wholesaler's billing system controls and the subject is the part it changes without telling
 * anybody. A bare domain is accepted as well as a full address, since invoices routinely arrive
 * from a different mailbox at the same company each month.
 */
export function supplierForSender(suppliers: Supplier[], from: string): Supplier | null {
  const sender = (from ?? "").toLowerCase();
  if (!sender) return null;
  let best: { supplier: Supplier; length: number } | null = null;
  for (const s of suppliers) {
    for (const addr of addressesOf(s)) {
      if (!sender.includes(addr)) continue;
      // Longest match wins, so a full address beats a domain that several suppliers share.
      if (!best || addr.length > best.length) best = { supplier: s, length: addr.length };
    }
  }
  return best?.supplier ?? null;
}

/**
 * Which register row a supplier *name* belongs to — the name a catalogue section or an invoice
 * page uses, which is not obliged to be the name the register uses.
 *
 * Matched on the catalogue name the pharmacy recorded, then on the register name, then on the
 * canonical spelling the catalogue reader produces for it, all case- and punctuation-blind. One
 * hit is the answer; none is null; two is a register that names the same wholesaler twice, and
 * the first by name wins so the result is at least stable.
 */
export function supplierRecordFor(suppliers: Supplier[], name: string | null | undefined): Supplier | null {
  const key = squash(name);
  if (!key) return null;
  const canonical = squash(canonicalSupplier(name ?? ""));
  const ranked = [...suppliers].sort((a, b) => a.name.localeCompare(b.name));
  return (
    ranked.find((s) => squash(s.catalogName) === key) ??
    ranked.find((s) => squash(s.name) === key) ??
    ranked.find((s) => squash(s.catalogName) === canonical || squash(s.name) === canonical) ??
    ranked.find((s) => squash(canonicalSupplier(s.name)) === canonical) ??
    null
  );
}

const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export type SupplierInput = {
  name: string;
  senderEmails: string;
  catalogName?: string | null;
  accountNumber?: string | null;
  deaNumber?: string | null;
  phone?: string | null;
  website?: string | null;
  expectedSchedule?: InvoiceSchedule | null;
  notes?: string | null;
};

export async function addSupplier(input: SupplierInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error("A supplier needs a name.");
  const id = newId();
  await db.insert(schema.suppliers).values({
    id,
    name,
    senderEmails: normaliseAddresses(input.senderEmails),
    catalogName: input.catalogName?.trim() || null,
    accountNumber: input.accountNumber?.trim() || null,
    deaNumber: input.deaNumber?.trim() || null,
    phone: input.phone?.trim() || null,
    website: input.website?.trim() || null,
    expectedSchedule: input.expectedSchedule ?? null,
    notes: input.notes?.trim() || null,
  });
  return id;
}

export async function updateSupplier(id: string, input: SupplierInput): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error("A supplier needs a name.");
  await db
    .update(schema.suppliers)
    .set({
      name,
      senderEmails: normaliseAddresses(input.senderEmails),
      catalogName: input.catalogName?.trim() || null,
      accountNumber: input.accountNumber?.trim() || null,
      deaNumber: input.deaNumber?.trim() || null,
      phone: input.phone?.trim() || null,
      website: input.website?.trim() || null,
      expectedSchedule: input.expectedSchedule ?? null,
      notes: input.notes?.trim() || null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.suppliers.id, id));
}

/**
 * Retires a supplier without losing the invoices filed against them.
 *
 * Never deleted. The invoices are records the pharmacy must produce for years after it stops
 * buying from somebody, and a supplier row that vanishes takes the name off every one of them.
 */
export async function retireSupplier(id: string, active: boolean): Promise<void> {
  await db.update(schema.suppliers).set({ active, updatedAt: new Date().toISOString() }).where(eq(schema.suppliers.id, id));
}

/** One address per line, trimmed and lowercased, with the obvious mistakes taken out. */
export function normaliseAddresses(raw: string): string {
  return [
    ...new Set(
      (raw ?? "")
        .split(/[\n,;]/)
        .map((l) => l.trim().toLowerCase().replace(/^mailto:/, "").replace(/^<|>$/g, ""))
        .filter(Boolean),
    ),
  ].join("\n");
}

/**
 * Brings the old free-text rules across, once.
 *
 * The pharmacy already typed its suppliers into a settings box, and asking somebody to type them
 * again into a better box is the sort of thing that leaves half of them untyped — which here
 * means invoices silently not being filed.
 */
export async function importLegacyRules(raw: string): Promise<number> {
  const existing = await allSuppliers(true);
  let added = 0;
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const fragment = t.slice(0, i).trim();
    const name = t.slice(i + 1).trim();
    if (!fragment || !name) continue;
    if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
    await addSupplier({ name, senderEmails: fragment });
    added++;
  }
  return added;
}
