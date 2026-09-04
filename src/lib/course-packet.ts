import { type Course } from "./courses";
import { textPdf, wrapForPdf, type PdfLine } from "./pdf";

/**
 * The course as a document that can be sent, printed and kept.
 *
 * This exists because of a distinction that decides whether a training file survives being looked
 * at: an email saying "do your HIPAA training" and linking to a page proves the pharmacy asked.
 * An email carrying the material proves the pharmacy provided it. Only the second is training,
 * and only the second can be produced three years later, when the page has changed and nobody
 * remembers what it said.
 *
 * So the packet goes out attached to the email, and its version is stamped on the certificate. If
 * the course text is ever edited the version changes, and a certificate issued last year keeps
 * naming the version that was actually delivered rather than silently claiming the new one.
 */

const RULE = "=".repeat(74);
const THIN = "-".repeat(74);

export function packetText(course: Course, pharmacyName: string): string {
  const out: string[] = [
    pharmacyName.toUpperCase(),
    RULE,
    course.title.toUpperCase(),
    "",
    "Approximately " + course.minutes + " minutes.",
    wrap("Requirement addressed: " + course.authority),
    "Material version: " + courseVersion(course),
    RULE,
    "",
    wrap(course.intro),
    "",
  ];

  course.sections.forEach((s, i) => {
    out.push(i + 1 + ". " + s.heading.toUpperCase(), THIN, "");
    for (const para of s.body) out.push(wrap(para), "");
  });

  out.push(RULE, "CHECK YOUR UNDERSTANDING", RULE, "");
  course.questions.forEach((q, i) => {
    out.push(wrap(i + 1 + ". " + q.q));
    q.options.forEach((o, oi) =>
      out.push(indent(wrap("abcd"[oi] + ") " + o, 68), "     ")),
    );
    out.push("");
  });

  out.push(
    RULE,
    "ANSWERS",
    "",
    ...course.questions.map((q, i) => wrap(i + 1 + ". (" + "abcd"[q.answer] + ") " + q.why)),
    "",
    RULE,
    wrap("This is the material used for this training at " + pharmacyName + "."),
    wrap("Keep it with your records. The pharmacy holds a copy of this exact version."),
  );

  return out.join("\n");
}

/** Indents every line of an already-wrapped block. */
function indent(block: string, pad: string): string {
  return block
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** Wraps to a width that reads on a phone and prints on letter paper without reflowing. */
function wrap(text: string, width = 74): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/**
 * A short, stable fingerprint of the course content.
 *
 * Computed from the text rather than stored, so it cannot fall out of step with what the course
 * actually says. Edit one sentence and every certificate issued afterwards names a different
 * version, which is exactly what a version is for.
 *
 * FNV-1a rather than a cryptographic hash, deliberately: this is a change detector printed on a
 * certificate and it has to be short enough for a person to compare two of them by eye.
 */
export function courseVersion(course: Course): string {
  const body = [
    course.title,
    course.authority,
    course.intro,
    ...course.sections.flatMap((s) => [s.heading, ...s.body]),
    ...course.questions.flatMap((q) => [q.q, ...q.options, String(q.answer)]),
  ].join(" ");

  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "v" + h.toString(36).toUpperCase().padStart(7, "0");
}

/** File name for the attachment, stable per course and version. */
export function packetFileName(course: Course): string {
  const slug = course.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug + "-" + courseVersion(course) + ".txt";
}

/**
 * The course as a PDF.
 *
 * A .txt attachment opens on a phone as a wall of monospace, or does not open at all, so the
 * material that was supposed to be read was not being read. This is the same content laid out as
 * a document people recognise — headings, wrapped paragraphs, page breaks — that opens anywhere
 * and prints straight.
 */
export function packetPdf(course: Course, pharmacyName: string): Buffer {
  const lines: PdfLine[] = [];
  const para = (text: string, opts: { bold?: boolean; size?: number; gapBefore?: number } = {}) => {
    const wrapped = wrapForPdf(text, opts.size ?? 10);
    wrapped.forEach((w, i) => lines.push({ text: w, ...opts, gapBefore: i === 0 ? opts.gapBefore : 0 }));
  };

  para(pharmacyName, { bold: true, size: 11 });
  para(course.title, { bold: true, size: 15, gapBefore: 6 });
  para(`Approximately ${course.minutes} minutes · material version ${courseVersion(course)}`, { size: 9, gapBefore: 4 });
  para(`Requirement addressed: ${course.authority}`, { size: 9 });
  para(course.intro, { gapBefore: 10 });

  course.sections.forEach((s, i) => {
    para(`${i + 1}. ${s.heading}`, { bold: true, size: 12, gapBefore: 14 });
    for (const b of s.body) para(b, { gapBefore: 6 });
  });

  para("Check your understanding", { bold: true, size: 13, gapBefore: 18 });
  course.questions.forEach((q, i) => {
    para(`${i + 1}. ${q.q}`, { gapBefore: 10 });
    q.options.forEach((o, oi) => para(`     ${"abcd"[oi]}) ${o}`, { size: 9.5 }));
  });

  para("Answers", { bold: true, size: 13, gapBefore: 18 });
  course.questions.forEach((q, i) => {
    para(`${i + 1}. (${"abcd"[q.answer]}) ${q.why}`, { gapBefore: 6, size: 9.5 });
  });

  para(
    `This is the material used for this training at ${pharmacyName}. Keep it with your records; the pharmacy holds a copy of this exact version.`,
    { size: 9, gapBefore: 18 },
  );

  return textPdf(`${course.title} — ${pharmacyName}`, lines);
}

/** What the PDF is called when it lands in somebody's inbox. */
export function packetPdfFileName(course: Course): string {
  return packetFileName(course).replace(/\.txt$/i, "") + ".pdf";
}
