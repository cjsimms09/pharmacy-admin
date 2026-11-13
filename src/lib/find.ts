import "server-only";
import { db, schema } from "@/db";
import { NAV } from "./nav";
import { FORMS } from "./manual";
import { allSections, searchSections } from "./manual-store";
import { DOCUMENT_CATEGORY_LABEL, CREDENTIAL_LABEL } from "./labels";
import { fmt } from "./dates";

/**
 * One box that finds anything in the site.
 *
 * The pharmacist-in-charge said the thing that matters: he cannot be hunting for where something
 * lives while an inspector is standing at the counter. A menu is a map you have to have learned;
 * a search box is one you do not. Everything he might be asked for has a name — a person, a
 * form, a licence, an invoice number, a policy, a drug on an invoice — and typing that name
 * should land on it.
 *
 * Deliberately not clever. No ranking model, no fuzzy matching, no index to keep in step with the
 * data. Every word typed has to appear somewhere in the thing, the whole corpus is one small
 * pharmacy's records, and a plain substring search over it is both instant and predictable —
 * which matters more than cleverness when somebody is under pressure and needs the answer to be
 * the same one it was last time.
 */

export type FoundKind = "page" | "person" | "form" | "document" | "policy" | "invoice" | "licence";

export type Found = {
  kind: FoundKind;
  title: string;
  /** One line saying what it is, so a result can be judged without opening it. */
  detail: string;
  href: string;
  /** Where it lives, said the way the menu says it. */
  where: string;
};

const KIND_ORDER: FoundKind[] = ["page", "person", "licence", "form", "policy", "document", "invoice"];

export const KIND_LABEL: Record<FoundKind, string> = {
  page: "Screens",
  person: "People",
  licence: "Licences and credentials",
  form: "Forms",
  policy: "The policy manual",
  document: "Documents on file",
  invoice: "Invoices",
};

