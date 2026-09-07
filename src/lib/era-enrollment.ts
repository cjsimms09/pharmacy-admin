import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { newId } from "./crypto";
import { audit } from "./audit";
import { getSettings, setSetting } from "./settings";
import { todayIso } from "./dates";
import { textPdf } from "./pdf";

/**
 * Getting each PBM's 835 delivered to this site.
 *
 * The contract says how a PBM pays and where its remittance lives; changing where the 835 goes is
 * an EFT/ERA enrollment on the PBM's portal or form, and the site cannot drive somebody else's
 * portal. What it can do is hold the request — the pharmacy's NCPDP, NPI and TIN, the delivery
 * point, the contact the contract names — write the request as a letter, send it where the
 * contact is an email address, and keep the checklist per payer: requested, confirmed, first 835
 * received. contract-reading.md §6.
 */

export type RoutingRow = {
  pbmName: string;
  paysVia: string | null;
  paymentMethod: string | null;
  remittanceSource: string | null;
  paymentCycle: string | null;
  sourceLabel: string | null;
  contacts: { contactType: string; email: string | null; phone: string | null; portalUrl: string | null }[];
  enrollment: typeof schema.eraEnrollments.$inferSelect | null;
  /** The email the request can go to, where one is named for payment or EFT. */
  requestEmail: string | null;
  /** What the request still lacks before it can be sent. */
  missing: string[];
};

export type Identity = { name: string; ncpdp: string | null; npi: string | null; tin: string | null; address: string | null; phone: string | null; mailbox: string | null };

