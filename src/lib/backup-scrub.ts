import "server-only";
import crypto from "node:crypto";
import { createClient, type Client } from "@libsql/client";

/**
 * A copy of the database with every identifier taken out, for sending somewhere it can be worked on.
 *
 * The pharmacy's own copy is the one that matters and it never leaves the building. This is the
 * other thing that is sometimes needed: a copy that can be handed to somebody debugging the site,
 * carrying every figure the purchasing, pricing and money screens run on, and nothing that could
 * ever be traced to a person.
 *
 * The reason it exists is arithmetic, not convenience. Two changes shipped in a week were wrong in
 * ways that only showed against real data — a directory reading that turned a $124.99 patch into a
 * $0.74 one, and a price check that withheld a wholesaler's genuinely cheapest line. Neither could
 * appear in any test, because the tables that would have shown them were empty in every copy
 * available to test against. A pharmacist should not be the thing standing between a bug and its
 * discovery.
 *
 * ── What is taken out, and why each ──
 *
 * Prescription numbers are the only patient identifier this site stores; it holds no name, no date
 * of birth, no address, and never has. They are replaced by a stand-in derived from a salt made
 * fresh for each copy, so the same prescription reads the same throughout one copy — a claim billed
 * to a primary plan and then a secondary still groups as one fill, which is the whole basis of the
 * reimbursement figures — and no stand-in can be turned back into a number or matched against
 * another copy.
 *
 * The incident log's free text goes entirely. Root causes and corrective actions are written by
 * people about events involving people, and no rule about column names can promise what is in a
 * paragraph. The dates, the types and the shape of the record stay, which is all the compliance
 * screens compute from.
 *
 * Staff become "Staff one", "Staff two". Every secret — the API key, the mail password, the
 * password hashes, the sensor credentials — is emptied rather than trusted to be unreadable
 * without its key. The pharmacy's DEA, NPI and NCPDP numbers go: they are not patient data but
 * they are keys to things, and nothing here needs them.
 *
 * Documents do not travel at all. The archive carries the database only. A PDF cannot be scrubbed
 * by rule, and there is nothing in the invoices, licences and reports that the tables do not
 * already hold in a form that can be reasoned about.
 *
 * ── And then it is proved ──
 *
 * A scrub that is merely written is a scrub nobody has watched fail. Every table and column in the
 * finished copy is read back and searched for anything that still looks like an identifier, and a
 * copy that fails is refused rather than written. See `provePrivate`.
 */

/** Free text that describes people, kept as a shape and not as words. */
const BLANKED_TEXT: Record<string, string[]> = {
  /*
   * The policy manual's prose, which is the pharmacy's own writing and carries its address,
   * telephone, NPI and DEA on the front page. None of it is needed to reason about prices,
   * packages or the books, and it is the largest body of free text in the database. The headings,
   * the review dates and the structure stay, which is what the compliance screens compute from.
   */
  manual_sections: ["body"],
  cqi_incidents: [
    "description",
    "employee_communication",
    "root_cause_analysis",
    "corrective_action_plan",
    "employee_reviews",
    "rca_before_ai",
    "cap_before_ai",
    "type_other",
    "external_report_ref",
  ],
};

/** Emptied outright: secrets, and identifiers that are keys to something. */
const EMPTIED: { table: string; columns: string[] }[] = [
  { table: "users", columns: ["password_hash"] },
  { table: "cqi_incidents", columns: ["rx_numbers_enc"] },
  { table: "claims", columns: ["raw_json"] },
  { table: "pbm_contacts", columns: ["phone", "email"] },
  { table: "business_associates", columns: ["contact_email"] },
  { table: "invoice_forwards", columns: ["to_address"] },
  { table: "training_assignments", columns: ["reply_from_address"] },
];

