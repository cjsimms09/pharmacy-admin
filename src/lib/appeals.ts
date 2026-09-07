import "server-only";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { newId } from "./crypto";
import { audit } from "./audit";
import { getSettings } from "./settings";
import { todayIso, addDays } from "./dates";
import { nadacInForce, type NadacRecord } from "./reimbursement-rules";
import { packQtyOf } from "./product-ledger";
import { buildQueue, emailTarget, packetLines, type Queue, type QueueClaim, type QueueRow, type RateRow } from "./appeal-queue";
import type { AppealTerms, Invoice, Packet } from "./appeal-packet";
import { textPdf } from "./pdf";
import { floorReview } from "./floor-review";

/**
 * Appeals, from the claims to the PBM and back.
 *
 * The queue is rebuilt from the claims on every open: nothing is stored until a person presses
 * Prepare, and then the packet is kept exactly as it stood, with its PDF filed as a document, so
 * what was claimed can be produced. Sending goes through the pharmacy's own mailbox where the
 * contract names an email address; a portal or a fax is prepared and handed over with the fields
 * to paste, because the site cannot drive somebody else's portal. Every send is logged, and the
 * outcome is recorded against the appeal when the reprocessed claim comes in.
 */

export type AppealRow = typeof schema.appeals.$inferSelect;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

async function pharmacyIdentity() {
  const s = await getSettings();
  return { name: s.pharmacy_name || "This pharmacy", ncpdp: s.pharmacy_ncpdp || null, npi: s.pharmacy_npi || null };
}

async function termsByPbm(): Promise<Map<string, AppealTerms>> {
  const rows = await db.query.macAppealTerms.findMany();
  const out = new Map<string, AppealTerms>();
  for (const r of rows) {
    out.set(norm(r.pbmName), {
      pbmName: r.pbmName,
      submissionChannel: r.submissionChannel,
      submissionTarget: r.submissionTarget,
      appealWindowDays: r.appealWindowDays,
      windowBasis: r.windowBasis,
      requiredFields: r.requiredFields,
      invoiceRequired: r.invoiceRequired,
      responseSlaDays: r.responseSlaDays,
    });
  }
  return out;
}

/**
 * The invoice line nearest each claim's fill, priced per unit.
 *
 * The invoice prints a price per package; the pack size comes from the catalogue. A line whose
 * pack size the site cannot say is not used, because a per-package price offered as a per-unit
 * acquisition cost is the one error an appeal cannot survive.
 */
async function invoicesFor(claims: { claimId: string; ndc11: string; dateFilled: string }[]): Promise<Map<string, Invoice>> {
  const ndcs = [...new Set(claims.map((c) => c.ndc11))];
  if (ndcs.length === 0) return new Map();
  const [lines, items, invoices] = await Promise.all([
    db.query.invoiceLines.findMany({ where: inArray(schema.invoiceLines.ndc11, ndcs), columns: { ndc11: true, invoiceId: true, invoiceDate: true, supplier: true, unitCostCents: true, quantity: true } }),
    db.query.supplierItems.findMany({ where: inArray(schema.supplierItems.ndc11, ndcs), columns: { ndc11: true, packSize: true } }),
    db.query.supplierInvoices.findMany({ columns: { id: true, invoiceNumber: true, supplier: true } }),
  ]);
  const packBy = new Map<string, number>();
  for (const it of items) {
    const q = packQtyOf(it.packSize);
    if (q && q > 0 && !packBy.has(it.ndc11)) packBy.set(it.ndc11, q);
  }
  const invBy = new Map(invoices.map((i) => [i.id, i]));
  const out = new Map<string, Invoice>();
  for (const c of claims) {
    const pack = packBy.get(c.ndc11);
    if (!pack) continue;
    const mine = lines.filter((l) => l.ndc11 === c.ndc11 && l.invoiceDate && l.invoiceDate <= c.dateFilled).sort((a, b) => (b.invoiceDate ?? "").localeCompare(a.invoiceDate ?? ""));
    const l = mine[0] ?? lines.filter((x) => x.ndc11 === c.ndc11).sort((a, b) => (a.invoiceDate ?? "").localeCompare(b.invoiceDate ?? ""))[0];
    if (!l || !l.invoiceDate) continue;
    const inv = invBy.get(l.invoiceId);
    out.set(c.claimId, {
      supplier: l.supplier ?? inv?.supplier ?? "the wholesaler",
      invoiceNumber: inv?.invoiceNumber ?? null,
      invoiceDate: l.invoiceDate,
      // cents per package → micros per unit: × 10,000 / pack units.
      unitCostMicros: Math.round((l.unitCostCents * 10_000) / pack),
      packUnits: pack,
    });
  }
  return out;
}

