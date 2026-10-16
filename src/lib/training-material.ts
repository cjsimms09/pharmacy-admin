import "server-only";
import { courseFor } from "./courses";
import { packetPdf, packetPdfFileName, courseVersion } from "./course-packet";
import { allSections, outline } from "./manual-store";
import { protocolFor, protocolBody, PROTOCOL_VACCINES, EMERGENCY_STEPS } from "./immunization-protocol";
import { textPdf, wrapForPdf, type PdfLine } from "./pdf";
import type { TrainingType } from "@/db/schema";

/**
 * The thing a person is actually meant to read, for every training the site can assign.
 *
 * Six of the trainings are written courses and have always travelled as a PDF. Two were not:
 * acknowledging the policy and procedure manual, and reviewing the immunization protocol. Those
 * two arrived as an email with a link to a page that said, in effect, "use the material the
 * pharmacy has given you" — no attachment, nothing to open, and an email that claimed a course
 * was attached when none was. Every employee gets the manual acknowledgement, so the training
 * most people were sent was the one with nothing in it.
 *
 * Both documents are already held here. The manual is in this database and the protocol is
 * generated from the record, so there is no reason either should arrive as an instruction to go
 * and find something.
 */

export type TrainingMaterial = {
  /** What the attachment is called in somebody's inbox. */
  filename: string;
  pdf: Buffer;
  /** Stable per content, so a certificate can name the version that was actually sent. */
  version: string;
  title: string;
  kind: "course" | "manual" | "protocol";
};

/** FNV-1a over the content, so an edited manual is a different version without a version field. */
function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "v" + h.toString(36).toUpperCase().padStart(7, "0");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** Lays out a paragraph, keeping the gap above its first line and not above the wrapped ones. */
function para(lines: PdfLine[], text: string, opts: { bold?: boolean; size?: number; gapBefore?: number } = {}) {
  wrapForPdf(text, opts.size ?? 10).forEach((w, i) => {
    lines.push({ text: w, ...opts, gapBefore: i === 0 ? opts.gapBefore : 0 });
  });
}

/**
 * The pharmacy's own manual, as the document somebody is being asked to say they have read.
 *
 * Generated from the sections in this database rather than from a file on a desktop, which is the
 * only way the copy they read and the copy the site is tracking can be the same one. Retired
 * sections are left out: acknowledging a policy that has been withdrawn is worse than useless.
 */
export async function manualMaterial(pharmacyName: string): Promise<TrainingMaterial | null> {
  const rows = await allSections();
  if (rows.filter((r) => r.body.trim() || r.managedBy).length === 0) return null;

  const nodes = outline(rows);
  const lines: PdfLine[] = [];
  para(lines, pharmacyName, { bold: true, size: 11 });
  para(lines, "Policy and Procedure Manual", { bold: true, size: 16, gapBefore: 6 });
  para(
    lines,
    "This is the manual you are being asked to confirm you have read. Keep it if you like — the pharmacy holds this " +
      "exact version, and the acknowledgement you sign names it.",
    { size: 9, gapBefore: 8 },
  );

  for (const n of nodes) {
    if (n.retiredOn) continue;
    para(lines, `${n.number}  ${n.title}`, {
      bold: true,
      size: n.depth === 0 ? 13 : 11,
      gapBefore: n.depth === 0 ? 18 : 12,
    });
    if (n.managedBy) {
      para(lines, `Held by ${n.managedBy}. This section is not the pharmacy's to maintain.`, { size: 9, gapBefore: 4 });
    }
    for (const p of n.body.split("\n").map((x) => x.trim()).filter(Boolean)) para(lines, p, { gapBefore: 6 });
  }

  const version = hashOf(nodes.map((n) => `${n.number}${n.title}${n.body}`).join(" "));
  return {
    filename: `${slug(pharmacyName)}-policy-and-procedure-manual-${version}.pdf`,
    pdf: textPdf(`Policy and Procedure Manual — ${pharmacyName}`, lines),
    version,
    title: "Policy and Procedure Manual",
    kind: "manual",
  };
}

/**
 * The immunization protocol this person works under, as they would read it.
 *
 * Per person, because the protocol names the individual it authorises. Reviewing somebody else's
 * is not reviewing yours.
 */
export async function protocolMaterial(personId: string): Promise<TrainingMaterial | null> {
  const c = await protocolFor(personId);
  if (!c) return null;

  const lines: PdfLine[] = [];
  para(lines, c.pharmacy, { bold: true, size: 11 });
  if (c.address) para(lines, c.address, { size: 9, gapBefore: 2 });
  para(lines, "Pharmacist Immunization & Emergency Anaphylaxis Treatment Protocol", {
    bold: true,
    size: 14,
    gapBefore: 8,
  });
  para(lines, `The protocol ${c.subject.name} administers under.`, { size: 9, gapBefore: 4 });

  for (const b of protocolBody(c)) {
    if (b.kind === "para") para(lines, b.text, { gapBefore: 8 });
    else if (b.kind === "heading") para(lines, b.text, { bold: true, size: 12, gapBefore: 14 });
    else if (b.kind === "statute") {
      para(lines, b.heading, { bold: true, size: 9, gapBefore: 12 });
      para(lines, b.text, { size: 9, gapBefore: 4 });
    } else if (b.kind === "vaccines") {
      for (const row of PROTOCOL_VACCINES) {
        for (const cell of row) if (cell) para(lines, `     - ${cell}`, { size: 9.5, gapBefore: 2 });
      }
    } else if (b.kind === "emergency") {
      EMERGENCY_STEPS.forEach((step, i) => para(lines, `${i + 1}. ${step}`, { gapBefore: 6 }));
    }
  }

  para(lines, "The individual this protocol authorises", { bold: true, size: 12, gapBefore: 18 });
  para(lines, `Name: ${c.subject.name} — ${c.subject.role}`, { gapBefore: 6 });
  para(lines, `Licence / registration: ${c.subject.licence ?? "not on file"}`, { gapBefore: 3 });
  para(lines, `Immunization training: ${c.subject.immunizationTraining ?? "not on file"}`, { gapBefore: 3 });
  para(
    lines,
    `CPR certification: ${c.subject.cpr?.number ?? "not on file"}` +
      (c.subject.cpr?.expiresOn ? ` — current to ${c.subject.cpr.expiresOn}` : ""),
    { gapBefore: 3 },
  );
  para(lines, `Authorizing physician: ${c.physician ?? "not recorded"}`, { gapBefore: 3 });

  const version = hashOf(protocolBody(c).map((b) => JSON.stringify(b)).join(" ") + c.subject.name);
  return {
    filename: `immunization-protocol-${slug(c.subject.name)}-${version}.pdf`,
    pdf: textPdf(`Immunization protocol — ${c.subject.name}`, lines),
    version,
    title: "Immunization protocol",
    kind: "protocol",
  };
}

/**
 * The material for one assignment, whatever kind of training it is.
 *
 * Returns null only where the pharmacy genuinely holds nothing — an empty manual, for instance —
 * and the caller must then say so rather than claim an attachment that is not there.
 */
export async function trainingMaterial(
  type: TrainingType,
  opts: { pharmacyName: string; personId: string },
): Promise<TrainingMaterial | null> {
  const course = courseFor(type);
  if (course) {
    return {
      filename: packetPdfFileName(course),
      pdf: packetPdf(course, opts.pharmacyName),
      version: courseVersion(course),
      title: course.title,
      kind: "course",
    };
  }
  if (type === "policy_manual_acknowledgement") return manualMaterial(opts.pharmacyName);
  if (type === "immunization_protocol_review") return protocolMaterial(opts.personId);
  return null;
}