/** Settings whose values are secrets or keys. The key stays so its presence is still visible. */
const EMPTIED_SETTINGS = [
  "anthropic_api_key_enc",
  "mail_password_enc",
  "imonnit_key_id_enc",
  "imonnit_secret_enc",
  "pharmacy_dea",
  "pharmacy_npi",
  "pharmacy_ncpdp",
  "pharmacy_phone",
  "psao_member_id",
  "public_base_url",
  "mail_user",
  "mail_host",
  "backup_destination",
  "backup_destination_2",
];

export type ScrubReport = {
  /** Table by table, what was changed and how many rows. */
  changed: { what: string; rows: number }[];
  prescriptions: number;
  /** Every table and row count in the finished copy, so what is being sent is knowable. */
  tables: Record<string, number>;
  rows: number;
};

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function columnsOf(db: Client, table: string): Promise<Set<string>> {
  const r = await db.execute(`pragma table_info(${table})`);
  return new Set(r.rows.map((x) => String(x.name)));
}

/**
 * What to put in a column being emptied: null where the schema allows one, an empty string where
 * it does not.
 *
 * A NOT NULL column refuses a null and takes the whole export down with it — which it did, on the
 * incident log's description. Emptying is the intent either way; the schema decides how it is
 * spelled.
 */
async function emptyValues(db: Client, table: string, columns: string[]): Promise<string> {
  const info = await db.execute(`pragma table_info(${table})`);
  const notNull = new Set(info.rows.filter((c) => Number(c.notnull) === 1).map((c) => String(c.name)));
  return columns.map((c) => `${c} = ${notNull.has(c) ? "''" : "null"}`).join(", ");
}

async function tablesOf(db: Client): Promise<string[]> {
  const r = await db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name");
  return r.rows.map((x) => String(x.name));
}

/**
 * Replaces every prescription number with a stand-in, consistently within this copy.
 *
 * The salt is made fresh here and never written down, so the mapping dies with this function: the
 * copy cannot be matched against the pharmacy's own records, or against any other copy, even by
 * whoever made it.
 */
async function standInPrescriptions(db: Client, salt: string): Promise<number> {
  const holders: { table: string; column: string }[] = [
    { table: "claims", column: "rx_number" },
    { table: "claim_payments", column: "rx_number" },
    { table: "appeals", column: "rx_number" },
  ];
  const map = new Map<string, string>();
  const standIn = (real: string) => {
    const held = map.get(real);
    if (held) return held;
    const made = `RX${crypto.createHash("sha256").update(salt + real).digest("hex").slice(0, 10).toUpperCase()}`;
    map.set(real, made);
    return made;
  };

  /*
   * The replacement is a join, not ten thousand statements.
   *
   * Written as one UPDATE per distinct prescription it is a full scan of the claims table each
   * time: at this pharmacy's size that measured 1.9 ms each and nineteen seconds for ten thousand,
   * on top of the copy and the proof — and a browser waiting on a form does not last that long. It
   * showed as a button that does nothing, which is exactly what it was.
   *
   * So the whole mapping goes into a table of its own with an index on it, and each holder is
   * rewritten in a single statement.
   */
  const present = new Set(await tablesOf(db));
  const wanted: { table: string; column: string }[] = [];
  const distinct = new Set<string>();
  for (const h of holders) {
    if (!present.has(h.table)) continue;
    if (!(await columnsOf(db, h.table)).has(h.column)) continue;
    wanted.push(h);
    const rows = await db.execute(`select distinct ${h.column} as v from ${h.table} where ${h.column} is not null and ${h.column} <> ''`);
    for (const r of rows.rows) distinct.add(String(r.v));
  }
  if (wanted.length === 0 || distinct.size === 0) return 0;

  await db.execute("drop table if exists _rx_map");
  await db.execute("create table _rx_map (old text primary key, new text not null)");
  const values = [...distinct].map((real) => `(${q(real)}, ${q(standIn(real))})`);
  for (let i = 0; i < values.length; i += 500) await db.execute(`insert into _rx_map (old, new) values ${values.slice(i, i + 500).join(",")}`);

  for (const h of wanted) {
    await db.execute(
      `update ${h.table} set ${h.column} = (select new from _rx_map where old = ${h.table}.${h.column}) ` +
        `where ${h.column} in (select old from _rx_map)`,
    );
  }
  // The mapping is the one thing that must never travel: it is the key to everything above.
  await db.execute("drop table _rx_map");
  return map.size;
}