export async function appealQueue(today = todayIso()): Promise<Queue & { since: string }> {
  const { held } = await import("./held");
  return held(`appeal-queue:${today}`, () => loadAppealQueue(today));
}

async function loadAppealQueue(today: string): Promise<Queue & { since: string }> {
  const since = addDays(today, -120);
  const { and, gte } = await import("drizzle-orm");
  const { nadacRecordsForClaims } = await import("./nadac-in-force");
  const { nadacNow } = await import("./nadac-latest");
  /*
   * The claims of the appeal window and, for each, the NADAC in force on its fill date — asked of
   * the database rather than by loading every NADAC row ever held (a year of weekly files is a
   * million and a half rows, and this page took twenty seconds to open on them).
   */
  const [claims, rates, terms, records, latest, existing, pharmacy] = await Promise.all([
    db.query.claims.findMany({ where: and(eq(schema.claims.status, "paid"), gte(schema.claims.dateFilled, since)) }),
    db.query.networkRates.findMany(),
    termsByPbm(),
    nadacRecordsForClaims({ status: "paid", since }),
    nadacNow(),
    db.query.appeals.findMany({ columns: { claimId: true } }),
    pharmacyIdentity(),
  ]);
  const classOf = new Map<string, "B" | "G">();
  for (const n of latest) if (n.classification === "B" || n.classification === "G") classOf.set(n.ndc11, n.classification);

  const queueClaims: QueueClaim[] = claims
    .filter((c) => c.ndc11 && c.pbmName && !c.cashPlan && c.dateFilled >= since)
    .map((c) => {
      const nadac = nadacInForce(records, c.ndc11!, c.dateFilled);
      return {
        claimId: c.id,
        rxNumber: c.rxNumber,
        fillNumber: c.fillNumber,
        dateFilled: c.dateFilled,
        adjudicatedOn: c.dateFilled,
        remittedOn: null,
        ndc11: c.ndc11!,
        drugName: c.itemName,
        quantityThousandths: c.quantityThousandths,
        daysSupply: c.daysSupply,
        bin: c.bin,
        pcn: c.pcn,
        groupNumber: c.groupNumber,
        pbmName: c.pbmName!,
        claimReference: null,
        paidCents: (c.ingredientPaidCents ?? 0) + (c.dispensingFeePaidCents ?? 0) || (c.remitCents ?? 0),
        ingredientPaidCents: c.ingredientPaidCents,
        networkId: c.networkId,
        classification: classOf.get(c.ndc11!) ?? null,
        awpTotalCents: c.awpCents,
        nadacUnitMicros: nadac?.unitMicros ?? null,
      };
    });
  const invoices = await invoicesFor(queueClaims.map((c) => ({ claimId: c.claimId, ndc11: c.ndc11, dateFilled: c.dateFilled })));
  const rateRows: RateRow[] = rates.map((r) => ({ pbmName: r.pbmName, network: r.network, lineOfBusiness: r.lineOfBusiness, brandRate: r.brandRate, genericRate: r.genericRate, effectiveDate: r.effectiveDate, effectiveTo: r.effectiveTo, status: r.status }));
  const q = buildQueue({ claims: queueClaims, rates: rateRows, terms, invoices, today, pharmacy, appealed: new Set(existing.map((e) => e.claimId).filter((x): x is string => Boolean(x))) });
  return { ...q, since };
}

