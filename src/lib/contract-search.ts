import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { newId, sha256 } from "./crypto";
import { pdfText } from "./pdf-text";
import { contractsDir } from "./reference";

/**
 * Searching the contracts already on file, so a BIN can be traced to the agreement that covers it.
 *
 * The contracts were filed, matched against a checklist, and never opened. That is a filing
 * cabinet, not a record. The question actually asked of a contract is "which one covers BIN
 * 610011" — and the only way to answer it was to open twenty PDFs by hand, which is why eighteen
 * BINs went unnamed on the first live claims file while the contracts naming them sat on the same
 * disk.
 *
 * ── Search, not extraction ──
 *
 * The tempting design is to pull BINs out of each contract into a table. It does not work: a
 * six-digit number in a PDF is as likely to be an amount, a date or a section number as a BIN, and
 * a wrong mapping is worse than none — an appeal sent to the wrong PBM is a rate the pharmacy then
 * believes it has challenged.
 *
 * So it runs the other way. The BINs, PCNs and group numbers are already known, from the claims
 * this pharmacy actually billed. Those exact strings are searched for in the contract text. A hit
 * is a fact — this contract contains this number — and the sentence around it is shown so that a
 * person decides what it means.
 */

export type ContractHit = {
  fileName: string;
  contractDocId: string | null;
  /** The words either side of the match, so it can be judged without opening the PDF. */
  snippets: string[];
  matches: number;
};

/** Reads every contract PDF in the data folder and keeps its words. Safe to run again. */
export async function indexContracts(): Promise<{ files: number; indexed: number; scans: number; unchanged: number; problems: string[] }> {
  const dir = contractsDir();
  const out = { files: 0, indexed: 0, scans: 0, unchanged: 0, problems: [] as string[] };
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((e) => e.toLowerCase().endsWith(".pdf"));
  } catch {
    return out;
  }
  out.files = entries.length;

  const held = await db.query.contractText.findMany({ columns: { id: true, fileName: true, sha256: true } });
  const bySha = new Set(held.map((h) => `${h.fileName}|${h.sha256}`));
  const docs = await db.query.contractDocs.findMany({ columns: { id: true, fileName: true } });
  const docByFile = new Map(docs.filter((d) => d.fileName).map((d) => [d.fileName!, d.id]));

  for (const file of entries) {
    try {
      const buf = await fs.readFile(path.join(dir, file));
      const digest = sha256(buf);
      // The same bytes under the same name have not changed, and re-reading a hundred-page PDF is
      // the slow part of this by a wide margin.
      if (bySha.has(`${file}|${digest}`)) {
        out.unchanged++;
        continue;
      }
      let body = "";
      try {
        body = pdfText(buf);
      } catch {
        body = "";
      }
      if (!body.trim()) out.scans++;
      await db.delete(schema.contractText).where(eq(schema.contractText.fileName, file));
      await db.insert(schema.contractText).values({
        id: newId(),
        fileName: file,
        contractDocId: docByFile.get(file) ?? null,
        sha256: digest,
        chars: body.length,
        body,
      });
      out.indexed++;
    } catch (e) {
      out.problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function countAndSnip(hay: string, needle: string, terse = false): { matches: number; snippets: string[] } {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const snippets: string[] = [];
  let matches = 0;
  let at = h.indexOf(n);
  while (at !== -1) {
    matches++;
    if (snippets.length < 3) {
      const from = Math.max(0, at - (terse ? 40 : 120));
      const to = Math.min(hay.length, at + needle.length + (terse ? 40 : 120));
      snippets.push(clean(hay.slice(from, to)));
    }
    at = h.indexOf(n, at + n.length);
    if (matches > 500) break;
  }
  return { matches, snippets };
}

/**
 * Which contracts contain a given string, with the words around each hit.
 *
 * Case-insensitive, and it also tries the string with punctuation stripped, because a BIN printed
 * "610-011" in a contract is the same BIN as "610011" on a claim.
 */
export async function searchContracts(term: string, limit = 20): Promise<ContractHit[]> {
  const needle = term.trim();
  if (needle.length < 3) return [];
  const rows = await db.query.contractText.findMany();
  const hits: ContractHit[] = [];

  for (const r of rows) {
    if (!r.body) continue;
    const direct = countAndSnip(r.body, needle);
    const flatNeedle = needle.replace(/[^0-9A-Za-z]/g, "");
    const loose =
      direct.matches === 0 && flatNeedle.length >= 5
        ? countAndSnip(r.body.replace(/[^0-9A-Za-z]/g, ""), flatNeedle, true)
        : { matches: 0, snippets: [] as string[] };
    const matches = direct.matches + loose.matches;
    if (matches === 0) continue;
    hits.push({
      fileName: r.fileName,
      contractDocId: r.contractDocId,
      matches,
      snippets: [...direct.snippets, ...loose.snippets].slice(0, 3),
    });
  }
  return hits.sort((a, b) => b.matches - a.matches).slice(0, limit);
}

/**
 * For every BIN this pharmacy bills that nothing can name, which contracts mention it.
 *
 * The join that closes the gap: the numbers come from the claims, the answers are in the PDFs, and
 * nothing had ever put the two in the same room.
 */
export async function contractsForUnknownBins(bins: string[]): Promise<Map<string, ContractHit[]>> {
  /*
   * Every contract read once, and every BIN looked for inside it.
   *
   * This called the search once per BIN, and the search reads the full text of every contract on
   * file. With thirty-three unrecognised BINs — which is what this pharmacy actually has — that was
   * thirty-three passes over every contract the practice holds, tens of megabytes each time, on
   * every load of the payers screen. The work belongs the other way round: the contracts are the
   * expensive thing, so read them once and ask all the questions of each.
   */
  const out = new Map<string, ContractHit[]>();
  const wanted = bins.filter((b) => b.trim().length >= 3);
  if (wanted.length === 0) return out;

  const rows = await db.query.contractText.findMany();
  for (const r of rows) {
    if (!r.body) continue;
    const flatBody = r.body.replace(/[^0-9A-Za-z]/g, "");
    for (const bin of wanted) {
      if ((out.get(bin)?.length ?? 0) >= 3) continue;
      const direct = countAndSnip(r.body, bin);
      const loose = direct.matches === 0 && bin.length >= 5 ? countAndSnip(flatBody, bin, true) : { matches: 0, snippets: [] as string[] };
      const matches = direct.matches + loose.matches;
      if (matches === 0) continue;
      out.set(bin, [
        ...(out.get(bin) ?? []),
        { fileName: r.fileName, contractDocId: r.contractDocId, matches, snippets: [...direct.snippets, ...loose.snippets].slice(0, 3) },
      ]);
    }
  }
  for (const [bin, hits] of out) out.set(bin, hits.sort((a, b) => b.matches - a.matches).slice(0, 3));
  return out;
}

/** Whether anything has been indexed yet, for a page that has to say why it found nothing. */
export async function contractIndexState(): Promise<{ files: number; withText: number; scans: number }> {
  const rows = await db.query.contractText.findMany({ columns: { chars: true } });
  return {
    files: rows.length,
    withText: rows.filter((r) => r.chars > 0).length,
    scans: rows.filter((r) => r.chars === 0).length,
  };
}