/** Runs every rule above against an already-copied database, in place. */
export async function scrubCopy(dbFile: string, onStep: (s: string) => void | Promise<void> = () => {}): Promise<ScrubReport> {
  const db = createClient({ url: `file:${dbFile}` });
  const changed: { what: string; rows: number }[] = [];
  try {
    const present = new Set(await tablesOf(db));
    const count = async (t: string) => Number((await db.execute(`select count(*) as n from ${t}`)).rows[0].n);

    await onStep("Replacing prescription numbers");
    const salt = crypto.randomBytes(32).toString("hex");
    const prescriptions = await standInPrescriptions(db, salt);
    if (prescriptions > 0) changed.push({ what: "prescription numbers replaced with stand-ins", rows: prescriptions });

    await onStep("Emptying free text, secrets and names");
    for (const [table, columns] of Object.entries(BLANKED_TEXT)) {
      if (!present.has(table)) continue;
      const have = await columnsOf(db, table);
      const use = columns.filter((c) => have.has(c));
      if (use.length === 0) continue;
      const n = await count(table);
      await db.execute(`update ${table} set ${await emptyValues(db, table, use)}`);
      if (n > 0) changed.push({ what: `${table}: ${use.length} free-text columns emptied`, rows: n });
    }

    for (const e of EMPTIED) {
      if (!present.has(e.table)) continue;
      const have = await columnsOf(db, e.table);
      const use = e.columns.filter((c) => have.has(c));
      if (use.length === 0) continue;
      const n = await count(e.table);
      await db.execute(`update ${e.table} set ${await emptyValues(db, e.table, use)}`);
      if (n > 0) changed.push({ what: `${e.table}: ${use.join(", ")} emptied`, rows: n });
    }

    /*
     * Staff are named on the compliance side of the site and are people too. The record keeps its
     * shape — who did what training, whose licence expires when — under a stand-in name.
     */
    if (present.has("people")) {
      const rows = await db.execute("select id from people order by id");
      let i = 0;
      for (const r of rows.rows) {
        i++;
        await db.execute(`update people set first_name = ${q("Staff")}, last_name = ${q(String(i))}, ${await emptyValues(db, "people", ["email"])} where id = ${q(String(r.id))}`);
      }
      if (i > 0) changed.push({ what: "staff names replaced", rows: i });
    }
    if (present.has("users")) {
      const rows = await db.execute("select id from users order by id");
      let i = 0;
      for (const r of rows.rows) {
        i++;
        await db.execute(`update users set name = ${q(`User ${i}`)}, username = ${q(`user${i}`)} where id = ${q(String(r.id))}`);
      }
      if (i > 0) changed.push({ what: "logins renamed and their passwords emptied", rows: i });
    }

    /*
     * Email addresses are how the mailbox decides which supplier a report came from, so the domain
     * is the part that matters and the person's name is the part that does not.
     */
    for (const t of [
      { table: "suppliers", column: "sender_emails" },
      { table: "vendors", column: "sender_emails" },
      { table: "inbox_items", column: "from_address" },
    ]) {
      if (!present.has(t.table) || !(await columnsOf(db, t.table)).has(t.column)) continue;
      const rows = await db.execute(`select rowid as rid, ${t.column} as v from ${t.table} where ${t.column} is not null and ${t.column} <> ''`);
      for (const r of rows.rows) {
        // Left as a domain and not as an address: the mailbox rules match on the domain, and what
        // remains is no longer an email address, so the proof below has nothing to object to.
        const masked = String(r.v).replace(/[^\s,;<>]+@([^\s,;<>]+)/g, "[someone at $1]");
        await db.execute(`update ${t.table} set ${t.column} = ${q(masked)} where rowid = ${String(r.rid)}`);
      }
      if (rows.rows.length > 0) changed.push({ what: `${t.table}.${t.column}: the name before the @ removed`, rows: rows.rows.length });
    }

    if (present.has("settings")) {
      for (const k of EMPTIED_SETTINGS) await db.execute(`update settings set value = '' where key = ${q(k)}`);
      changed.push({ what: `settings: ${EMPTIED_SETTINGS.length} secrets and registration numbers emptied`, rows: EMPTIED_SETTINGS.length });
      /*
       * And any setting still carrying an address, whatever it happens to be called.
       *
       * The named list cannot know about a log line. "sent to <the owner's address>: the pharmacy,
       * 14 things late" is written into the digest's own result by the code that sends it, and no
       * list of key names would ever have caught it.
       */
      const left = await db.execute("select key, value from settings where value is not null and value <> ''");
      const address = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
      for (const r of left.rows) {
        const v = String(r.value);
        if (address.test(v)) {
          address.lastIndex = 0;
          await db.execute(`update settings set value = ${q(v.replace(address, "[an address]"))} where key = ${q(String(r.key))}`);
        }
        address.lastIndex = 0;
      }
    }

    /*
     * NADAC's back catalogue is left behind, and only the newest week travels.
     *
     * It is 1.46 million rows and 133 MB of the copy — a third of it — and it is public federal
     * data that anybody can download from CMS in a minute. Every figure the site draws from it
     * comes from the latest effective date; the history is there for the price-movement chart and
     * nothing else. Trimming it is the difference between a copy that can be sent and one that
     * cannot, which is the only reason a copy exists.
     */
    await onStep("Trimming the reference tables");
    if (present.has("nadac_prices")) {
      /*
       * The newest price for each drug, not the newest week.
       *
       * Trimming to max(effective_on) across the table kept five rows: CMS restates a handful of
       * drugs after the weekly file goes out, so the very newest date holds those corrections and
       * nothing else. What the site actually reads is the newest row per NDC — see nadacNow — so
       * that is exactly what is kept, and every benchmark comparison in the copy answers what it
       * answers on the pharmacy's own machine.
       */
      const before = await count("nadac_prices");
      await db.execute(
        "delete from nadac_prices where id not in (" +
          "select id from nadac_prices p where p.effective_on = (select max(q.effective_on) from nadac_prices q where q.ndc11 = p.ndc11)" +
          ")",
      );
      const after = await count("nadac_prices");
      changed.push({ what: `NADAC history dropped; the newest price for each drug kept (${after.toLocaleString()} prices)`, rows: before - after });
    }

    // Sessions are live credentials; a copy has no business carrying any.
    for (const t of ["sessions", "magic_links", "training_tokens"]) {
      if (!present.has(t)) continue;
      const n = await count(t);
      await db.execute(`delete from ${t}`);
      if (n > 0) changed.push({ what: `${t} emptied`, rows: n });
    }

    /*
     * The catalogue's identifiers are entropy, and entropy is the reason the file will not fit.
     *
     * "im trying to send you backup file but its says it too big". 147,730 catalogue rows each
     * carry a random UUID of their own and another for the import they arrived in: ten megabytes of
     * pure randomness in a thirty-four megabyte payload, and randomness is exactly what a
     * compressor cannot do anything with. The timestamps are another three.
     *
     * None of it is a fact about a drug. The row's identity only has to be unique, the import's
     * only has to group rows that came in together, and a price file is dated by the day rather
     * than the millisecond. Nothing outside this table refers to either id, so they are renumbered
     * — and the file becomes something that can actually be sent, which is the only thing standing
     * between a fault and its diagnosis.
     */
    if (present.has("supplier_items")) {
      const before = await count("supplier_items");
      // Column by column, because this is a saving rather than a requirement: a schema that has
      // moved on should cost the copy some size, never the copy itself.
      const have = await columnsOf(db, "supplier_items");
      if (before > 0) {
        if (have.has("updated_at")) await db.execute("update supplier_items set updated_at = substr(updated_at, 1, 10)");
        /*
         * The row already has a unique integer — SQLite gave it one — so the id is just that.
         *
         * The first attempt counted the rows before each row to number them, which is a hundred and
         * forty-seven thousand squared comparisons and does not finish. `rowid` is the answer that
         * was already there.
         */
        if (have.has("id")) await db.execute("update supplier_items set id = cast(rowid as text)");
        /*
         * And the import id becomes a short code per import — seventy-odd of them, so seventy-odd
         * statements rather than one that walks the table for every row.
         */
        if (have.has("import_id")) {
          const imports = await db.execute("select distinct import_id as v from supplier_items where import_id is not null order by import_id");
          let n = 0;
          for (const row of imports.rows) {
            n++;
            await db.execute(`update supplier_items set import_id = ${q(`i${n}`)} where import_id = ${q(String(row.v))}`);
          }
        }
        changed.push({ what: "catalogue row and import identifiers renumbered, and price dates shortened to the day", rows: before });
      }
    }

    /*
     * The FDA directory, cut to the drugs this pharmacy actually touches.
     *
     * It is a quarter of a million packages — every drug marketed in the United States — and it
     * would be the largest thing in the copy by some way. But an equivalent nobody sells is not an
     * option, and a package nobody stocks has no pack size to argue about, so the rows worth
     * carrying are the ones some supplier prices, the shelf holds, or a claim has dispensed.
     *
     * The verbose columns go with them. `substances` and `te_why` are long, highly repetitive, and
     * say nothing the equivalence key and the rating do not: the key already encodes the
     * ingredients, and the reason a product has no rating is recomputable from the application.
     * What stays is what the pack-size and equivalence work reads.
     */
    if (present.has("drug_directory")) {
      const before = await count("drug_directory");
      if (before > 0) {
        const referenced = ["supplier_items", "on_hand", "claims"].filter((t) => present.has(t));
        if (referenced.length > 0) {
          const union = referenced.map((t) => `select ndc11 from ${t}`).join(" union ");
          await db.execute(`delete from drug_directory where ndc11 not in (${union})`);
        }
        const have = await columnsOf(db, "drug_directory");
        const drop = ["substances", "te_why", "product_ndc", "application", "marketing_category", "brand_name", "route"].filter((c) => have.has(c));
        if (drop.length > 0) await db.execute(`update drug_directory set ${await emptyValues(db, "drug_directory", drop)}`);
        if (have.has("loaded_at")) await db.execute("update drug_directory set loaded_at = substr(loaded_at, 1, 10)");
        const after = await count("drug_directory");
        changed.push({
          what: `FDA directory cut to the ${after.toLocaleString()} packages this pharmacy prices, stocks or has dispensed, and its long descriptive columns dropped`,
          rows: before - after,
        });
      }
    }

    /*
     * And the space the deletions freed is given back, or none of this makes the file smaller.
     *
     * SQLite keeps emptied pages for reuse rather than shrinking the file, so dropping 1.4 million
     * NADAC rows made the copy *larger* — the pages stayed and the write-ahead log grew on top.
     * A vacuum is what actually reclaims them.
     */
    await onStep("Reclaiming the space that freed");
    await db.execute("VACUUM");

    const tables: Record<string, number> = {};
    let rows = 0;
    for (const t of await tablesOf(db)) {
      const n = await count(t);
      tables[t] = n;
      rows += n;
    }
    return { changed, prescriptions, tables, rows };
  } finally {
    db.close();
  }
}