async function filePdf(title: string, fileName: string, pdf: Buffer, user: { name: string }, effectiveOn: string): Promise<string> {
  const { storeFile } = await import("./files");
  const stored = await storeFile(new File([new Uint8Array(pdf)], fileName, { type: "application/pdf" }), { allowReportTypes: true });
  const id = newId();
  await db.insert(schema.documents).values({
    id,
    category: "appeal",
    title,
    fileName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    effectiveOn,
    notes: null,
    uploadedBy: user.name,
  });
  return id;
}

/** Prepares one appeal from the queue: the packet kept as it stands, its PDF filed. */
export async function prepareAppeal(claimId: string, user: { id: string; name: string }): Promise<{ id: string; ok: boolean; blockers: string[] }> {
  const q = await appealQueue();
  const row = [...q.ready, ...q.held].find((r) => r.claim.claimId === claimId);
  if (!row) throw new Error("That claim is not in the queue: it is paid to rate, already appealed, or cannot be priced.");
  return prepareRow(row, user);
}

async function prepareRow(row: QueueRow, user: { id: string; name: string }): Promise<{ id: string; ok: boolean; blockers: string[] }> {
  const { claim, packet } = row;
  const title = `MAC appeal — Rx ${claim.rxNumber}${claim.fillNumber != null ? `-${claim.fillNumber}` : ""} — ${claim.pbmName}`;
  const pdf = textPdf(title, packetLines(packet, title));
  const documentId = await filePdf(title, `mac-appeal-${claim.rxNumber}-${claim.dateFilled}.pdf`, pdf, user, claim.dateFilled);
  const id = newId();
  const email = emailTarget(packet.sendVia.channel, packet.sendVia.target);
  await db.insert(schema.appeals).values({
    id,
    kind: "mac_appeal",
    claimId: claim.claimId,
    rxNumber: claim.rxNumber,
    fillNumber: claim.fillNumber,
    dateFilled: claim.dateFilled,
    ndc11: claim.ndc11,
    pbmName: claim.pbmName,
    shortfallCents: packet.shortfallCents,
    deadline: packet.deadline,
    status: "prepared",
    channel: email ? "email" : packet.sendVia.channel ? packet.sendVia.channel.toLowerCase().slice(0, 20) : null,
    target: email ?? packet.sendVia.target,
    packetJson: JSON.stringify({ packet, formulaText: row.formulaText, rateNetwork: row.rateNetwork }),
    documentId,
    createdBy: user.name,
  });
  await audit({ action: "appeals.prepared", userId: user.id, userName: user.name, entity: "appeal", entityId: id, details: `${title}: ${(packet.shortfallCents / 100).toFixed(2)} short${packet.ok ? "" : `; held: ${packet.blockers.join(" ")}`}` });
  return { id, ok: packet.ok, blockers: packet.blockers };
}

/** Prepares every packet that is ready. */
export async function prepareAllReady(user: { id: string; name: string }): Promise<{ prepared: number; cents: number }> {
  const q = await appealQueue();
  let cents = 0;
  for (const row of q.ready) {
    await prepareRow(row, user);
    cents += row.packet.shortfallCents;
  }
  return { prepared: q.ready.length, cents };
}

/**
 * Sends a prepared appeal by the PBM's channel.
 *
 * Email goes through the pharmacy's mailbox with the PDF attached and the invoice named. Anything
 * else is handed over: the status stays "prepared" and the page shows the fields and the portal or
 * fax to take them to, because pretending a portal was driven is worse than saying it was not.
 */
