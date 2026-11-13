import { COURSES } from "./courses";
import { packetPages, courseVersion } from "./course-packet";
import { drawnPdf, wrapForPdf, textWidth, PAGE, type Draw } from "./pdf";

/**
 * Every course, in one document, for the binder in the pharmacy.
 *
 * The site is the record and the site is not always the thing somebody reaches for. A binder on
 * the shelf is what gets handed to a new technician on their first morning, what an inspector is
 * given when they ask to see the training material, and what still works when the computer is off.
 * Printing six courses one at a time, from six pages, is the kind of small friction that means the
 * binder is a year out of date.
 *
 * So: one button, one file. A cover, a contents page listing every course with the version code
 * that is in force, and then the courses themselves, numbered continuously so a page that falls
 * out can be put back. Nothing here is a second copy of the material — the pages come from the
 * same builder as the individual handouts, so the binder cannot drift from what was emailed.
 */

const RIGHT = PAGE.width - PAGE.margin;

/** Trims a title to the width of its column, because a long one ran into the version code. */
function fit(text: string, size: number, width: number): string {
  if (textWidth(text, size) <= width) return text;
  let out = text;
  while (out.length > 4 && textWidth(out + "...", size) > width) out = out.slice(0, -1);
  return out.trimEnd() + "...";
}

function line(page: Draw[], text: string, y: number, o: { size?: number; bold?: boolean; grey?: number } = {}): number {
  const size = o.size ?? 10;
  for (const w of wrapForPdf(text, size, RIGHT - PAGE.margin)) {
    page.push({ kind: "text", x: PAGE.margin, y, text: w, size, bold: o.bold, grey: o.grey });
    y -= size * 1.36;
  }
  return y;
}

export type BinderCourse = { title: string; version: string; minutes: number; pages: number; startsAt: number };

/**
 * The contents of the binder, without building it.
 *
 * The screen wants to say what is in the file before somebody spends a minute printing it, and
 * computing that from the same source as the file itself is what stops the two disagreeing.
 */
export function binderContents(): BinderCourse[] {
  const courses = Object.values(COURSES).filter(Boolean);
  let at = 3; // cover, contents, then the material
  return courses.map((c) => {
    const pages = packetPages(c!, "x").length;
    const row = {
      title: c!.title,
      version: courseVersion(c!),
      minutes: c!.minutes ?? 0,
      pages,
      startsAt: at,
    };
    at += pages;
    return row;
  });
}

