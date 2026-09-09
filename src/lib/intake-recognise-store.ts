import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { classify } from "./autoroute";
import { pdfText } from "./pdf-text";
import { triageByText } from "./contract-triage";
import { classifySupplierDocument } from "./invoices";
import { looksLikeX12Remittance } from "./business-docs";
import { readZipBounded } from "./zip-read";
import { readFile } from "./files";
import { CATEGORIES, recognise, ruleFromCorrection, categoryFor, type Evidence, type Recognition, type SenderHistory, type SenderRule } from "./intake-recognise";

/**
 * The evidence, gathered.
 *
 * `intake-recognise.ts` decides; this fetches what it decides on. The split is the one the rest of
 * the site uses — the judgement is a pure function with tests, and everything that touches the
 * database is here, where it can be read in one go and where nothing arithmetical happens.
 *
 * Nothing in this file imports an importer, and nothing here writes to a table an importer owns.
 * The seam is `recogniseStored()`: the mailbox sweep can call it before it decides what to do with
 * an attachment, and until it does, the inbox page calls it on demand for anything that was not
 * placed. That change belongs to whoever owns the sweep, so it is not made here.
 */

/** A rule as it is kept, which is the pure module's rule plus who said it and when. */
export type StoredRule = SenderRule & {
  id: string;
  note: string | null;
  wasGuessedAs: string | null;
  taughtBy: string | null;
  taughtAt: string;
};

export async function senderRules(): Promise<StoredRule[]> {
  const rows = await db.select().from(schema.intakeRules).orderBy(desc(schema.intakeRules.taughtAt));
  return rows.map((r) => ({
    id: r.id,
    address: r.address,
    category: r.category,
    subject: r.subjectFragment,
    fileName: r.fileNameFragment,
    note: r.note,
    wasGuessedAs: r.wasGuessedAs,
    taughtBy: r.taughtBy,
    taughtAt: r.taughtAt,
  }));
}

/*
 * What a placed document was recorded as, in the vocabulary the recogniser uses.
 *
 * The inbox records `routedAs` in the routing vocabulary — the kinds `classify()` returns, plus
 * the two the sweep sets itself. History is only worth anything if it speaks the same language as
 * the guesses, so it is translated once, here, rather than compared loosely anywhere.
 */
const CATEGORY_BY_VERDICT = new Map<string, string>();
for (const c of CATEGORIES) for (const v of c.fromContent ?? []) CATEGORY_BY_VERDICT.set(v, c.key);
CATEGORY_BY_VERDICT.set("invoice", "supplier_invoice");
CATEGORY_BY_VERDICT.set("supplier_statement", "supplier_statement");
CATEGORY_BY_VERDICT.set("bill", "expense_invoice");

/** The category a routing verdict means, or null where it means nothing to the recogniser. */
export function categoryForVerdict(verdict: string | null | undefined): string | null {
  if (!verdict) return null;
  return CATEGORY_BY_VERDICT.get(verdict) ?? (categoryFor(verdict) ? verdict : null);
}

/**
 * What this sender has actually sent before.
 *
 * Only lines that ended in something being placed are counted. A sender whose files were all
 * unrecognised has no history — counting those would let the recogniser feed on its own failures,
 * which is how a system convinces itself of something untrue.
 */
export async function historyFor(fromAddress: string): Promise<SenderHistory[]> {
  const from = (fromAddress ?? "").trim().toLowerCase();
  if (!from) return [];
  const rows = await db
    .select({ routedAs: schema.inboxItems.routedAs, n: sql<number>`count(*)` })
    .from(schema.inboxItems)
    .where(sql`lower(${schema.inboxItems.fromAddress}) = ${from} and ${schema.inboxItems.routedAs} is not null and ${schema.inboxItems.routedAs} <> 'unrecognised'`)
    .groupBy(schema.inboxItems.routedAs);
  const tally = new Map<string, number>();
  for (const r of rows) {
    const key = categoryForVerdict(r.routedAs);
    if (!key) continue;
    tally.set(key, (tally.get(key) ?? 0) + Number(r.n ?? 0));
  }
  return [...tally].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

/**
 * Everything the existing detectors make of these bytes, as one verdict.
 *
 * `classify()` first, because it is free and certain when it fires. Where it says nothing and the
 * file is a PDF, the two readers that work on extracted text are asked in turn: the supplier
 * document sorter, which knows an invoice from a statement, and the contract triage, which knows a
 * rate sheet from a notice. Their answers are namespaced so no two detectors can be confused for
 * one another, and so that a detector growing a new verdict is a row in the category table.
 */
export function contentVerdict(fileName: string, buf: Buffer, subject = ""): { verdict: string; why: string; headers?: string[] } | null {
  const cls = classify(fileName, buf);
  if (cls.kind !== "unrecognised") return { verdict: cls.kind, why: cls.why, headers: cls.headers };
  /*
   * A remittance advice, known by its envelope rather than by its name.
   *
   * BACKLOG item 27: the owner is having 835s emailed here, and a payer names the file whatever it
   * likes — `.835`, `.edi`, `.dat`, `.txt`, or nothing at all. The name is therefore no evidence and
   * the envelope is conclusive: an ISA header with an ST*835 inside it is a remittance and is not
   * anything else.
   *
   * Asked here rather than in `classify()` on purpose. `classify()` is what the sweep and the Add
   * tool route on, and `readIntoIntake` calls `importDropped` *before* its own 835 branch — so a
   * kind returned there would be claimed by the router and short-circuit the working path to
   * `importRemittance` before the sweep has anywhere to post one. The recogniser can name a
   * document without anything routing it, which is exactly what it is for. The verdict is
   * namespaced like the other borrowed detectors, and the category also accepts the bare
   * `remittance_835` that `classify()` will return once the posting side lands.
   */
  if (looksLikeX12Remittance(buf, fileName)) {
    return { verdict: "x12:remittance", why: "An X12 envelope carrying an 835: a remittance advice, whatever the file is called." };
  }
  /*
   * And the same file inside an archive, which is how a clearinghouse sends a day of them at once.
   * Bounded, because this is a file from outside: see `readZipBounded`.
   */
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const held = readZipBounded(buf).find((e) => looksLikeX12Remittance(e.data, e.name));
    if (held) return { verdict: "x12:remittance", why: `A zip holding a remittance: ${held.name} is an X12 envelope carrying an 835.` };
  }
  let text = "";
  if (/^%PDF/.test(buf.subarray(0, 8).toString("latin1"))) {
    try {
      text = pdfText(buf);
    } catch {
      // A scan. There is nothing to read and nothing to conclude from that.
    }
  }
  if (text) {
    const sup = classifySupplierDocument(text, fileName, subject);
    if (sup.kind !== "unknown") return { verdict: `supplier:${sup.kind}`, why: sup.why };
    const triage = triageByText(text, fileName);
    if (triage && triage.kind !== "not_relevant" && triage.kind !== "unsure") {
      return { verdict: `triage:${triage.kind}`, why: triage.why ?? `Reads as a ${triage.kind.replace(/_/g, " ")}.` };
    }
  }
  return { verdict: "unrecognised", why: cls.why };
}