/**
 * Columns that hold a company's published contact point, not a person's.
 *
 * A PBM's help desk, a MAC appeal's submission address, the line in a contract saying which mailbox
 * to write to. These are printed in the agreements and on the payer's own website, and they are
 * exactly what the appeal and routing logic is built on: taking them out would make that logic
 * impossible to check while protecting nobody.
 *
 * Named one at a time, deliberately. A blanket rule for "anything that looks like a business
 * address" would grow to cover things it should not.
 */
const BUSINESS_CONTACT = new Set([
  "payer_bins.help_desk",
  "payer_bins.mac_contact",
  "mac_appeal_terms.submission_target",
  "mac_appeal_terms.escalation_contact",
  "mac_appeal_terms.notes",
  "network_rates.notes",
  "network_rates.brand_rate",
  "network_rates.generic_rate",
  "pbm_contacts.notes",
  "suppliers.sender_emails",
  "vendors.sender_emails",
  "inbox_items.from_address",
]);

export type PrivacyProof = { ok: true; checked: number } | { ok: false; found: { table: string; column: string; example: string }[] };

/**
 * Reads the finished copy back and refuses it if anything still looks like an identifier.
 *
 * This is the part that makes the rest worth anything. The rules above are a list somebody wrote,
 * and a list is only as good as its author's memory of the schema; a column added next month is a
 * column the list does not know about. So the copy is searched rather than trusted — every text
 * value in every table, against the shapes an identifier takes — and one hit stops the export.
 */
