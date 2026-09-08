import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { newId } from "./crypto";
import { audit } from "./audit";
import { getSettings, setSetting } from "./settings";
import { todayIso } from "./dates";
import { textPdf } from "./pdf";
import { buildEraRequest, type EnrolmentFacts, type EraRequest, type Identity as RequestIdentity } from "./era-request";

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
  /**
   * The request itself, built from what this payer's contract actually said.
   *
   * Everything above comes from the routing and contacts tables, which hold a projection of the
   * extraction: `payment_routing` has no column for an enrolment form, a clearinghouse or a
   * trading partner, so those three — the ones a request is actually addressed with — never
   * reached this page. This reads them from the extraction itself.
   */
  request: EraRequest;
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

/**
 * What each payer's contract said about remittance enrolment, by payer.
 *
 * Read from the extraction rather than from `payment_routing`, because that table is a projection
 * that drops exactly the three fields a request needs: the enrolment form's address, the
 * clearinghouse and the trading-partner id.
 *
 * One answer per payer, from one document: the newest that actually says something about
 * remittance. Not the newest full stop — an amendment about rates is silent on remittance and does
 * not supersede terms it never mentions — and never two documents merged, because a merged answer
 * is a third answer no document gave.
 */
async function enrolmentFactsByPbm(): Promise<Map<string, EnrolmentFacts>> {
  const { parseTerms } = await import("./contract-extract");
  const { inArray } = await import("drizzle-orm");
  /*
   * Two things to get right at once, and they pull against each other.
   *
   * The cheap way is to select every completed extraction and pick over them in memory. The library
   * is several hundred documents and an extraction is a whole contract read into JSON, so that
   * moves tens of megabytes to answer a question about a few dozen rows — on one SQLite file, on
   * the pharmacy's own computer, where every call blocks the event loop for as long as it runs.
   * `docs/reference/engine.md` rule 2: ask SQL for the row you need.
   *
   * The correct way is not simply "the newest document per payer", either. A payer's library is a
   * base agreement plus amendments and rate sheets, and an amendment about rates says nothing about
   * remittance — it does not supersede terms it is silent on. Taking the newest document and
   * stopping would lose the base agreement's remittance terms the moment any later document was
   * read, and the payer would show as never read.
   *
   * So: the index first, which is four small columns and no JSON; then fetch extractions in rounds,
   * newest first, one candidate per unresolved payer per round, stopping as soon as every payer has
   * an answer or has run out of documents. In practice that is one round, because the newest
   * contract usually is the one carrying the terms. A payer with eleven documents costs one
   * extraction, not eleven, and never loses an answer an older one holds.
   */
  const index = await db.query.contractDocs.findMany({
    where: eq(schema.contractDocs.extractionState, "done"),
    columns: { id: true, pbmName: true, documentName: true, effectiveYear: true },
  });
  if (index.length === 0) return new Map();

  const newestFirst = [...index].sort((a, b) => (b.effectiveYear ?? 0) - (a.effectiveYear ?? 0) || a.documentName.localeCompare(b.documentName));
  const queue = new Map<string, typeof newestFirst>();
  for (const d of newestFirst) {
    const held = queue.get(d.pbmName);
    if (held) held.push(d);
    else queue.set(d.pbmName, [d]);
  }

  const out = new Map<string, EnrolmentFacts>();
  while (queue.size > 0) {
    const round = [...queue.entries()].map(([pbm, docs]) => ({ pbm, doc: docs[0]! }));
    const read = await db.query.contractDocs.findMany({
      where: inArray(schema.contractDocs.id, round.map((x) => x.doc.id)),
      columns: { id: true, extractionJson: true },
    });
    const jsonById = new Map(read.map((r) => [r.id, r.extractionJson]));

    for (const { pbm, doc } of round) {
      const t = parseTerms(jsonById.get(doc.id) ?? null);
      const r = t?.remittance;
      if (!r) {
        // Silent on remittance. Try this payer's next document rather than calling it unread.
        const rest = queue.get(pbm)!.slice(1);
        if (rest.length > 0) queue.set(pbm, rest);
        else queue.delete(pbm);
        continue;
      }
      queue.delete(pbm);
      out.set(pbm, {
        pbmName: pbm,
        paidBy: r.paidBy,
        paymentMethod: r.paymentMethod,
        paymentCycle: r.paymentCycle,
        eraOffered: r.eraOffered,
        enrollmentMethod: r.enrollmentMethod,
        enrollmentFormUrl: r.enrollmentFormUrl,
        clearinghouse: r.clearinghouse,
        tradingPartnerId: r.tradingPartnerId,
        remittanceContact: r.remittanceContact,
        payerIdentifiers: r.payerIdentifiers ?? [],
        contacts: (t?.contacts ?? []).filter((c) => c.purpose === "payment_or_eft"),
        readFrom: doc.documentName,
      });
    }
  }
  return out;
}

