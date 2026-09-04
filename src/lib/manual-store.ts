import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { unzip } from "./xlsx";
import { policies, FORMS, appendixVersion } from "./manual";
import { getSettings } from "./settings";

/**
 * The manual, as sections this site owns.
 *
 * Two documents describing one pharmacy always drift, and the drift is invisible until somebody
 * reads both. So there is one document. The pharmacy's own prose is edited here; the sections
 * describing what this system does are generated here and cannot be hand-edited, because a
 * hand-edited copy of a procedure is a promise the software has not made — and a manual is a
 * standard an inspector holds you to.
 */

export type Section = typeof schema.manualSections.$inferSelect;

const GAP = 100;

export async function allSections(includeRetired = false): Promise<Section[]> {
  const rows = await db.query.manualSections.findMany({ orderBy: (m, { asc }) => [asc(m.position)] });
  return includeRetired ? rows : rows.filter((r) => !r.retiredOn);
}

/**
 * Pulls the Word manual apart into sections.
 *
 * Word gives away its own structure: a paragraph carries a style name, and Heading 1 and Heading 2
 * are the chapter and section marks the author already made. Splitting on those rather than on
 * guesswork about capitalisation means the import matches what the author saw on screen — and a
 * paragraph that belongs to no heading yet is kept as a preamble rather than silently dropped,
 * because losing text on import is the one failure that would make nobody trust this again.
 */
export function parseDocx(buf: Buffer): { title: string; level: number; body: string }[] {
  const files = unzip(buf);
  const xml = files.get("word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("That does not look like a Word document — no document body was found inside it.");

  const out: { title: string; level: number; body: string }[] = [];
  let current: { title: string; level: number; body: string[] } | null = null;

  // Each <w:p> is a paragraph. Its style, when it has one, is in w:pStyle.
  for (const para of xml.split("<w:p ").slice(1)) {
    const styleMatch = /<w:pStyle w:val="([^"]+)"/.exec(para);
    const style = styleMatch?.[1] ?? "";
    const text = paragraphText(para);
    if (!text) continue;

    // Table of contents entries carry the field codes, and Word marks them with its own TOC
    // styles. They are a map of the document rather than part of it, and importing them produces
    // a hundred empty sections that look exactly like real ones.
    if (/^TOC\d?$|^TOCHeading$/i.test(style)) continue;
    if (/PAGEREF|\\h \d|^TOC \\o/.test(text)) continue;

    // Three levels, matching the manual's own table of contents. Word documents in practice
    // nest to five or six, and importing every one of those produces a section per paragraph —
    // which is not a manual, it is a pile of fragments nobody will edit.
    const headingLevel = /^Heading(\d)$/i.exec(style)?.[1];
    if (headingLevel && Number(headingLevel) <= 3) {
      if (current) out.push({ ...current, body: current.body.join("\n\n") });
      current = { title: text, level: Number(headingLevel), body: [] };
      continue;
    }
    if (!current) current = { title: "Front matter", level: 1, body: [] };
    current.body.push(text);
  }
  if (current) out.push({ ...current, body: current.body.join("\n\n") });

  // A heading with nothing under it and nothing after it is the empty appendix problem: worth
  // importing so it is visible as empty, rather than dropped so it is invisible.
  return out.filter((s) => s.title.trim().length > 0);
}

/**
 * The visible text of one Word paragraph.
 *
 * Not every character in a Word paragraph is inside a <w:t>. A hyphen the author did not want
 * broken across a line is its own element, and reading only the text runs turns
 * "Pharmacist-in-Charge" into "PharmacistinCharge" — 284 times in this pharmacy's manual, silently,
 * in a document nobody proof-reads after an import because it is supposed to be the same document
 * they wrote. Line breaks and tabs go the same way. So the paragraph is walked in document order
 * and each of those elements contributes the character it stands for.
 */
function paragraphText(para: string): string {
  // Paragraph properties carry tab-stop definitions and style marks, not text.
  const body = para.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, "");
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(noBreakHyphen|softHyphen|tab|br|cr)\s*\/>/g;
  for (const m of body.matchAll(re)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[2] === "noBreakHyphen") out += "-";
    else if (m[2] === "softHyphen") out += "";
    else if (m[2] === "tab") out += "\t";
    else out += "\n";
  }
  return out.trim();
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export async function importDocx(buf: Buffer, user: { name: string }): Promise<{ imported: number }> {
  const parsed = parseDocx(buf);
  if (parsed.length === 0) throw new Error("No headings were found, so there was nothing to split the manual into.");

  // Replace whatever pharmacy-owned sections are there. Site sections are regenerated separately
  // and must survive an import, or importing would silently delete the half that stays current.
  const existing = await db.query.manualSections.findMany();
  for (const row of existing.filter((r) => r.source === "pharmacy")) {
    await db.delete(schema.manualSections).where(eq(schema.manualSections.id, row.id));
  }

  let pos = GAP;
  for (const s of parsed) {
    await db.insert(schema.manualSections).values({
      id: newId(),
      source: "pharmacy",
      title: s.title.slice(0, 300),
      level: s.level,
      position: pos,
      body: s.body,
      updatedBy: user.name,
    });
    pos += GAP;
  }
  await regenerateSiteSections(user);
  return { imported: parsed.length };
}

