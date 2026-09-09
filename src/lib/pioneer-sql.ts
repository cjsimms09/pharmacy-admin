import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import sql from "mssql";
import { getSettings, setSetting } from "./settings";
import { readSecret } from "./connections";

/**
 * PioneerRx's own database, read directly.
 *
 * The owner, 7 September: "I am in the process of trying to get info from PioneerRx via SQL
 * request. This should allow us to get much better info and more efficiently about our claims and
 * catalogs." On 8 September he had the instance name, the database name, a user and a password.
 *
 * What this file promises:
 *
 *  - It only ever reads. The pool is opened with read-only intent, every batch is run at READ
 *    UNCOMMITTED so a report here can never hold a lock that a technician at the counter waits
 *    on, and `query` refuses any statement that is not a single SELECT.
 *  - Nothing from it is written by this file. Feeds that store what they read (claims, the drug
 *    file, on-hand) live beside the readers they replace and prove themselves the same way.
 *  - The password is in the settings table encrypted with APP_ENCRYPTION_KEY, like every other
 *    credential (connections.ts), and never leaves the server.
 *
 * The table names are not known in advance. PioneerRx does not publish its schema, so the first
 * thing the connection does is read INFORMATION_SCHEMA — table and column names, types, and the
 * row count the engine keeps per table — into data/pioneer-schema.json. Names and counts, never a
 * value from any row: that file is safe to read on the cloud side, and it is what every query
 * after it is written against.
 */

export const SCHEMA_FILE = path.join(process.cwd(), "data", "pioneer-schema.json");

export type PioneerConfig = { server: string; instance: string | null; port: number | null; database: string; user: string; password: string };

/** "HOST\INSTANCE", "HOST,1433" or "HOST" as the owner was given it. */
export function parseServer(text: string): { server: string; instance: string | null; port: number | null } {
  const t = text.trim();
  const inst = /^([^\\,]+)\\([^,]+)$/.exec(t);
  if (inst) return { server: inst[1].trim(), instance: inst[2].trim(), port: null };
  const port = /^([^\\,]+),\s*(\d+)$/.exec(t);
  if (port) return { server: port[1].trim(), instance: null, port: Number(port[2]) };
  return { server: t, instance: null, port: null };
}

export async function pioneerConfig(): Promise<PioneerConfig | { missing: string[] }> {
  const s = await getSettings();
  const password = await readSecret("pioneerrx");
  const missing: string[] = [];
  if (!s.pioneer_sql_server) missing.push("the server or instance name");
  if (!s.pioneer_sql_database) missing.push("the database name");
  if (!s.pioneer_sql_user) missing.push("the user name");
  if (!password) missing.push("the password");
  if (missing.length) return { missing };
  const { server, instance, port } = parseServer(s.pioneer_sql_server);
  return { server, instance, port, database: s.pioneer_sql_database.trim(), user: s.pioneer_sql_user.trim(), password: password! };
}

function poolConfig(c: PioneerConfig, encrypt: boolean): sql.config {
  return {
    server: c.server,
    port: c.port ?? undefined,
    database: c.database,
    user: c.user,
    password: c.password,
    connectionTimeout: 15_000,
    requestTimeout: 180_000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      instanceName: c.instance ?? undefined,
      encrypt,
      trustServerCertificate: true,
      readOnlyIntent: true,
      appName: "pharmacy-admin (read only)",
      useUTC: false,
    },
  };
}

/**
 * Opens a pool, runs the work, closes it. A pool per call rather than one kept open: the site
 * reads PioneerRx a few times a day, and an idle pool is a login held on somebody else's server.
 *
 * TLS first. An older SQL Server that cannot complete a modern handshake fails at the socket
 * with a self-explanatory error, and the connection is tried again in the clear; which way it
 * went is recorded so the settings page can say so.
 */
export async function withPioneer<T>(fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<{ result: T; encrypted: boolean }> {
  const c = await pioneerConfig();
  if ("missing" in c) throw new Error(`PioneerRx is not set up yet: ${c.missing.join(", ")} — Settings → Connections → PioneerRx database.`);
  let pool: sql.ConnectionPool | null = null;
  let encrypted = true;
  try {
    try {
      pool = await new sql.ConnectionPool(poolConfig(c, true)).connect();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/TLS|SSL|handshake|ECONNRESET|socket hang up|EPROTO/i.test(msg)) throw e;
      encrypted = false;
      pool = await new sql.ConnectionPool(poolConfig(c, false)).connect();
    }
    const result = await fn(pool);
    return { result, encrypted };
  } finally {
    await pool?.close().catch(() => undefined);
  }
}

