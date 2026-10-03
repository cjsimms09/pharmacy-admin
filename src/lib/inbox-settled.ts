import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Which arrivals have since been dealt with, whatever the row says happened on the day.
 *
 * ── Why the row is not the answer ──
 *
 * An inbox row records the decision taken when the message arrived. That is a fact about a moment,
 * and the inbox shows it as though it were the state of things now. The two drift apart constantly,
 * because the work of dealing with a document mostly happens afterwards and somewhere else.
 *
 * The owner, 18 September 2026: "3 things in inbox not filed.. one is a tech immunization training
 * that I hit file to that person but its staying in the inbox. one is rxsystems invoice." Both were
 * finished. The certificate was attached to the technician and to her immunization-training
 * credential; the Rx Systems invoice was booked as $1,715.00 of pharmacy supplies. Neither inbox row
 * knew, so both sat on a list of things to do, and he went looking for work that did not exist.
 *
 * That is worse than a wrong count. A list of outstanding work containing finished work cannot be
 * emptied, and a list that cannot be emptied stops being read — which is how the one item that DOES
 * need him goes past with the other two.
 *
 * ── Worked out now, from what points at the document ──
 *
 * So the question is not "what did the router decide" but "has anything since taken responsibility
 * for this document". Anything at all counts: an expense booked from it, a credential or a person it
 * was filed against, an invoice, a receipt, a payment. Each is a different person having dealt with
 * it in a different place, and any one of them means the inbox has nothing left to ask.
 *
 * The columns are found by reading the schema rather than listed here, for the reason the duplicate
 * clean-up found out the hard way: a hand-kept list of the tables that name a document is right on
 * the day it is written and quietly wrong at the next migration.
 */

/** Document ids something in the site now points at, and what took it. */
export async function settledDocuments(): Promise<Map<string, string>> {
  const tables = await db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not in ('documents', 'inbox_items') order by name`,
  );

  /** A table's name said the way a person would say it: "supplier_invoices" → "a supplier invoice". */
  const asThing = (table: string) => {
    const words = table.replace(/_/g, " ").replace(/s$/, "");
    return /^[aeiou]/i.test(words) ? `an ${words}` : `a ${words}`;
  };

  const out = new Map<string, string>();
  for (const t of tables) {
    const cols = await db.all<{ name: string }>(sql.raw(`pragma table_info("${t.name}")`));
    const naming = cols.filter((c) => /document_id$/i.test(c.name));
    if (naming.length === 0) continue;
    for (const col of naming) {
      const rows = await db.all<{ v: string | null }>(
        sql.raw(`select distinct "${col.name}" as v from "${t.name}" where "${col.name}" is not null`),
      );
      for (const r of rows) {
        /* First writer wins: the earliest table alphabetically is as good a name as any, and stable. */
        if (r.v && !out.has(r.v)) out.set(r.v, asThing(t.name));
      }
    }
  }

  /*
   * And the documents filed against a person or a credential, which name the document from the
   * other side: `documents.person_id` rather than a `document_id` column elsewhere. Filing a
   * certificate to a technician is exactly the case the owner raised, and it leaves no row anywhere
   * pointing back at the document — the document points out.
   */
  const filed = await db.all<{ id: string; person: string | null; credential: string | null }>(
    sql`select id, person_id as person, credential_id as credential from documents where person_id is not null or credential_id is not null`,
  );
  for (const d of filed) {
    if (!out.has(d.id)) out.set(d.id, d.credential ? "a staff credential" : "a person's record");
  }

  return out;
}