/**
 * Writes the site-owned sections, replacing whatever was there.
 *
 * Runs on import and whenever asked. These are the sections that keep the manual honest: they say
 * what the software does, so they are rewritten from the software rather than maintained by hand.
 */
export async function regenerateSiteSections(user: { name: string }): Promise<{ written: number }> {
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const p = policies(pharmacy);

  const existing = await db.query.manualSections.findMany();
  const last = existing.reduce((n, r) => Math.max(n, r.position), 0);
  let pos = Math.max(last + GAP, 100000); // site sections sit at the back, as the appendix

  const wanted: { key: string; title: string; body: string; level: number }[] = [
    {
      key: "appendix_intro",
      title: "Appendix A — procedures and forms maintained in the compliance system",
      level: 1,
      body:
        `This appendix records the procedures ${pharmacy} performs through its compliance system, and the forms that ` +
        `system produces. It is generated from that system rather than written by hand, so that the manual and the ` +
        `practice cannot drift apart. Where the body of this manual refers to one of these procedures, this appendix ` +
        `is the current version of it.\n\nAppendix version ${appendixVersion(p)}.`,
    },
    ...p.map((x) => ({
      key: `policy_${x.key}`,
      title: `A.1 ${x.title}`,
      level: 2,
      body: `${x.text.join("\n\n")}\n\n${x.authority}`,
    })),
    {
      key: "appendix_forms",
      title: "A.2 Forms produced by the compliance system",
      level: 2,
      body:
        FORMS.map((f) => `${f.name}\n${f.purpose}\nWhen: ${f.cadence}`).join("\n\n") +
        "\n\nNo blank copies are reproduced here. A blank form in a manual is the version that goes out of date first " +
        "and is the one somebody photocopies; the current version is produced by the system on demand.",
    },
  ];

  for (const w of wanted) {
    const found = existing.find((r) => r.source === "site" && r.sourceKey === w.key);
    if (found) {
      await db
        .update(schema.manualSections)
        .set({ title: w.title, body: w.body, level: w.level, updatedBy: "the compliance system", updatedAt: new Date().toISOString() })
        .where(eq(schema.manualSections.id, found.id));
      continue;
    }
    await db.insert(schema.manualSections).values({
      id: newId(),
      sourceKey: w.key,
      source: "site",
      title: w.title,
      level: w.level,
      position: pos,
      body: w.body,
      updatedBy: "the compliance system",
    });
    pos += GAP;
  }

  // A site section whose key no longer exists is retired rather than deleted, so a manual printed
  // last year can still be explained.
  const keys = new Set(wanted.map((w) => w.key));
  for (const row of existing.filter((r) => r.source === "site" && r.sourceKey && !keys.has(r.sourceKey) && !r.retiredOn)) {
    await db
      .update(schema.manualSections)
      .set({ retiredOn: todayIso(), updatedBy: user.name })
      .where(eq(schema.manualSections.id, row.id));
  }
  return { written: wanted.length };
}

export async function saveSection(
  id: string,
  input: { title?: string; body?: string },
  user: { name: string },
): Promise<void> {
  const row = await db.query.manualSections.findFirst({ where: eq(schema.manualSections.id, id) });
  if (!row) throw new Error("That section no longer exists.");
  if (row.source === "site") {
    throw new Error(
      "This section is generated from what the system actually does and cannot be edited here. Change the practice, or the setting behind it, and the section follows.",
    );
  }
  await db
    .update(schema.manualSections)
    .set({
      title: input.title?.trim() || row.title,
      body: input.body ?? row.body,
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.manualSections.id, id));
}

export async function addSection(afterId: string | null, user: { name: string }): Promise<string> {
  const rows = await allSections();
  const after = afterId ? rows.find((r) => r.id === afterId) : null;
  const next = after ? rows.find((r) => r.position > after.position) : rows[0];
  const position = after
    ? next
      ? Math.round((after.position + next.position) / 2)
      : after.position + GAP
    : (rows[0]?.position ?? GAP) - GAP;

  const id = newId();
  await db.insert(schema.manualSections).values({
    id,
    source: "pharmacy",
    title: "New section",
    level: after?.level ?? 1,
    position,
    body: "",
    updatedBy: user.name,
  });
  return id;
}

export async function removeSection(id: string, user: { name: string }): Promise<void> {
  const row = await db.query.manualSections.findFirst({ where: eq(schema.manualSections.id, id) });
  if (!row) return;
  if (row.source === "site") throw new Error("A generated section cannot be removed by hand.");
  await db.update(schema.manualSections).set({ retiredOn: todayIso(), updatedBy: user.name }).where(eq(schema.manualSections.id, id));
}