/**
 * Columns this site will not read, whatever anybody types.
 *
 * PioneerRx's `Prescription.Transmission` carries the whole payer chain — BIN, PCN, group, plan and
 * the network reimbursement id, which is the key to matching a claim to its contract — and in the
 * same row it carries the patient's name, address, social security number, date of birth, driving
 * licence and passport number, plus the raw EDI of the claim in `SentEdi`, `ReceivedEdi` and
 * `SuperString`. The useful columns and the forbidden ones are neighbours.
 *
 * The pharmacy has no business associate agreement covering this session, so the rule is not a
 * preference to be remembered while writing a query. It is enforced here, once, on every query the
 * site or a person sends: name a column on this list and nothing runs. `select *` is refused for
 * the same reason — on a 194-column claims table it is a request for whatever happens to be there.
 */
const FORBIDDEN = [
  "patientfirstname", "patientlastname", "patientmiddlename", "patientstreetaddress", "patientcity",
  "patientstatecode", "patientzipcode", "patientphone", "patientssn", "patientdateofbirth",
  "patientemailaddress", "patientdriverslicensenumber", "patientstateissueidnumber",
  "patientmilitaryidnumber", "patientpassportidnumber", "cardholderid", "sentedi", "receivededi",
  "superstring", "ownername", "firstname", "lastname", "middlename", "dateofbirth", "socialsecurity",
  "ssn", "streetaddress", "emailaddress", "homephone", "cellphone",
];

/** True for one plain SELECT (or a CTE), which is the only thing this site will send. */
export function isReadOnlySelect(text: string): { ok: true } | { ok: false; why: string } {
  const t = text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/;\s*$/, "");
  if (!t) return { ok: false, why: "there is no statement" };
  if (/;/.test(t)) return { ok: false, why: "one statement at a time" };
  if (!/^(select|with)\b/i.test(t)) return { ok: false, why: "only SELECT is allowed" };
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|backup|restore|shutdown|into|openrowset|openquery|xp_|sp_)\b/i.test(t)) return { ok: false, why: "a word that is not a read is in it" };
  // Every column named, or nothing runs. See FORBIDDEN.
  if (/(^|[\s,(])\*|\.\*/.test(t.replace(/count\s*\(\s*\*\s*\)/gi, "count(1)"))) {
    return { ok: false, why: "select * is not allowed on this database — name the columns, so that a patient column cannot arrive by accident" };
  }
  const named = FORBIDDEN.find((c) => new RegExp(`\\b${c}\\b`, "i").test(t));
  if (named) return { ok: false, why: `the column "${named}" is patient information and this site does not read it` };
  return { ok: true };
}

export type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; tookMs: number; encrypted: boolean };

/** Runs one SELECT, at READ UNCOMMITTED, with a row cap so a mistyped join cannot pull the store. */
export async function query(text: string, params: Record<string, string | number | null> = {}, maxRows = 50_000): Promise<QueryResult> {
  const check = isReadOnlySelect(text);
  if (!check.ok) throw new Error(`Refused: ${check.why}.`);
  const started = Date.now();
  const { result, encrypted } = await withPioneer(async (pool) => {
    const req = pool.request();
    for (const [k, v] of Object.entries(params)) req.input(k, v);
    const r = await req.query(`SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n${text}`);
    const set = r.recordset ?? [];
    return { columns: set.columns ? Object.keys(set.columns) : Object.keys(set[0] ?? {}), rows: set.slice(0, maxRows) as Record<string, unknown>[] };
  });
  return { ...result, tookMs: Date.now() - started, encrypted };
}

export type SchemaTable = { schema: string; name: string; rows: number | null; columns: { name: string; type: string; nullable: boolean; maxLength: number | null }[] };
export type PioneerSchema = { readAt: string; server: string; database: string; version: string; tables: SchemaTable[] };

