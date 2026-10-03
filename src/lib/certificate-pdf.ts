import type { CertificateData } from "./certificate";
import { drawnPdf, wrapForPdf, textWidth, PAGE, type Draw } from "./pdf";

/**
 * The certificate as a file that can be put somewhere.
 *
 * The live certificate is deliberately generated from the record every time it is asked for, so
 * it can never quietly disagree with the register. That remains the authority. But a record that
 * exists only inside one piece of software is a record with a single point of failure, and the
 * ask was plain: file a copy.
 *
 * The safety in doing so is the verification code, which is computed from the fields on the face
 * and printed on it. A filed copy whose code no longer matches the live certificate is a copy of
 * something that has since changed — so the copy cannot silently become the wrong version of the
 * truth. It can only become a visibly older one.
 *
 * Both signatures print in full: the employee's, made by replying from their own address with the
 * code issued to them, and the trainer's, made by ticking to sign and typing a name. Each carries
 * the wording adopted, the method, the time and what attributes it to that person, and the page
 * ends with the statutory basis rather than assuming the reader knows it.
 */

const RIGHT = PAGE.width - PAGE.margin;
const WIDTH = RIGHT - PAGE.margin;
const GREEN = 0.35;

export function certificatePdf(c: CertificateData): Buffer {
  const pages: Draw[][] = [];
  let page: Draw[] = [];
  let y = PAGE.height - 72;

  const brk = () => {
    pages.push(page);
    page = [];
    y = PAGE.height - 72;
  };
  const need = (h: number) => {
    if (y - h < 78) brk();
  };
  const text = (
    s: string,
    o: { size?: number; bold?: boolean; grey?: number; align?: "left" | "center"; indent?: number; width?: number } = {},
  ) => {
    const size = o.size ?? 10;
    const width = o.width ?? WIDTH - (o.indent ?? 0);
    for (const l of wrapForPdf(s, size, width)) {
      need(size * 1.4);
      y -= size * 1.4;
      page.push(
        o.align === "center"
          ? { kind: "text", x: PAGE.width / 2, y, text: l, size, bold: o.bold, grey: o.grey, align: "center" }
          : { kind: "text", x: PAGE.margin + (o.indent ?? 0), y, text: l, size, bold: o.bold, grey: o.grey },
      );
    }
  };
  const rule = (weight = 0.6, grey = 0.7, inset = 0) => {
    need(6);
    y -= 6;
    page.push({ kind: "rule", x1: PAGE.margin + inset, x2: RIGHT - inset, y, weight, grey });
  };
  const gap = (h: number) => {
    y -= h;
  };

  // ── The face ───────────────────────────────────────────────────
  text(c.pharmacy.name.toUpperCase(), { size: 11, bold: true, align: "center", grey: 0.2 });
  if (c.pharmacy.address) text(c.pharmacy.address, { size: 8.5, align: "center", grey: 0.45 });
  const line3 = [c.pharmacy.registration && `Kansas pharmacy registration ${c.pharmacy.registration}`, c.pharmacy.phone]
    .filter(Boolean)
    .join(" · ");
  if (line3) text(line3, { size: 8.5, align: "center", grey: 0.45 });

  gap(26);
  rule(1.2, GREEN);
  gap(16);
  text("CERTIFICATE OF COMPLETION", { size: 11, bold: true, align: "center", grey: GREEN });
  gap(24);

  text("This is to certify that", { size: 10, align: "center", grey: 0.35 });
  gap(6);
  text(c.personName, { size: 24, bold: true, align: "center" });
  text(c.personRole, { size: 8.5, align: "center", grey: 0.45 });
  gap(16);
  text("has completed", { size: 10, align: "center", grey: 0.35 });
  gap(4);
  text(c.courseTitle, { size: 16, bold: true, align: "center" });
  gap(12);
  text(
    `on ${c.completedOn}` + (c.minutes ? ` · approximately ${c.minutes} minutes of instruction` : ""),
    { size: 10, align: "center" },
  );
  if (c.quiz) text(c.quiz, { size: 9.5, align: "center", grey: 0.3 });
  if (c.expiresOn) text(`Valid until ${c.expiresOn}, when it falls due again.`, { size: 9.5, align: "center", grey: 0.3 });

  gap(30);
  // Whose names go on the face: the signatures actually held, or the PIC issuing it.
  const named = c.signatures.length
    ? c.signatures.map((s) => ({ who: s.who, role: s.role.startsWith("The employee") ? "The employee" : "Pharmacist-in-Charge" }))
    : [{ who: c.issuedBy.split(",")[0], role: "Pharmacist-in-Charge" }];
  const w = (WIDTH - 24 * (named.length - 1)) / named.length;
  need(46);
  named.forEach((n, i) => {
    const x = PAGE.margin + i * (w + 24);
    page.push({ kind: "rule", x1: x, x2: x + w, y: y - 18, weight: 0.6, grey: 0.4 });
    page.push({ kind: "text", x, y: y - 32, text: n.who, size: 11, bold: true });
    page.push({ kind: "text", x, y: y - 43, text: n.role, size: 7.5, grey: 0.45 });
  });
  y -= 54;

  gap(14);
  const numW = textWidth(c.number, 8) + 16;
  page.push({ kind: "rect", x: RIGHT - numW, y: y - 14, w: numW, h: 16, grey: 0.94 });
  page.push({ kind: "text", x: RIGHT - 8, y: y - 10, text: c.number, size: 8, align: "right", grey: 0.25 });
  y -= 20;

  // ── The record behind it ───────────────────────────────────────
  gap(18);
  rule(1, 0.4);
  gap(14);
  text("RECORD OF TRAINING", { size: 9, bold: true, grey: 0.35 });
  gap(8);
  const row = (term: string, desc: string) => {
    need(30);
    text(term, { size: 8.5, bold: true, grey: 0.3 });
    text(desc, { size: 9, indent: 10, grey: 0.1 });
    gap(5);
  };
  if (c.authority) row("Requirement addressed", c.authority);
  if (c.material) row("Material delivered", c.material);
  row("How it was delivered", c.how);
  if (c.trainerQualifications) row("Delivered by", `${c.issuedBy.split(",")[0]} — ${c.trainerQualifications}`);
  if (c.liveQuestions) row("Interactive questions and answers", c.liveQuestions);
  if (c.provider) row("Provider", c.provider);
  row(
    "Verification",
    `${c.verification} — recomputed from the record every time this is produced. A filed copy whose code no longer ` +
      `matches the live record is a copy of something that has since changed.`,
  );

  // ── The signatures ─────────────────────────────────────────────
  if (c.signatures.length) {
    gap(16);
    rule(1, 0.4);
    gap(14);
    text("ELECTRONIC SIGNATURES", { size: 9, bold: true, grey: 0.35 });
    gap(8);
    for (const sig of c.signatures) {
      need(90);
      gap(6);
      text(sig.role.toUpperCase(), { size: 7.5, bold: true, grey: 0.4 });
      gap(2);
      text(`"${sig.statement}"`, { size: 9, indent: 10, grey: 0.1 });
      gap(3);
      text(`${sig.who}${sig.at ? ` — ${sig.at.replace("T", " ").slice(0, 19)}` : ""}`, {
        size: 9.5,
        bold: true,
        indent: 10,
      });
      text(sig.method, { size: 8.5, indent: 10, grey: 0.3 });
      for (const a of sig.attribution) text(`–  ${a}`, { size: 8.5, indent: 20, grey: 0.3 });
      gap(8);
    }
    need(70);
    gap(4);
    text(
      "Signed electronically under the Electronic Signatures in Global and National Commerce Act (15 U.S.C. 7001 " +
        "et seq.) and the Kansas Uniform Electronic Transactions Act (K.S.A. 16-1601 et seq.). An electronic " +
        "signature is a symbol or process attached to or logically associated with a record and adopted with the " +
        "intent to sign it (15 U.S.C. 7006(5)); it is attributable to a person where that is shown in any manner, " +
        "including by the efficacy of the security procedure used (K.S.A. 16-1609). The wording adopted, the time, " +
        "the method and the attributing details above are retained in this pharmacy's compliance system and are " +
        "reproducible on request.",
      { size: 8, grey: 0.4 },
    );
  }

  pages.push(page);

  return drawnPdf(`Certificate ${c.number} — ${c.personName}`, pages.map((p, i) => [
    { kind: "rule", x1: PAGE.margin, x2: RIGHT, y: 58, weight: 0.5, grey: 0.75 },
    { kind: "text", x: PAGE.margin, y: 46, text: `${c.pharmacy.name} — training record`, size: 7.5, grey: 0.45 },
    {
      kind: "text",
      x: PAGE.width / 2,
      y: 46,
      text: `Page ${i + 1} of ${pages.length}`,
      size: 7.5,
      align: "center",
      grey: 0.45,
    },
    { kind: "text", x: RIGHT, y: 46, text: c.number, size: 7.5, align: "right", grey: 0.45 },
    ...p,
  ] as Draw[]));
}

export function certificateFileName(c: CertificateData): string {
  const who = c.personName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `training-certificate-${who}-${c.completedOn}-${c.number.slice(-8)}.pdf`;
}