export async function sendAppeal(id: string, user: { id: string; name: string }): Promise<{ sent: boolean; how: string }> {
  const a = await db.query.appeals.findFirst({ where: eq(schema.appeals.id, id) });
  if (!a) throw new Error("No such appeal.");
  const parsed = JSON.parse(a.packetJson) as { packet: Packet };
  const email = emailTarget(a.channel, a.target);
  if (!email) {
    return { sent: false, how: `${a.channel ?? "The channel"} is not an email address: take the fields to ${a.target ?? "the PBM's portal or fax"} and mark it sent here.` };
  }
  const { sendMail } = await import("./send-mail");
  const doc = a.documentId ? await db.query.documents.findFirst({ where: eq(schema.documents.id, a.documentId) }) : null;
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  if (doc) {
    const { readFile } = await import("./files");
    attachments.push({ filename: doc.fileName, content: await readFile(doc.storageKey), contentType: "application/pdf" });
  }
  const subject = `MAC appeal — Rx ${a.rxNumber}${a.fillNumber != null ? `-${a.fillNumber}` : ""} — NDC ${a.ndc11} — DOS ${a.dateFilled}`;
  const r = await sendMail(email, subject, parsed.packet.narrative + "\n\n" + parsed.packet.fields.map((f) => `${f.label}: ${f.value}`).join("\n"), attachments);
  const terms = (await termsByPbm()).get(norm(a.pbmName));
  await db
    .update(schema.appeals)
    .set(
      r.ok
        ? { status: "sent", sentAt: new Date().toISOString(), sentBy: user.name, sendResult: `sent via ${r.via}${r.degraded ? ` (${r.degraded})` : ""}`, responseDueOn: terms?.responseSlaDays ? addDays(todayIso(), terms.responseSlaDays) : null, updatedAt: new Date().toISOString() }
        : { sendResult: `failed: ${r.error}`, updatedAt: new Date().toISOString() },
    )
    .where(eq(schema.appeals.id, id));
  await audit({ action: r.ok ? "appeals.sent" : "appeals.send_failed", userId: user.id, userName: user.name, entity: "appeal", entityId: id, details: `${subject} → ${email}: ${r.ok ? r.via : r.error}` });
  return r.ok ? { sent: true, how: `Sent to ${email}${r.degraded ? `, but ${r.degraded}` : " with the packet attached"}.` } : { sent: false, how: `The mailbox could not send it: ${r.error}` };
}

/** A person's word on an appeal: sent by hand, answered, won with this much back, lost, withdrawn. */
export async function recordOutcome(id: string, status: AppealRow["status"], outcomeCents: number | null, note: string | null, user: { id: string; name: string }): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(schema.appeals)
    .set({ status, outcomeCents, outcomeNote: note, updatedAt: now, ...(status === "sent" ? { sentAt: now, sentBy: user.name, sendResult: "marked sent by hand" } : {}) })
    .where(eq(schema.appeals.id, id));
  await audit({ action: "appeals.outcome", userId: user.id, userName: user.name, entity: "appeal", entityId: id, details: `${status}${outcomeCents != null ? ` ${(outcomeCents / 100).toFixed(2)}` : ""}${note ? ` — ${note}` : ""}` });
}

export async function appealsList(): Promise<AppealRow[]> {
  return db.query.appeals.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)] });
}

export type AppealsScore = { prepared: number; sent: number; won: number; lost: number; sentCents: number; wonCents: number; overdue: number };

/** What the appeals have come to, so the effort can be judged. */
export async function appealsScore(today = todayIso()): Promise<AppealsScore> {
  const rows = await appealsList();
  return {
    prepared: rows.filter((r) => r.status === "prepared").length,
    sent: rows.filter((r) => r.status === "sent" || r.status === "answered").length,
    won: rows.filter((r) => r.status === "won").length,
    lost: rows.filter((r) => r.status === "lost").length,
    sentCents: rows.filter((r) => r.status !== "prepared" && r.status !== "withdrawn").reduce((n, r) => n + r.shortfallCents, 0),
    wonCents: rows.filter((r) => r.status === "won").reduce((n, r) => n + (r.outcomeCents ?? 0), 0),
    overdue: rows.filter((r) => r.status === "sent" && r.responseDueOn && r.responseDueOn < today).length,
  };
}

// ── Kansas floor complaints ───────────────────────────────────────────────────

/**
 * A complaint packet per plan: every filable claim under the floor, listed with the shortfall.
 *
 * The Kansas Insurance Department takes complaints through its own portal, which the site cannot
 * drive; what it can do is put the whole case on one page per plan — the claims, the floor each
 * should have paid, the shortfall — so the filing is a paste and an upload rather than an evening.
 */