export async function identity(): Promise<Identity> {
  const s = await getSettings();
  const address = [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state, s.pharmacy_zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;
  return { name: s.pharmacy_name || "This pharmacy", ncpdp: s.pharmacy_ncpdp || null, npi: s.pharmacy_npi || null, tin: s.pharmacy_tin || null, address, phone: s.pharmacy_phone || null, mailbox: s.mail_user || null };
}

export async function saveTin(tin: string): Promise<void> {
  await setSetting("pharmacy_tin", tin.trim());
}

export async function routingRows(): Promise<{ rows: RoutingRow[]; identity: Identity }> {
  const [routing, contacts, enrollments, id] = await Promise.all([db.query.paymentRouting.findMany(), db.query.pbmContacts.findMany(), db.query.eraEnrollments.findMany(), identity()]);
  const names = new Set<string>([...routing.map((r) => r.pbmName), ...enrollments.map((e) => e.pbmName)]);
  const rows: RoutingRow[] = [...names].sort().map((pbmName) => {
    const r = routing.find((x) => x.pbmName === pbmName) ?? null;
    const cs = contacts.filter((c) => c.pbmName === pbmName);
    const pay = cs.find((c) => /payment|eft|era|remit/i.test(c.contactType) && c.email) ?? cs.find((c) => /provider|relations|help/i.test(c.contactType) && c.email) ?? null;
    const missing: string[] = [];
    if (!id.ncpdp) missing.push("the pharmacy's NCPDP (Settings)");
    if (!id.npi) missing.push("the pharmacy's NPI (Settings)");
    if (!id.tin) missing.push("the pharmacy's TIN (below)");
    if (!id.mailbox) missing.push("a mailbox for the site to receive the 835 at (Settings → Email)");
    if (!pay) missing.push("an email for payment or EFT enrollment at this PBM (read its contract, or add the contact on its payer page)");
    return {
      pbmName,
      paysVia: r?.paysVia ?? null,
      paymentMethod: r?.paymentMethod ?? null,
      remittanceSource: r?.remittanceSource ?? null,
      paymentCycle: r?.paymentCycle ?? null,
      sourceLabel: r?.sourceLabel ?? null,
      contacts: cs.map((c) => ({ contactType: c.contactType, email: c.email, phone: c.phone, portalUrl: c.portalUrl })),
      enrollment: enrollments.find((e) => e.pbmName === pbmName) ?? null,
      requestEmail: pay?.email ?? null,
      missing,
    };
  });
  return { rows, identity: id };
}

/** The request as a letter, from what is on file. */
export function requestLetter(pbmName: string, id: Identity, deliveryTarget: string): { title: string; lines: { text: string; bold?: boolean; size?: number; gapBefore?: number }[]; body: string } {
  const title = `ERA (835) enrollment request — ${id.name} — ${pbmName}`;
  const paragraphs = [
    `${id.name} requests enrollment for electronic remittance advice (ASC X12 835) for all claims adjudicated by ${pbmName}, delivered to ${deliveryTarget}.`,
    `Pharmacy: ${id.name}${id.address ? `, ${id.address}` : ""}${id.phone ? `, ${id.phone}` : ""}.`,
    `NCPDP ${id.ncpdp ?? "—"} · NPI ${id.npi ?? "—"} · TIN ${id.tin ?? "—"}.`,
    "Please confirm the enrollment, the effective date, and the first remittance cycle it will apply to. If a form or portal enrollment is required instead, please reply with the form or the link and it will be completed the same day.",
    "Thank you.",
  ];
  const lines = [{ text: title, bold: true, size: 14 }, ...paragraphs.flatMap((p) => (p.match(/.{1,110}(\s|$)/g) ?? [p]).map((t) => ({ text: t.trim() }))).map((l, i) => (i === 0 ? { ...l, gapBefore: 6 } : l))];
  return { title, lines, body: paragraphs.join("\n\n") };
}

/** Writes the request as a document and, where the PBM names an email, sends it. */
export async function requestEnrollment(pbmName: string, user: { id: string; name: string }): Promise<{ sent: boolean; how: string }> {
  const { rows, identity: id } = await routingRows();
  const row = rows.find((r) => r.pbmName === pbmName);
  if (!row) throw new Error("No such PBM on the routing list.");
  if (row.missing.length > 0) throw new Error(`Not ready: needs ${row.missing.join("; ")}.`);
  const deliveryTarget = id.mailbox!;
  const letter = requestLetter(pbmName, id, deliveryTarget);
  const pdf = textPdf(letter.title, letter.lines);
  const { storeFile } = await import("./files");
  const fileName = `era-request-${pbmName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${todayIso()}.pdf`;
  const stored = await storeFile(new File([new Uint8Array(pdf)], fileName, { type: "application/pdf" }), { allowReportTypes: true });
  const documentId = newId();
  await db.insert(schema.documents).values({ id: documentId, category: "era_enrollment", title: letter.title, fileName, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.storageKey, effectiveOn: todayIso(), notes: null, uploadedBy: user.name });

  const { sendMail } = await import("./send-mail");
  const r = await sendMail(row.requestEmail!, letter.title, letter.body, [{ filename: fileName, content: pdf, contentType: "application/pdf" }]);
  const now = new Date().toISOString();
  const values = { pbmName, status: "requested" as const, deliveryTarget, requestedOn: todayIso(), requestedTo: row.requestEmail, documentId, notes: r.ok ? `Sent via ${r.via}.` : `Send failed: ${r.error}. The letter is filed; send it by hand.`, updatedBy: user.name, updatedAt: now };
  if (row.enrollment) await db.update(schema.eraEnrollments).set(values).where(eq(schema.eraEnrollments.id, row.enrollment.id));
  else await db.insert(schema.eraEnrollments).values({ id: newId(), ...values });
  await audit({ action: r.ok ? "era.requested" : "era.request_failed", userId: user.id, userName: user.name, entity: "pbm", entityId: pbmName, details: `${letter.title} → ${row.requestEmail}: ${r.ok ? r.via : r.error}` });
  return r.ok ? { sent: true, how: `Sent to ${row.requestEmail} with the letter attached, asking for the 835 at ${deliveryTarget}.` } : { sent: false, how: `The letter is filed but the mailbox could not send it: ${r.error}` };
}

/** A person's word on where an enrollment stands. */
export async function setEnrollment(pbmName: string, status: typeof schema.eraEnrollments.$inferSelect.status, note: string | null, user: { id: string; name: string }): Promise<void> {
  const now = new Date().toISOString();
  const today = todayIso();
  const existing = await db.query.eraEnrollments.findFirst({ where: eq(schema.eraEnrollments.pbmName, pbmName) });
  const patch = { status, notes: note, updatedBy: user.name, updatedAt: now, ...(status === "confirmed" ? { confirmedOn: today } : {}), ...(status === "receiving" ? { firstRemitOn: today } : {}), ...(status === "requested" && !existing?.requestedOn ? { requestedOn: today } : {}) };
  if (existing) await db.update(schema.eraEnrollments).set(patch).where(eq(schema.eraEnrollments.id, existing.id));
  else await db.insert(schema.eraEnrollments).values({ id: newId(), pbmName, ...patch });
  await audit({ action: "era.status", userId: user.id, userName: user.name, entity: "pbm", entityId: pbmName, details: `${status}${note ? ` — ${note}` : ""}` });
}
