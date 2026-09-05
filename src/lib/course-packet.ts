import { type Course } from "./courses";
import { drawnPdf, wrapForPdf, PAGE, type Draw } from "./pdf";

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

  if (course.objectives?.length) {
    out.push("WHAT YOU SHOULD BE ABLE TO DO AFTERWARDS", THIN, "");
    for (const o of course.objectives) out.push(indent(wrap("- " + o, 70), "  "), "");
  }

  course.sections.forEach((s, i) => {
    out.push(i + 1 + ". " + s.heading.toUpperCase(), THIN, "");
    for (const para of s.body) out.push(wrap(para), "");
    if (s.takeaways?.length) {
      out.push("  KEY POINTS");
      for (const t of s.takeaways) out.push(indent(wrap("- " + t, 68), "    "));
      out.push("");
    }
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
  );

  out.push("WHO IS ALLOWED TO DELIVER THIS TRAINING", "", wrap(course.whoMayTeach), "");

  if (course.seeAlso?.length) {
    out.push("THIS PHARMACY'S OWN RULES ON THE SUBJECT", "");
    for (const r of course.seeAlso) out.push(indent(wrap("- " + r, 70), "  "));
    out.push("");
  }
  if (course.references?.length) {
    out.push("THE REGULATIONS AND SOURCES BEHIND IT", "");
    for (const r of course.references) out.push(indent(wrap("- " + r, 70), "  "));
    out.push("");
  }

  out.push(
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
 * The course as a document somebody would recognise as a training handout.
 *
 * The first version of this was the text packet with a PDF wrapper round it: one column of
 * paragraphs, no page furniture, nothing to navigate by. It was readable and it did not look like
 * anything. A training handout that looks like a memo gets read like a memo.
 *
 * So this is laid out: a header band on every page, a title block that states what the training
 * satisfies and how long it takes, the learning objectives before the material rather than after
 * it, numbered sections each closing with a shaded key-points box, the questions, the answers with
 * their explanations, the sources, and a completion record at the back for anybody working on
 * paper. Page numbers throughout, so a page that falls out of the file can be put back.
 *
 * The layout engine is thirty lines because the requirement is thirty lines: a cursor down the
 * page, a page break when the next block will not fit, and header and footer stamped on at the end
 * once the page count is known.
 */

const CONTENT_W = PAGE.width - PAGE.margin * 2;
const TOP = PAGE.height - 84;
const FLOOR = 86;

type Sheet = { pages: Draw[][]; page: Draw[]; y: number };

function lineHeight(size: number): number {
  return size * 1.36;
}

/** How tall a wrapped paragraph will be, so a block can be kept whole across a page break. */
function blockHeight(text: string, size: number, width = CONTENT_W): number {
  return wrapForPdf(text, size, width).length * lineHeight(size);
}

function packetPages(course: Course, pharmacyName: string): Draw[][] {
  const sheet: Sheet = { pages: [], page: [], y: TOP };

  const brk = () => {
    sheet.pages.push(sheet.page);
    sheet.page = [];
    sheet.y = TOP;
  };
  /** Break the page unless this much room is left. */
  const need = (h: number) => {
    if (sheet.y - h < FLOOR) brk();
  };
  const gap = (h: number) => {
    sheet.y -= h;
  };
  const para = (
    text: string,
    o: { size?: number; bold?: boolean; grey?: number; indent?: number; width?: number } = {},
  ) => {
    const size = o.size ?? 10;
    const x = PAGE.margin + (o.indent ?? 0);
    const width = o.width ?? CONTENT_W - (o.indent ?? 0);
    for (const line of wrapForPdf(text, size, width)) {
      need(lineHeight(size));
      sheet.y -= lineHeight(size);
      sheet.page.push({ kind: "text", x, y: sheet.y, text: line, size, bold: o.bold, grey: o.grey });
    }
  };

  // ── Title block ────────────────────────────────────────────────
  sheet.y -= 4;
  // Not the pharmacy name again — the running header two lines above already says it.
  para("WORKFORCE TRAINING", { size: 9, bold: true, grey: 0.4 });
  gap(8);
  para(course.title, { size: 20, bold: true });
  gap(6);
  sheet.page.push({ kind: "rule", x1: PAGE.margin, x2: PAGE.width - PAGE.margin, y: sheet.y, weight: 1.4 });
  gap(14);
  para(
    `Approximately ${course.minutes} minutes to read · ${course.questions.length} questions · material version ${courseVersion(course)}`,
    { size: 9, grey: 0.3 },
  );
  gap(4);
  para(`Requirement addressed: ${course.authority}`, { size: 9, grey: 0.3 });
  gap(14);
  para(course.intro, { size: 10.5 });

  // ── What this training is for ──────────────────────────────────
  if (course.objectives?.length) {
    gap(16);
    need(60);
    para("What you should be able to do afterwards", { size: 12, bold: true });
    gap(6);
    for (const o of course.objectives) {
      para(`•  ${o}`, { size: 9.5, indent: 6 });
      gap(3);
    }
  }

  // ── The material ───────────────────────────────────────────────
  course.sections.forEach((sec, i) => {
    gap(20);
    // A heading at the very bottom of a page with its first paragraph overleaf is the classic
    // ugliness of a flowed document, so a heading takes its first paragraph with it.
    need(lineHeight(13) + blockHeight(sec.body[0] ?? "", 10) + 14);
    para(`${i + 1}.  ${sec.heading}`, { size: 13, bold: true });
    gap(4);
    sheet.page.push({
      kind: "rule",
      x1: PAGE.margin,
      x2: PAGE.width - PAGE.margin,
      y: sheet.y,
      weight: 0.6,
      grey: 0.6,
    });
    gap(10);
    for (const b of sec.body) {
      para(b);
      gap(7);
    }

    if (sec.takeaways?.length) {
      const inner = CONTENT_W - 24;
      const h = sec.takeaways.reduce((n, t) => n + blockHeight(`–  ${t}`, 9.5, inner) + 3, 0) + 30;
      gap(6);
      need(h);
      const top = sheet.y;
      sheet.page.push({ kind: "rect", x: PAGE.margin, y: top - h, w: CONTENT_W, h, grey: 0.93 });
      sheet.y = top - 14;
      sheet.page.push({
        kind: "text",
        x: PAGE.margin + 12,
        y: sheet.y,
        text: "KEY POINTS",
        size: 8,
        bold: true,
        grey: 0.35,
      });
      gap(6);
      for (const t of sec.takeaways) {
        para(`–  ${t}`, { size: 9.5, indent: 12, width: inner });
        gap(3);
      }
      sheet.y = top - h;
    }
  });

  // ── Questions ──────────────────────────────────────────────────
  brk();
  para("Check your understanding", { size: 15, bold: true });
  gap(6);
  para(
    "Answer all of them. On the site every answer has to be right before the training is recorded; on paper, mark your answers here and check them against the next page.",
    { size: 9.5, grey: 0.3 },
  );
  gap(10);
  course.questions.forEach((q, i) => {
    const h = blockHeight(`${i + 1}. ${q.q}`, 10) + q.options.length * lineHeight(9.5) + 22;
    need(h);
    gap(10);
    para(`${i + 1}.  ${q.q}`, { size: 10, bold: true });
    gap(4);
    q.options.forEach((o, oi) => {
      para(`${"abcd"[oi]})  ${o}`, { size: 9.5, indent: 18 });
      gap(2);
    });
  });

  // ── Answers ────────────────────────────────────────────────────
  brk();
  para("Answers, and why", { size: 15, bold: true });
  gap(6);
  para("The explanation matters more than the letter. It is the part that changes what happens at the counter.", {
    size: 9.5,
    grey: 0.3,
  });
  gap(8);
  course.questions.forEach((q, i) => {
    gap(9);
    need(blockHeight(q.why, 9.5) + 26);
    para(`${i + 1}.  ${"abcd"[q.answer]})  ${q.options[q.answer]}`, { size: 10, bold: true });
    gap(3);
    para(q.why, { size: 9.5, indent: 18, grey: 0.15 });
  });

  // ── Where it comes from ────────────────────────────────────────
  {
    gap(22);
    need(120);
    para("Where this comes from", { size: 13, bold: true });
    gap(8);
    para("Who is allowed to deliver this training", { size: 10, bold: true });
    gap(4);
    para(course.whoMayTeach, { size: 9.5, indent: 6 });
    gap(10);
    if (course.seeAlso?.length) {
      para("This pharmacy's own rules on the subject", { size: 10, bold: true });
      gap(4);
      for (const r of course.seeAlso) {
        para(`•  ${r}`, { size: 9.5, indent: 6 });
        gap(2);
      }
      gap(8);
    }
    if (course.references?.length) {
      para("The regulations and sources behind it", { size: 10, bold: true });
      gap(4);
      for (const r of course.references) {
        para(`•  ${r}`, { size: 9.5, indent: 6 });
        gap(2);
      }
    }
  }

  // ── Completion record, for the paper route ─────────────────────
  gap(24);
  need(170);
  sheet.page.push({ kind: "rule", x1: PAGE.margin, x2: PAGE.width - PAGE.margin, y: sheet.y, weight: 1 });
  gap(14);
  para("Record of completion", { size: 12, bold: true });
  gap(6);
  para(
    "Complete this training on the site wherever you can — it captures your signature, the time, and that you " +
      "answered the questions correctly, which is a stronger record than a line on a page. This block is here for " +
      "when that is not possible; hand it to the pharmacist-in-charge and it will be entered for you.",
    { size: 9, grey: 0.3 },
  );
  gap(18);
  const half = (PAGE.width - PAGE.margin * 2 - 24) / 2;
  const sigLine = (label: string, x: number, w: number) => {
    sheet.page.push({ kind: "rule", x1: x, x2: x + w, y: sheet.y, weight: 0.6, grey: 0.5 });
    sheet.page.push({ kind: "text", x, y: sheet.y - 11, text: label, size: 8, grey: 0.4 });
  };
  sigLine("Print your name", PAGE.margin, half);
  sigLine("Date completed", PAGE.margin + half + 24, half);
  gap(40);
  sigLine("Your signature", PAGE.margin, half);
  sigLine("Pharmacist-in-charge", PAGE.margin + half + 24, half);
  if (course.liveQuestionsRequired) {
    gap(30);
    para(
      "This training also requires an opportunity for interactive questions and answers with a person " +
        "knowledgeable in the subject. The pharmacist-in-charge records that separately; your record is not " +
        "complete, and no certificate is issued, until he has.",
      { size: 9, grey: 0.25 },
    );
  }

  sheet.pages.push(sheet.page);

  // ── Header and footer, once the page count is known ────────────
  const version = courseVersion(course);
  return sheet.pages.map((page, i) => {
    const n = i + 1;
    const furniture: Draw[] = [
      { kind: "text", x: PAGE.margin, y: PAGE.height - 52, text: pharmacyName, size: 8, bold: true, grey: 0.4 },
      {
        kind: "text",
        x: PAGE.width - PAGE.margin,
        y: PAGE.height - 52,
        text: course.title,
        size: 8,
        align: "right",
        grey: 0.45,
      },
      { kind: "rule", x1: PAGE.margin, x2: PAGE.width - PAGE.margin, y: PAGE.height - 60, weight: 0.5, grey: 0.7 },
      { kind: "rule", x1: PAGE.margin, x2: PAGE.width - PAGE.margin, y: 62, weight: 0.5, grey: 0.7 },
      { kind: "text", x: PAGE.margin, y: 50, text: `Material version ${version}`, size: 7.5, grey: 0.45 },
      {
        kind: "text",
        x: PAGE.width / 2,
        y: 50,
        text: `Page ${n} of ${sheet.pages.length}`,
        size: 7.5,
        align: "center",
        grey: 0.45,
      },
      {
        kind: "text",
        x: PAGE.width - PAGE.margin,
        y: 50,
        text: "Training material — keep with your records",
        size: 7.5,
        align: "right",
        grey: 0.45,
      },
    ];
    return [...furniture, ...page];
  });
}

export function packetPdf(course: Course, pharmacyName: string): Buffer {
  return drawnPdf(`${course.title} — ${pharmacyName}`, packetPages(course, pharmacyName));
}

/** What the PDF is called when it lands in somebody's inbox. */
export function packetPdfFileName(course: Course): string {
  return packetFileName(course).replace(/\.txt$/i, "") + ".pdf";
}