export function trainingBinderPdf(pharmacyName: string, preparedOn: string, preparedBy: string): Buffer {
  const courses = Object.values(COURSES).filter(Boolean);

  // Built twice on purpose: once to learn how long each course runs, then again with the real
  // numbering. Cheaper than threading a two-pass layout through the page builder, and it cannot
  // produce a contents page that disagrees with the document.
  const lengths = courses.map((c) => packetPages(c!, pharmacyName).length);
  const front = 2;
  const total = front + lengths.reduce((a, b) => a + b, 0);

  // ── Cover ──────────────────────────────────────────────────────
  const cover: Draw[] = [];
  let y = PAGE.height - 200;
  y = line(cover, pharmacyName.toUpperCase(), y, { size: 11, bold: true, grey: 0.35 });
  y -= 18;
  y = line(cover, "Workforce training", y, { size: 30, bold: true });
  y -= 6;
  cover.push({ kind: "rule", x1: PAGE.margin, x2: RIGHT, y, weight: 1.6 });
  y -= 22;
  y = line(cover, "The complete material, as delivered", y, { size: 13, grey: 0.25 });
  y -= 28;
  y = line(
    cover,
    "This binder holds every course this pharmacy delivers to its own workforce, in full, including the " +
      "comprehension questions and their answers. It is the material itself — not a summary of it and not a list of " +
      "what was covered.",
    y,
    { size: 10, grey: 0.15 },
  );
  y -= 10;
  y = line(
    cover,
    "Each course carries a version code. A certificate names the version the person actually sat, so a course " +
      "revised after somebody was trained can never be mistaken for the one they were given. Reprint this binder " +
      "when a version code here stops matching the one on the site.",
    y,
    { size: 10, grey: 0.15 },
  );
  y -= 26;
  y = line(cover, `Prepared ${preparedOn} by ${preparedBy}.`, y, { size: 9.5, grey: 0.35 });
  cover.push({ kind: "rule", x1: PAGE.margin, x2: RIGHT, y: 110, weight: 0.5, grey: 0.7 });
  cover.push({
    kind: "text",
    x: PAGE.margin,
    y: 96,
    text: "Keep with the policy and procedure manual.",
    size: 9,
    grey: 0.4,
  });

  // ── Contents ───────────────────────────────────────────────────
  const contents: Draw[] = [];
  y = PAGE.height - 90;
  y = line(contents, "What is in this binder", y, { size: 18, bold: true });
  y -= 8;
  contents.push({ kind: "rule", x1: PAGE.margin, x2: RIGHT, y, weight: 1 });
  y -= 24;

  const cols = { title: PAGE.margin, version: 320, mins: 410, page: RIGHT };
  contents.push(
    { kind: "text", x: cols.title, y, text: "COURSE", size: 8, bold: true, grey: 0.4 },
    { kind: "text", x: cols.version, y, text: "VERSION", size: 8, bold: true, grey: 0.4 },
    { kind: "text", x: cols.mins, y, text: "MINUTES", size: 8, bold: true, grey: 0.4 },
    { kind: "text", x: cols.page, y, text: "PAGE", size: 8, bold: true, grey: 0.4, align: "right" },
  );
  y -= 6;
  contents.push({ kind: "rule", x1: PAGE.margin, x2: RIGHT, y, weight: 0.5, grey: 0.6 });
  y -= 18;

  let at = front + 1;
  courses.forEach((c, i) => {
    contents.push(
      { kind: "text", x: cols.title, y, text: fit(c!.title, 10.5, cols.version - cols.title - 12), size: 10.5 },
      { kind: "text", x: cols.version, y, text: courseVersion(c!), size: 9.5, grey: 0.3 },
      { kind: "text", x: cols.mins, y, text: String(c!.minutes ?? 0), size: 9.5, grey: 0.3 },
      { kind: "text", x: cols.page, y, text: String(at), size: 9.5, align: "right", grey: 0.3 },
    );
    y -= 13;
    y = line(contents, c!.authority, y, { size: 8.5, grey: 0.45 });
    y -= 10;
    at += lengths[i];
  });

  y -= 14;
  contents.push({ kind: "rule", x1: PAGE.margin, x2: RIGHT, y, weight: 0.5, grey: 0.7 });
  y -= 18;
  y = line(
    contents,
    "Every course above is delivered in-house. The rules require training on this pharmacy's own policies and, " +
      "with one exception, name no qualification for whoever gives it. The exception is the bloodborne pathogens " +
      "standard, which asks for a person knowledgeable in the subject matter and specifies no credential; the " +
      "pharmacist-in-charge's qualifications are recorded on every training record, as 29 CFR 1910.1030(h)(2)(i) " +
      "requires. None of this is continuing education and none of it claims to be.",
    y,
    { size: 9, grey: 0.3 },
  );

  const stamp = (page: Draw[], n: number): Draw[] => [
    { kind: "rule", x1: PAGE.margin, x2: RIGHT, y: 62, weight: 0.5, grey: 0.7 },
    { kind: "text", x: PAGE.margin, y: 50, text: `${pharmacyName} — workforce training`, size: 7.5, grey: 0.45 },
    { kind: "text", x: PAGE.width / 2, y: 50, text: `Page ${n} of ${total}`, size: 7.5, align: "center", grey: 0.45 },
    { kind: "text", x: RIGHT, y: 50, text: preparedOn, size: 7.5, align: "right", grey: 0.45 },
    ...page,
  ];

  const pages: Draw[][] = [stamp(cover, 1), stamp(contents, 2)];
  let offset = front;
  courses.forEach((c) => {
    for (const page of packetPages(c!, pharmacyName, { offset, total })) pages.push(page);
    offset += packetPages(c!, pharmacyName).length;
  });

  return drawnPdf(`Workforce training — ${pharmacyName}`, pages);
}

export function binderFileName(preparedOn: string): string {
  return `workforce-training-binder-${preparedOn}.pdf`;
}