export async function provePrivate(dbFile: string): Promise<PrivacyProof> {
  const db = createClient({ url: `file:${dbFile}` });
  const found: { table: string; column: string; example: string }[] = [];
  let checked = 0;
  try {
    /*
     * Tight enough not to cry wolf, because a check that cries wolf gets turned off.
     *
     * The first draft called "OYSCO 500+D TB 500-200 1000" a telephone number and "BAXT FOIL SEAL
     * TMPIN H93830020" a DEA registration — both of them drug descriptions out of a wholesaler's
     * price file, and 147,725 rows of the same shape behind them. A telephone number now needs a
     * consistent separator or brackets. The DEA pattern is gone: a registration is not patient
     * data, and the one place the pharmacy's own appears — the front of the manual — is emptied
     * above. "Date of birth" as a phrase is gone with it; it was matching the policy that tells
     * staff to check one.
     */
    const patterns: { why: string; re: RegExp }[] = [
      { why: "an email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
      { why: "a social security number", re: /\b\d{3}-\d{2}-\d{4}\b/ },
      { why: "a US phone number", re: /(?:\b\d{3}-\d{3}-\d{4}\b|\b\d{3}\.\d{3}\.\d{4}\b|\(\d{3}\)\s?\d{3}[-.]\d{4})/ },
    ];

    for (const t of await tablesOf(db)) {
      const info = await db.execute(`pragma table_info(${t})`);
      const textCols = info.rows.filter((c) => /TEXT|CHAR|CLOB|BLOB|^$/i.test(String(c.type ?? ""))).map((c) => String(c.name));
      if (textCols.length === 0) continue;
      const rows = await db.execute(`select ${textCols.map((c) => `"${c}"`).join(", ")} from ${t}`);
      for (const r of rows.rows) {
        for (const c of textCols) {
          const v = r[c];
          if (typeof v !== "string" || v.length === 0) continue;
          checked++;
          if (BUSINESS_CONTACT.has(`${t}.${c}`)) continue;
          /*
           * A prescription number that still looks like one. The stand-ins are RX + ten hex
           * characters; a real one out of PioneerRx is digits, so a bare run of six to nine digits
           * in a column named for prescriptions is the thing to catch.
           */
          if (/rx_?number/i.test(c) && !/^RX[0-9A-F]{10}$/.test(v)) {
            found.push({ table: t, column: c, example: "a prescription number that was not replaced" });
            continue;
          }
          for (const p of patterns) {
            if (p.re.test(v)) {
              found.push({ table: t, column: c, example: p.why });
              break;
            }
          }
        }
      }
    }
  } finally {
    db.close();
  }
  // One line per place, however many rows carried it: a list of five thousand is not a report.
  const unique = [...new Map(found.map((f) => [`${f.table}.${f.column}|${f.example}`, f])).values()];
  return unique.length === 0 ? { ok: true, checked } : { ok: false, found: unique };
}

/* ── Making the copy ── */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createZip } from "./zip";
import { sha256 } from "./crypto";

