/**
 * The PSAO's contracted PBM listing, read into the BIN register.
 *
 * Health Mart Atlas publishes "PBM Contracted Listing" once a year: one row per PBM, with the
 * lines of business the pharmacies under the PSAO are contracted for, the BINs that adjudicate
 * under that PBM, and the help-desk contacts. The owner uploaded the 2026 one on 8 September.
 *
 * What it settles, and what it does not. It is the document that says which PBM a BIN belongs to
 * (until now most BIN rows read "named by Cory Simms from a claim"), and which networks — by
 * name — this pharmacy is in through the PSAO. It prints no network reimbursement id, no PCN and
 * no group, so it does not by itself say which contract priced a claim; it narrows that question
 * to the networks named here. A BIN listed under two PBMs (610084 sits under Caremark, Express
 * Scripts and Optum) is kept under each and marked as colliding, because the listing says both
 * and choosing would be a guess.
 *
 * The parse is pure and tested on made-up rows; the load writes the register.
 */

export type ListingRow = {
  pbm: string;
  linesOfBusiness: string[];
  bins: string[];
  helpDesk: string | null;
  /** Prose the BIN cell carried besides the numbers, e.g. "Commercial BINs no longer active under Change Healthcare 02/02/24". */
  binNote: string | null;
};

export type ListingParse = { title: string | null; rows: ListingRow[]; problems: string[] };

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Every BIN in a cell: six digits, or five with the leading zero dropped by a spreadsheet. */
export function binsIn(cell: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (cell ?? "").matchAll(/\b(\d{5,6})\b/g)) {
    const b = m[1].length === 5 ? `0${m[1]}` : m[1];
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

export function parsePbmListing(rows: string[][]): ListingParse {
  const problems: string[] = [];
  let title: string | null = null;
  let header = -1;
  for (const [i, r] of rows.entries()) {
    const first = squash(r[0]);
    if (header < 0 && /^PBM$/i.test(first)) {
      header = i;
      break;
    }
    if (first && title === null) title = first;
  }
  if (header < 0) return { title, rows: [], problems: ["No header row beginning \"PBM\" was found; this is not the PSAO's contracted PBM listing."] };

  const out: ListingRow[] = [];
  for (const r of rows.slice(header + 1)) {
    const pbm = squash(r[0]);
    if (!pbm) continue;
    if (/confidential|proprietary/i.test(pbm) && binsIn(r[2]).length === 0) continue; // the footer
    const lines = (r[1] ?? "")
      .split(/\r?\n/)
      .map((x) => squash(x))
      .filter((x) => x.length > 0);
    const bins = binsIn(r[2]);
    const binNote = squash((r[2] ?? "").replace(/\b\d{5,6}\b/g, "").replace(/[,\s]+/g, " ")) || null;
    if (bins.length === 0) problems.push(`${pbm}: no BIN on the row.`);
    out.push({ pbm, linesOfBusiness: lines, bins, helpDesk: squash(r[3]) || null, binNote: binNote && binNote.length > 3 ? binNote : null });
  }
  return { title, rows: out, problems };
}

/** BINs that appear under more than one PBM in the listing. */
export function collisions(rows: ListingRow[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const r of rows) for (const b of r.bins) by.set(b, [...(by.get(b) ?? []), r.pbm]);
  return new Map([...by.entries()].filter(([, pbms]) => pbms.length > 1));
}

export type ListingLoad = {
  ok: true;
  title: string | null;
  pbms: number;
  bins: number;
  inserted: number;
  updated: number;
  collisions: number;
  problems: string[];
} | { ok: false; why: string };

/**
 * Writes the listing into the BIN register, additively.
 *
 * A BIN already on the register keeps its name (the claims are labelled by it) and gains the
 * listing's PBM as an alias, its lines of business, its help desk and a note naming the listing.
 * A BIN not on the register is added under the listing's PBM. Nothing is deleted.
 */
export async function loadPbmListing(file: Buffer, fileName: string, by: { name: string }): Promise<ListingLoad> {
  const { readSheet } = await import("./xlsx");
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { newId } = await import("./crypto");
  const parsed = parsePbmListing(readSheet(file));
  if (parsed.rows.length === 0) return { ok: false, why: parsed.problems[0] ?? "The listing holds no PBM rows." };

  const collide = collisions(parsed.rows);
  const source = `${parsed.title ?? "PBM Contracted Listing"} (${fileName}), loaded ${new Date().toISOString().slice(0, 10)} by ${by.name}`;
  const held = await db.query.payerBins.findMany();
  let inserted = 0;
  let updated = 0;
  const bins = new Set<string>();
  for (const r of parsed.rows) {
    const lines = r.linesOfBusiness.join("\n") || null;
    for (const b of r.bins) {
      bins.add(b);
      const existing = held.filter((h) => h.bin === b);
      const isCollision = collide.has(b);
      if (existing.length === 0) {
        await db.insert(schema.payerBins).values({
          id: newId(),
          bin: b,
          pbmName: r.pbm,
          linesOfBusiness: lines,
          helpDesk: r.helpDesk,
          notes: [`From ${source}.`, r.binNote].filter(Boolean).join(" "),
          collides: isCollision,
        });
        inserted++;
        continue;
      }
      for (const h of existing) {
        const aliasSet = new Set((h.aliases ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
        if (r.pbm.trim().toLowerCase() !== h.pbmName.trim().toLowerCase()) aliasSet.add(r.pbm);
        const note = (h.notes ?? "").includes(source) ? h.notes : [h.notes, `From ${source}.`, r.binNote].filter(Boolean).join(" ");
        await db
          .update(schema.payerBins)
          .set({ aliases: [...aliasSet].join("\n") || null, linesOfBusiness: lines ?? h.linesOfBusiness, helpDesk: r.helpDesk ?? h.helpDesk, notes: note, collides: h.collides || isCollision })
          .where(eq(schema.payerBins.id, h.id));
        updated++;
      }
    }
  }
  return { ok: true, title: parsed.title, pbms: parsed.rows.length, bins: bins.size, inserted, updated, collisions: collide.size, problems: parsed.problems };
}