export async function prepareFloorComplaint(payer: string, user: { id: string; name: string }): Promise<{ id: string; claims: number; cents: number }> {
  const review = await floorReview();
  const mine = review.filable.filter((c) => (c.payer ?? "unnamed") === payer);
  if (mine.length === 0) throw new Error(`No filable claims for ${payer}.`);
  const pharmacy = await pharmacyIdentity();
  const cents = mine.reduce((n, c) => n + (c.shortfallCents ?? 0), 0);
  const title = `Kansas floor complaint — ${payer} — ${mine.length} claims`;
  const lines = [
    { text: title, bold: true, size: 14 },
    { text: `${pharmacy.name}${pharmacy.ncpdp ? ` · NCPDP ${pharmacy.ncpdp}` : ""}${pharmacy.npi ? ` · NPI ${pharmacy.npi}` : ""}` },
    { text: `Under K.S.A. 40-3830 et seq. (SB 20), the plan reimbursed the claims below under NADAC plus the dispensing fee. Total shortfall ${(cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}.`, gapBefore: 6 },
    { text: "Rx · date of service · NDC · received · floor · shortfall", bold: true, gapBefore: 8 },
    ...mine.slice(0, 400).map((c) => ({ text: `${c.rxNumber} · ${c.dateFilled} · ${c.ndc11 ?? "—"} · $${((c.receivedCents ?? 0) / 100).toFixed(2)} · $${((c.floorCents ?? 0) / 100).toFixed(2)} · $${((c.shortfallCents ?? 0) / 100).toFixed(2)}` })),
    ...(mine.length > 400 ? [{ text: `… and ${mine.length - 400} more, in the attached export.` }] : []),
    { text: "Attached: the claims export for these dates of service; NADAC files in force; the plan's classification and its basis.", gapBefore: 8 },
  ];
  const pdf = textPdf(title, lines);
  const documentId = await filePdf(title, `floor-complaint-${payer.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${todayIso()}.pdf`, pdf, user, todayIso());
  const id = newId();
  const packet: Packet = {
    ok: true,
    blockers: [],
    deadline: null,
    deadlineBasis: "A complaint to the Insurance Department has no contractual window.",
    daysLeft: null,
    shortfallCents: cents,
    againstCeiling: false,
    acquisitionUnitMicros: null,
    paidUnitMicros: null,
    fields: [
      { label: "Plan", value: payer },
      { label: "Claims", value: String(mine.length) },
      { label: "Shortfall", value: `$${(cents / 100).toFixed(2)}` },
    ],
    narrative: `${pharmacy.name} asks the Kansas Insurance Department to review ${mine.length} claims reimbursed by ${payer} below the NADAC-plus-fee floor, totalling $${(cents / 100).toFixed(2)}.`,
    attachments: ["The claims export", "NADAC files in force", "The plan's classification and its basis"],
    sendVia: { channel: "portal", target: "Kansas Insurance Department consumer complaint portal" },
  };
  await db.insert(schema.appeals).values({
    id,
    kind: "floor_complaint",
    claimId: null,
    pbmName: payer,
    claimIds: JSON.stringify(mine.map((c) => c.claimId)),
    shortfallCents: cents,
    status: "prepared",
    channel: "portal",
    target: "Kansas Insurance Department consumer complaint portal",
    packetJson: JSON.stringify({ packet }),
    documentId,
    createdBy: user.name,
  });
  await audit({ action: "appeals.prepared", userId: user.id, userName: user.name, entity: "appeal", entityId: id, details: `${title}: $${(cents / 100).toFixed(2)}` });
  return { id, claims: mine.length, cents };
}

/** The plans with filable floor claims, for the complaint section. */
export async function floorComplaintCandidates(): Promise<{ payer: string; claims: number; cents: number }[]> {
  const review = await floorReview();
  const by = new Map<string, { claims: number; cents: number }>();
  for (const c of review.filable) {
    const k = c.payer ?? "unnamed";
    const e = by.get(k) ?? { claims: 0, cents: 0 };
    e.claims++;
    e.cents += c.shortfallCents ?? 0;
    by.set(k, e);
  }
  return [...by.entries()].map(([payer, v]) => ({ payer, ...v })).sort((a, b) => b.cents - a.cents);
}