/** What the site makes of a message, given its bytes. Everything except the bytes comes from the tables. */
export async function recogniseBytes(input: {
  fileName: string;
  buf: Buffer;
  fromAddress?: string | null;
  fromName?: string | null;
  subject?: string | null;
  rules?: StoredRule[];
}): Promise<Recognition> {
  const rules = input.rules ?? (await senderRules());
  const ev: Evidence = {
    fromAddress: input.fromAddress ?? null,
    fromName: input.fromName ?? null,
    subject: input.subject ?? null,
    fileName: input.fileName,
    content: contentVerdict(input.fileName, input.buf, input.subject ?? ""),
    rules,
    history: await historyFor(input.fromAddress ?? ""),
  };
  return recognise(ev);
}

/**
 * What the site makes of a line on the inbox, reading the file behind it.
 *
 * Reads a file from storage, so it is called for the lines that need it and not for two hundred at
 * once. Returns null where there is nothing to read, which is the ordinary case for a message that
 * was refused before anything was stored.
 */
export async function recogniseStored(itemId: string, rules?: StoredRule[]): Promise<Recognition | null> {
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item?.documentId) return null;
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) });
  if (!doc) return null;
  let buf: Buffer;
  try {
    buf = await readFile(doc.storageKey);
  } catch {
    return null;
  }
  return recogniseBytes({
    fileName: doc.fileName,
    buf,
    fromAddress: item.fromAddress,
    subject: item.subject,
    rules,
  });
}

/**
 * The correction, kept as a rule, so next week needs no correcting.
 *
 * The shape of the rule is worked out by `ruleFromCorrection` and the reason is written down in
 * the owner's own words. A second correction for the same sender and the same shape replaces the
 * first rather than piling up: a rule list nobody can read is a rule list nobody trusts.
 */
export async function teachSender(input: {
  fromAddress: string;
  category: string;
  fileName?: string | null;
  subject?: string | null;
  wasGuessedAs?: string | null;
  contentDisagreed?: boolean;
  note?: string | null;
  taughtBy?: string | null;
}): Promise<{ rule: StoredRule; replaced: boolean } | null> {
  const rule = ruleFromCorrection(input);
  if (!rule) return null;
  const existing = await db.select().from(schema.intakeRules).where(eq(schema.intakeRules.address, rule.address));
  const same = existing.find(
    (r) => (r.subjectFragment ?? null) === (rule.subject ?? null) && (r.fileNameFragment ?? null) === (rule.fileName ?? null),
  );
  const values = {
    address: rule.address,
    category: rule.category,
    subjectFragment: rule.subject ?? null,
    fileNameFragment: rule.fileName ?? null,
    wasGuessedAs: input.wasGuessedAs ?? null,
    note: input.note?.trim() || null,
    taughtBy: input.taughtBy ?? null,
  };
  if (same) {
    await db.update(schema.intakeRules).set(values).where(eq(schema.intakeRules.id, same.id));
    return { rule: { ...rule, id: same.id, note: values.note, wasGuessedAs: values.wasGuessedAs, taughtBy: values.taughtBy, taughtAt: same.taughtAt }, replaced: true };
  }
  const id = newId();
  await db.insert(schema.intakeRules).values({ id, ...values });
  return { rule: { ...rule, id, note: values.note, wasGuessedAs: values.wasGuessedAs, taughtBy: values.taughtBy, taughtAt: new Date().toISOString() }, replaced: false };
}

export async function forgetRule(id: string): Promise<void> {
  await db.delete(schema.intakeRules).where(eq(schema.intakeRules.id, id));
}

/** A rule in a sentence, for the page that lists them. */
export function describeRule(r: StoredRule): string {
  const what = categoryFor(r.category)?.label ?? r.category;
  const narrowing = [
    r.subject ? `whose subject mentions “${r.subject}”` : "",
    r.fileName ? `whose file is named like “${r.fileName}”` : "",
  ].filter(Boolean);
  const where = narrowing.length ? ` ${narrowing.join(" and ")}` : "";
  return `Mail from ${r.address}${where} is ${what.toLowerCase()}.`;
}