/** Table and column names, types, and the row count the engine keeps. No value from any row. */
export async function discoverSchema(): Promise<{ tables: number; columns: number; tookMs: number; encrypted: boolean }> {
  const started = Date.now();
  const s = await getSettings();
  const { result, encrypted } = await withPioneer(async (pool) => {
    const version = (await pool.request().query("select @@version as v")).recordset[0]?.v as string;
    const cols = (await pool.request().query(
      `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
       select c.TABLE_SCHEMA s, c.TABLE_NAME t, c.COLUMN_NAME n, c.DATA_TYPE ty, c.IS_NULLABLE nu, c.CHARACTER_MAXIMUM_LENGTH ml, c.ORDINAL_POSITION o
       from INFORMATION_SCHEMA.COLUMNS c join INFORMATION_SCHEMA.TABLES t on t.TABLE_SCHEMA = c.TABLE_SCHEMA and t.TABLE_NAME = c.TABLE_NAME
       where t.TABLE_TYPE = 'BASE TABLE' order by c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
    )).recordset as { s: string; t: string; n: string; ty: string; nu: string; ml: number | null }[];
    let counts = new Map<string, number>();
    try {
      const rows = (await pool.request().query(
        `select sc.name s, t.name t, sum(p.rows) r from sys.tables t join sys.schemas sc on sc.schema_id = t.schema_id join sys.partitions p on p.object_id = t.object_id and p.index_id in (0, 1) group by sc.name, t.name`,
      )).recordset as { s: string; t: string; r: number }[];
      counts = new Map(rows.map((r) => [`${r.s}.${r.t}`, Number(r.r)]));
    } catch {
      // sys.partitions needs VIEW DEFINITION; without it the counts are simply unknown.
    }
    const tables = new Map<string, SchemaTable>();
    for (const c of cols) {
      const key = `${c.s}.${c.t}`;
      const t = tables.get(key) ?? { schema: c.s, name: c.t, rows: counts.get(key) ?? null, columns: [] };
      tables.set(key, t);
      t.columns.push({ name: c.n, type: c.ty, nullable: c.nu === "YES", maxLength: c.ml });
    }
    return { version: (version ?? "").split("\n")[0].trim(), tables: [...tables.values()] };
  });
  const out: PioneerSchema = { readAt: new Date().toISOString(), server: s.pioneer_sql_server, database: s.pioneer_sql_database, version: result.version, tables: result.tables };
  await fs.mkdir(path.dirname(SCHEMA_FILE), { recursive: true });
  await fs.writeFile(SCHEMA_FILE, JSON.stringify(out, null, 1));
  await setSetting("pioneer_sql_schema_at", out.readAt);
  await setSetting("pioneer_sql_tables", String(out.tables.length));
  return { tables: out.tables.length, columns: out.tables.reduce((n, t) => n + t.columns.length, 0), tookMs: Date.now() - started, encrypted };
}

export async function storedSchema(): Promise<PioneerSchema | null> {
  try {
    return JSON.parse(await fs.readFile(SCHEMA_FILE, "utf8")) as PioneerSchema;
  } catch {
    return null;
  }
}

/** Connects, asks the server who it is, records the answer either way. */
export async function testConnection(): Promise<{ ok: true; version: string; tables: number; tookMs: number; encrypted: boolean } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    const { result, encrypted } = await withPioneer(async (pool) => {
      const v = (await pool.request().query("select @@version as v")).recordset[0]?.v as string;
      const n = (await pool.request().query("select count(*) as n from INFORMATION_SCHEMA.TABLES where TABLE_TYPE = 'BASE TABLE'")).recordset[0]?.n as number;
      return { version: (v ?? "").split("\n")[0].trim(), tables: Number(n) };
    });
    const r = { ok: true as const, ...result, tookMs: Date.now() - started, encrypted };
    await setSetting("pioneer_sql_last_test", new Date().toISOString());
    await setSetting("pioneer_sql_last_result", `ok: ${r.tables} tables, ${r.version}${encrypted ? "" : " (connection not encrypted: the server could not complete a TLS handshake)"}`);
    return r;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setSetting("pioneer_sql_last_test", new Date().toISOString());
    await setSetting("pioneer_sql_last_result", `failed: ${error}`);
    return { ok: false, error };
  }
}