const dbPath = () => path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db");

/**
 * Removing the working file, on an operating system that may refuse.
 *
 * Windows will not unlink a file any process still holds open, and SQLite does not always let go
 * the instant `close()` returns — the journal and shared-memory files beside it lag behind. The
 * pharmacy hit exactly this: the copy was built, proved and written, and then the tidy-up threw
 * `EBUSY: resource busy or locked` and turned a finished job into a failed one.
 *
 * A working file that outlives its job is a nuisance; a finished copy thrown away because the
 * nuisance could not be tidied is a bug. So this tries, waits, tries again, and then gives up
 * quietly — the file is in the operating system's own temporary folder, which is cleaned for us.
 */
export async function removeWorkingFile(file: string, remove: (f: string) => Promise<void> = (f) => fs.rm(f, { force: true }), wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await remove(f);
        break;
      } catch {
        await wait(200 * (attempt + 1));
      }
    }
  }
}

export type ClaudeCopy =
  | { ok: true; fileName: string; bytes: number; report: ScrubReport; checked: number }
  | { ok: false; why: string; found?: { table: string; column: string; example: string }[] };

/**
 * Builds the copy and hands back the bytes, or refuses and says what it found.
 *
 * The order matters and is the whole design: snapshot, scrub, prove, and only then write anything
 * a person could send. Nothing that failed the proof is ever turned into a file, so there is no
 * moment at which an unscrubbed copy exists anywhere it could be picked up by mistake.
 */