/** Every word has to appear. Two words narrow the answer rather than widening it. */
function matches(haystack: string, terms: string[]): boolean {
  const hay = haystack.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export async function findAnything(query: string, limitPerKind = 8): Promise<Found[]> {
  const terms = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return [];

  const out: Found[] = [];

  // ── Screens ───────────────────────────────────────────────────────
  // First, because half the time the question is "where is that page".
  for (const group of NAV) {
    if (matches(`${group.label} ${group.blurb}`, terms)) {
      out.push({ kind: "page", title: group.label, detail: group.blurb, href: group.href, where: "Menu" });
    }
    for (const item of group.items) {
      if (!matches(`${item.label} ${item.blurb ?? ""} ${group.label}`, terms)) continue;
      out.push({
        kind: "page",
        title: item.label,
        detail: item.blurb ?? "",
        href: item.href,
        where: group.label,
      });
    }
  }

  // ── Forms ─────────────────────────────────────────────────────────
  // Searched on the other names each goes by as well as its own, because the name an inspector
  // uses and the name the Board prints are rarely the same words.
  for (const f of FORMS) {
    if (!matches(`${f.name} ${f.purpose} ${(f.aliases ?? []).join(" ")} ${f.authority}`, terms)) continue;
    out.push({ kind: "form", title: f.name, detail: f.purpose, href: f.href, where: f.where });
  }

  const [people, creds, docs, invoices, driverInvoices, sections] = await Promise.all([
    db.query.people.findMany(),
    db.query.credentials.findMany(),
    db.query.documents.findMany(),
    db.query.supplierInvoices.findMany(),
    db.query.driverInvoices.findMany(),
    allSections(),
  ]);

  // ── People ────────────────────────────────────────────────────────
  for (const p of people) {
    const name = `${p.firstName} ${p.lastName}`;
    if (!matches(`${name} ${p.role} ${p.email ?? ""} ${p.isPic ? "pharmacist in charge pic" : ""}`, terms)) continue;
    out.push({
      kind: "person",
      title: name,
      detail: [p.role, p.isPic ? "pharmacist-in-charge" : "", p.endedOn ? `left ${fmt(p.endedOn)}` : ""]
        .filter(Boolean)
        .join(" · "),
      href: `/staff/${p.id}`,
      where: "People",
    });
  }

  // ── Licences and credentials ──────────────────────────────────────
  // A licence number is the thing an inspector reads out, so it is searched directly.
  for (const c of creds) {
    const who = people.find((p) => p.id === c.personId);
    const label = c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type];
    if (!matches(`${label} ${c.number ?? ""} ${c.issuer ?? ""} ${who ? `${who.firstName} ${who.lastName}` : ""}`, terms)) {
      continue;
    }
    out.push({
      kind: "licence",
      title: `${label}${who ? ` — ${who.firstName} ${who.lastName}` : ""}`,
      detail: [c.number, c.noExpiry ? "does not expire" : c.expiresOn ? `expires ${fmt(c.expiresOn)}` : "no expiry date"]
        .filter(Boolean)
        .join(" · "),
      href: who ? `/staff/${who.id}#credentials` : "/licenses",
      where: who ? "People" : "Licences",
    });
  }

  // ── The manual ────────────────────────────────────────────────────
  for (const hit of searchSections(sections, query)) {
    out.push({
      kind: "policy",
      title: `${hit.number} ${hit.title}`,
      detail: hit.snippet || hit.chapterTitle,
      href: `/manual?ch=${hit.chapterId}&q=${encodeURIComponent(query)}#${hit.id}`,
      where: hit.chapterTitle,
    });
  }

  // ── Documents ─────────────────────────────────────────────────────
  for (const d of docs) {
    if (!matches(`${d.title} ${d.fileName} ${DOCUMENT_CATEGORY_LABEL[d.category] ?? ""} ${d.notes ?? ""}`, terms)) continue;
    out.push({
      kind: "document",
      title: d.title || d.fileName,
      detail: [DOCUMENT_CATEGORY_LABEL[d.category], d.effectiveOn ? fmt(d.effectiveOn) : ""].filter(Boolean).join(" · "),
      href: `/files/${d.id}`,
      where: "Documents",
    });
  }

  // ── Invoices, both kinds ──────────────────────────────────────────
  for (const i of invoices) {
    if (!matches(`${i.supplier ?? ""} ${i.invoiceNumber ?? ""} ${i.itemsText} ${i.controlledItems}`, terms)) continue;
    out.push({
      kind: "invoice",
      title: `${i.supplier ?? "Supplier"} ${i.invoiceNumber ?? ""}`.trim(),
      detail: [i.invoiceDate ? fmt(i.invoiceDate) : "no date", i.schedule.replace(/_/g, " ")].join(" · "),
      href: `/inventory/invoices?q=${encodeURIComponent(i.invoiceNumber ?? i.supplier ?? "")}`,
      where: "Supplier invoices",
    });
  }
  for (const i of driverInvoices) {
    if (!matches(`${i.invoiceNumber} ${i.driverName} ${i.month} delivery driver invoice`, terms)) continue;
    out.push({
      kind: "invoice",
      title: `Delivery invoice ${i.invoiceNumber}`,
      detail: `${i.driverName} · ${i.month} · ${(i.totalCents / 100).toFixed(2)}`,
      href: i.documentId ? `/files/${i.documentId}` : `/deliveries?month=${i.month}`,
      where: "Driver invoices",
    });
  }

  // Capped per kind rather than overall, so one noisy category cannot bury the others — a drug
  // name that appears on forty invoices must not push the policy that governs it off the screen.
  const byKind = new Map<FoundKind, Found[]>();
  for (const f of out) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);

  return KIND_ORDER.flatMap((k) => (byKind.get(k) ?? []).slice(0, limitPerKind));
}

/** How many of each kind matched, before the cap, so the page can say what it left out. */
export async function findCounts(query: string): Promise<Record<FoundKind, number>> {
  const all = await findAnything(query, 1000);
  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<FoundKind, number>;
  for (const f of all) counts[f.kind]++;
  return counts;
}