export async function markReviewed(id: string, user: { name: string }): Promise<void> {
  await db
    .update(schema.manualSections)
    .set({ reviewedOn: todayIso(), reviewedBy: user.name, updatedAt: new Date().toISOString() })
    .where(eq(schema.manualSections.id, id));
}

/**
 * The manual's shape: numbering, which chapter a section belongs to, and whether anything sits
 * under it.
 *
 * Numbering is computed rather than stored, because a number stored against a section is wrong the
 * moment somebody inserts a section above it, and a contents page that disagrees with the body is
 * worse than no contents page.
 *
 * `hasChildren` is what stops the manual crying wolf. "Pharmacy Policies" is a chapter heading with
 * eleven policies under it and no prose of its own, which is exactly how a manual is supposed to
 * look — flagging it as an empty section next to a genuinely empty "Business Associate Agreement"
 * teaches the reader to ignore the list.
 */
export type SectionNode = Section & { hasChildren: boolean; chapterId: string; number: string; depth: number };

export function outline(rows: Section[]): SectionNode[] {
  // A Word manual is full of headings that skip a level — a Heading 3 sitting directly under a
  // Heading 1, because somebody liked the way it looked. Numbered literally that reads "3.0.1",
  // which looks like a bug in the manual rather than a quirk of the file it came from. So a
  // heading is never more than one level deeper than the one above it, and the first heading in
  // the document is always a chapter whatever it was marked as.
  const openLevels: number[] = [];
  const depths = rows.map((r) => {
    const raw = Math.min(Math.max(r.level, 1), 3);
    while (openLevels.length > 0 && openLevels[openLevels.length - 1] >= raw) openLevels.pop();
    const d = Math.min(openLevels.length, 2);
    openLevels.push(raw);
    return d;
  });

  const counters = [0, 0, 0];
  let chapterId = rows[0]?.id ?? "";
  return rows.map((r, i) => {
    const depth = depths[i];
    counters[depth] += 1;
    for (let j = depth + 1; j < counters.length; j++) counters[j] = 0;
    if (depth === 0) chapterId = r.id;
    return {
      ...r,
      depth,
      hasChildren: depths[i + 1] !== undefined && depths[i + 1] > depth,
      chapterId,
      number: counters.slice(0, depth + 1).join("."),
    };
  });
}

/** A heading that promises something, has nothing under it, and no sections beneath it either. */
export function gaps(rows: Section[]): SectionNode[] {
  return outline(rows).filter((s) => s.source === "pharmacy" && !s.body.trim() && !s.hasChildren);
}

/**
 * The annual review, done as one act.
 *
 * An annual review of a manual is one sitting, not a hundred and thirty-five button presses, and a
 * tool that demands the latter gets a date nobody can defend or no date at all.
 */
export async function markAllReviewed(user: { name: string }): Promise<number> {
  const rows = await allSections();
  const own = rows.filter((r) => r.source === "pharmacy");
  for (const r of own) {
    await db
      .update(schema.manualSections)
      .set({ reviewedOn: todayIso(), reviewedBy: user.name })
      .where(eq(schema.manualSections.id, r.id));
  }
  return own.length;
}

/**
 * Footnote markers pointing at a bibliography that is not in the document.
 *
 * Five sections of this manual carry 397 of them — "[8][10]" after almost every sentence of the
 * controlled substances chapter, with no reference list anywhere in the manual. They are the
 * fingerprint of text pasted in from a research tool, and an inspector reading a controlled
 * substances policy is exactly the reader most likely to notice. The policy underneath may be
 * perfectly good; the markers make it look borrowed.
 *
 * A digits-only bracket is the only shape removed. Anything a person actually wrote in
 * brackets — "[Reserved]", "[see Appendix A]" — is left where it is.
 */
const CITATION = /\s*(?:\[\d{1,3}\])+/g;

export function citationMarkers(rows: Section[]): { id: string; title: string; count: number }[] {
  return rows
    .filter((r) => r.source === "pharmacy")
    .map((r) => ({ id: r.id, title: r.title, count: (r.body.match(CITATION) ?? []).length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Removes them, keeping the punctuation that followed. Returns how many sections changed. */
export async function stripCitationMarkers(user: { name: string }): Promise<{ sections: number; markers: number }> {
  const rows = await allSections();
  let sections = 0;
  let markers = 0;
  for (const r of rows) {
    if (r.source !== "pharmacy") continue;
    const found = (r.body.match(CITATION) ?? []).length;
    if (!found) continue;
    markers += found;
    sections += 1;
    await db
      .update(schema.manualSections)
      .set({ body: r.body.replace(CITATION, ""), updatedBy: user.name, updatedAt: new Date().toISOString() })
      .where(eq(schema.manualSections.id, r.id));
  }
  return { sections, markers };
}

/** Sections nobody has confirmed in the last year — what an annual manual review is actually for. */
export async function needingReview(): Promise<Section[]> {
  const rows = await allSections();
  const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  return rows.filter((r) => r.source === "pharmacy" && (!r.reviewedOn || r.reviewedOn < cutoff));
}