export async function buildClaudeCopy(onStep: (s: string) => void | Promise<void> = () => {}): Promise<ClaudeCopy & { data?: Buffer }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tmp = path.join(os.tmpdir(), `pa-for-claude-${stamp}.db`);
  await removeWorkingFile(tmp);

  await onStep("Taking a copy of the database");
  const live = createClient({ url: `file:${dbPath()}` });
  try {
    // SQLite's own consistent snapshot, so a copy taken mid-import is still a coherent database.
    await live.execute(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }

  try {
    const report = await scrubCopy(tmp, onStep);
    await onStep("Checking every value in the result for anything identifying");
    const proof = await provePrivate(tmp);
    if (!proof.ok) {
      await removeWorkingFile(tmp);
      return {
        ok: false,
        why:
          `The copy was not written. After scrubbing, ${proof.found.length} place${proof.found.length === 1 ? "" : "s"} still held something that looks like an identifier, ` +
          `so nothing was produced. This is the check doing its job: it means the site has grown a column the scrubber does not know about.`,
        found: proof.found,
      };
    }

    await onStep("Compressing");
    const scrubbed = await fs.readFile(tmp);
    const manifest = {
      takenAt: new Date().toISOString(),
      application: "Pharmacy Admin Desk",
      copy: "Scrubbed copy for debugging. Not a backup — it cannot restore this pharmacy.",
      databaseSha256: sha256(scrubbed),
      documents: 0,
      removed: report.changed,
      prescriptionsReplaced: report.prescriptions,
      valuesChecked: proof.checked,
      tables: Object.keys(report.tables).length,
      rows: report.rows,
      counts: report.tables,
    };
    const readme =
      "A COPY FOR DEBUGGING — NOT A BACKUP\n" +
      "===================================\n\n" +
      "This is the pharmacy's database with every identifier taken out. It cannot be used to\n" +
      "restore the pharmacy: the documents are not in it, the passwords are emptied, and the\n" +
      "prescription numbers have been replaced with stand-ins that mean nothing outside this file.\n\n" +
      "What was taken out:\n" +
      report.changed.map((c) => `  - ${c.what} (${c.rows.toLocaleString()} rows)\n`).join("") +
      "\nEvery text value in the finished copy — " +
      manifest.valuesChecked.toLocaleString() +
      " of them — was then read back and searched for\n" +
      "email addresses, telephone numbers, social security numbers, dates of birth, DEA numbers\n" +
      "and unreplaced prescription numbers. None were found. Had any been, this file would not\n" +
      "have been written at all.\n\n" +
      "The real backup is a different thing and is taken separately: Settings, Backups.\n";

    /*
     * Squeezed as hard as deflate goes, because this file has to fit through a chat window.
     *
     * The backups use the default because they are written every night and speed matters there;
     * this is made by hand, once, and a few extra seconds is nothing against being told the file
     * is too big to send.
     */
    const archive = createZip(
      [
        { name: "pharmacy-admin.db", data: scrubbed },
        { name: "MANIFEST.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
        { name: "READ-ME-FIRST.txt", data: Buffer.from(readme) },
      ],
      new Date(),
      9,
    );

    return {
      ok: true,
      fileName: `pharmacy-copy-for-claude-${stamp}.zip`,
      bytes: archive.length,
      report,
      checked: proof.checked,
      data: archive,
    };
  } finally {
    await removeWorkingFile(tmp);
  }
}

/**
 * Makes the copy and writes it beside the backups, rather than only down a browser connection.
 *
 * A download link that takes two minutes and shows nothing is a broken button: the pharmacist
 * pressed it, watched nothing happen, and said so. On a database this size the work is a minute or
 * two — a snapshot, a scrub, and 1.7 million values read back — and a browser gives no sign of any
 * of it.
 *
 * So the press starts the work, the page says where it got to, and the finished file lands in the
 * folder the backups already go to. That folder is usually OneDrive, which means the copy is
 * somewhere it can be attached from without a download having to succeed at all.
 */
export async function writeClaudeCopy(destination: string, onStep: (s: string) => void | Promise<void> = () => {}): Promise<{ ok: true; path: string; bytes: number; report: ScrubReport; checked: number } | { ok: false; why: string; found?: { table: string; column: string; example: string }[] }> {
  const built = await buildClaudeCopy(onStep);
  if (!built.ok) return built;
  await onStep("Writing the file");
  const dir = path.resolve(destination);
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, built.fileName);
  await fs.writeFile(out, built.data!);

  /*
   * Read back what was actually written, not the buffer still in memory — which would prove
   * nothing about the file on the disk, and the disk is the thing that fills up.
   */
  const onDisk = await fs.stat(out);
  if (onDisk.size !== built.bytes) {
    await fs.rm(out, { force: true });
    return { ok: false, why: `The copy was ${built.bytes.toLocaleString()} bytes but only ${onDisk.size.toLocaleString()} reached ${dir}. It has been removed rather than left half-written. Check the folder has room.` };
  }
  return { ok: true, path: out, bytes: built.bytes, report: built.report, checked: built.checked };
}

/** The copies already made, newest first, so the page can offer one without building another. */
export async function existingClaudeCopies(destination: string): Promise<{ name: string; bytes: number; madeAt: string }[]> {
  try {
    const dir = path.resolve(destination);
    const names = (await fs.readdir(dir)).filter((n) => /^pharmacy-copy-for-claude-.*\.zip$/.test(n));
    const out = [];
    for (const name of names) {
      const s = await fs.stat(path.join(dir, name));
      out.push({ name, bytes: s.size, madeAt: s.mtime.toISOString() });
    }
    return out.sort((a, b) => b.madeAt.localeCompare(a.madeAt));
  } catch {
    return [];
  }
}
