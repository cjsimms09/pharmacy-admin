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
 * The other names this supplier's own paperwork uses for itself, as the pharmacy typed them.
 *
 * Empty for a supplier nobody has had to spell twice, which is the common case and means the
 * register name and the catalogue name stand alone.
 */
export function aliasesOf(supplier: Supplier): string[] {
  return (supplier.aliases ?? "")
    .split("\n")
    .map((l) => l.trim())
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
 * aliases it typed, then on the canonical spelling the catalogue reader produces for it, all case-
 * and punctuation-blind. One hit is the answer; none is null; two is a register that names the same
 * wholesaler twice, and the first by name wins so the result is at least stable.
 *
 * ── Every comparison here is equality, and that is the point ──
 *
 * The rebate arithmetic used to reach a supplier from an invoice line by asking whether either
 * name contained the other. That is unsafe in both directions.
 *
 * The direction that has already cost money leaves a gap: the row named "IPC" neither contains nor
 * is contained by "Independent Pharmacy Cooperative", the name printed on its own invoices, so all
 * eight invoice lines on the database matched nothing and left the rebate figures without a word.
 *
 * The direction that has not fired yet is worse, because it produces a figure rather than a hole.
 * The test also asked whether the register's name contained the printed one, took the first hit and
 * had no tie-break. A line printed "IP" is contained in both "IPC" and "IPD", so which wholesaler's
 * ladder it lands on would be settled by the order of the register rather than by anything on the
 * invoice — and a rebate claimed on another supplier's spend is a wrong number that looks right.
 *
 * So a name that is not the register's, not the catalogue's and not an alias the pharmacy typed
 * returns null, and the caller says the line is unplaced rather than guessing at it.
 */
export function supplierRecordFor(suppliers: Supplier[], name: string | null | undefined): Supplier | null {
  const key = squash(name);
  if (!key) return null;
  const canonical = squash(canonicalSupplier(name ?? ""));
  const ranked = [...suppliers].sort((a, b) => a.name.localeCompare(b.name));
  return (
    ranked.find((s) => squash(s.catalogName) === key) ??
    ranked.find((s) => squash(s.name) === key) ??
    ranked.find((s) => aliasesOf(s).some((a) => squash(a) === key)) ??
    ranked.find((s) => squash(s.catalogName) === canonical || squash(s.name) === canonical) ??
    ranked.find((s) => aliasesOf(s).some((a) => squash(canonicalSupplier(a)) === canonical)) ??
    ranked.find((s) => squash(canonicalSupplier(s.name)) === canonical) ??
    null
  );
}

const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export type SupplierInput = {
  name: string;
  senderEmails: string;
  catalogName?: string | null;
  /** One alternate spelling per line; see `aliasesOf`. */
  aliases?: string | null;
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
    aliases: normaliseAliases(input.aliases ?? ""),
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
      aliases: normaliseAliases(input.aliases ?? ""),
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
 * Records one more address a supplier sends invoices from, and touches nothing else.
 *
 * Deliberately not `updateSupplier`, which writes every column: called with a partial it would
 * blank the account number, the DEA number, the phone, the aliases and the notes — the fields the
 * owner typed in by hand. Learning an address must never cost him one of those.
 */
export async function rememberSenderEmails(id: string, senderEmails: string): Promise<void> {
  await db
    .update(schema.suppliers)
    .set({ senderEmails: normaliseAddresses(senderEmails), updatedAt: new Date().toISOString() })
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

/**
 * Whether this supplier publishes a catalogue at all.
 *
 * "I NEED AN OPTION ON SUPPLIER OPTIONS TO NOT EXPECT CATALOG!" — the same fault `noRebates` was
 * added to fix, in a second place. A supplier with no price file read as "none filed under this
 * supplier" for ever, whether or not one was ever coming.
 *
 * Who said so and when, because "nobody has loaded one" and "there is none" are different facts
 * and only the second is somebody's decision.
 */
export async function setNoCatalogue(id: string, none: boolean, user: { name: string }): Promise<void> {
  await db
    .update(schema.suppliers)
    .set(
      none
        ? { noCatalogue: true, noCatalogueBy: user.name, noCatalogueAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        : { noCatalogue: false, noCatalogueBy: null, noCatalogueAt: null, updatedAt: new Date().toISOString() },
    )
    .where(eq(schema.suppliers.id, id));
}

/**
 * Whether this wholesaler's PioneerRx receipt counts as the invoice.
 *
 * The owner: "there are a couple suppliers where I'd rather just use the pioneers invoice as the
 * invoice." It changes no arithmetic — the cash account already counts every PioneerRx purchase no
 * invoice covers — only whether the pharmacy is still going to go and ask for one.
 */
export async function useReceiptAsInvoice(id: string, on: boolean): Promise<void> {
  await db
    .update(schema.suppliers)
    .set({ invoiceFromPioneer: on, updatedAt: new Date().toISOString() })
    .where(eq(schema.suppliers.id, id));
}

/**
 * One alias per line, trimmed, de-duplicated, and never the empty string.
 *
 * Case and punctuation are left exactly as typed: the matcher squashes both sides before it
 * compares, and the pharmacy should see on the screen the name it actually reads on the invoice.
 */
export function normaliseAliases(raw: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (raw ?? "").split(/[\n,;]/)) {
    const t = line.trim();
    if (!t) continue;
    const k = t.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.join("\n");
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