export async function routingRows(): Promise<{ rows: RoutingRow[]; identity: Identity }> {
  const [routing, contacts, enrollments, id, facts] = await Promise.all([db.query.paymentRouting.findMany(), db.query.pbmContacts.findMany(), db.query.eraEnrollments.findMany(), identity(), enrolmentFactsByPbm()]);
  const names = new Set<string>([...routing.map((r) => r.pbmName), ...enrollments.map((e) => e.pbmName), ...facts.keys()]);
  const rows: RoutingRow[] = [...names].sort().map((pbmName) => {
    const r = routing.find((x) => x.pbmName === pbmName) ?? null;
    const cs = contacts.filter((c) => c.pbmName === pbmName);
    const pay = cs.find((c) => /payment|eft|era|remit/i.test(c.contactType) && c.email) ?? cs.find((c) => /provider|relations|help/i.test(c.contactType) && c.email) ?? null;
    /*
     * The contract's own answer, falling back to the contacts register where nothing was read.
     *
     * A payer whose contract has not been read yet is not a payer with no contacts: somebody may
     * have typed a payment address onto its payer page, and that is a real route. So the register's
     * contacts are offered to the builder when the extraction gave none, and `readFrom` stays null
     * so the page can still say the contract has not been read.
     */
    const fromContract = facts.get(pbmName) ?? null;
    const built = buildEraRequest(
      fromContract ?? {
        pbmName,
        contacts: cs.filter((c) => /payment|eft|era|remit/i.test(c.contactType)).map((c) => ({ email: c.email, phone: c.phone, portalUrl: c.portalUrl })),
        readFrom: null,
      },
      id as RequestIdentity,
      enrollments.find((e) => e.pbmName === pbmName)?.status ?? "not_started",
    );
    return {
      pbmName,
      request: built,
      paysVia: r?.paysVia ?? null,
      paymentMethod: r?.paymentMethod ?? null,
      remittanceSource: r?.remittanceSource ?? null,
      paymentCycle: r?.paymentCycle ?? null,
      sourceLabel: r?.sourceLabel ?? null,
      contacts: cs.map((c) => ({ contactType: c.contactType, email: c.email, phone: c.phone, portalUrl: c.portalUrl })),
      enrollment: enrollments.find((e) => e.pbmName === pbmName) ?? null,
      requestEmail: pay?.email ?? null,
      /*
       * One source of truth. This used to be computed here and counted "an email for payment or
       * EFT enrollment at this PBM" as the only route that existed — which is why a payer whose
       * enrolment is a form or a portal read as unready forever, however completely its contract
       * had been read. The builder decides it now, from the route it actually found.
       */
      missing: built.missing,
    };
  });
  return { rows, identity: id };
}

/** Writes the request as a document and, where the PBM names an email, sends it. */
export async function requestEnrollment(pbmName: string, user: { id: string; name: string }): Promise<{ sent: boolean; how: string }> {
  const { rows, identity: id } = await routingRows();
  const row = rows.find((r) => r.pbmName === pbmName);
  if (!row) throw new Error("No such PBM on the routing list.");
  if (row.missing.length > 0) throw new Error(`Not ready: needs ${row.missing.join("; ")}.`);
  /*
   * A letter is not what every payer takes.
   *
   * Where the contract prints an enrolment form or names a portal, emailing a letter to whatever
   * address is lying around is how a request comes back three weeks later saying "please use the
   * form" — or is never answered at all, which is worse, because nothing on the page would say so.
   * The page shows the fields to type for those routes. This refuses and says which.
   */
  const built = row.request;
  if (!built.letter) throw new Error(`${built.nextAction} The site cannot do that part for you — mark it as asked once it is done.`);
  const deliveryTarget = id.mailbox!;
  const letter = built.letter;
  const pdf = textPdf(letter.title, letter.lines);
  const { storeFile } = await import("./files");
  const fileName = `era-request-${pbmName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${todayIso()}.pdf`;
  const stored = await storeFile(new File([new Uint8Array(pdf)], fileName, { type: "application/pdf" }), { allowReportTypes: true });
  const documentId = newId();
  await db.insert(schema.documents).values({ id: documentId, category: "era_enrollment", title: letter.title, fileName, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.storageKey, effectiveOn: todayIso(), notes: null, uploadedBy: user.name });

  const { sendMail } = await import("./send-mail");
  const to = built.route.how === "email" ? built.route.target : row.requestEmail!;
  const r = await sendMail(to, letter.title, letter.body, [{ filename: fileName, content: pdf, contentType: "application/pdf" }]);
  const now = new Date().toISOString();
  const values = { pbmName, status: "requested" as const, deliveryTarget, requestedOn: todayIso(), requestedTo: to, documentId, notes: r.ok ? `Sent via ${r.via}.` : `Send failed: ${r.error}. The letter is filed; send it by hand.`, updatedBy: user.name, updatedAt: now };
  if (row.enrollment) await db.update(schema.eraEnrollments).set(values).where(eq(schema.eraEnrollments.id, row.enrollment.id));
  else await db.insert(schema.eraEnrollments).values({ id: newId(), ...values });
  await audit({ action: r.ok ? "era.requested" : "era.request_failed", userId: user.id, userName: user.name, entity: "pbm", entityId: pbmName, details: `${letter.title} → ${to}: ${r.ok ? r.via : r.error}` });
  return r.ok ? { sent: true, how: `Sent to ${to} with the letter attached, asking for the 835 at ${deliveryTarget}.` } : { sent: false, how: `The letter is filed but the mailbox could not send it: ${r.error}` };
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
