import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { pioneerConfig, testConnection, discoverSchema, storedSchema, query, isReadOnlySelect } from "@/lib/pioneer-sql";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Notice, BackLink, Empty } from "@/components/ui";

export const metadata = { title: "PioneerRx database" };
export const dynamic = "force-dynamic";

/**
 * PioneerRx, read directly.
 *
 * Three things happen here and nothing else: the connection is tested, the table names are read
 * into a file, and one SELECT at a time can be run to see what a table holds. Every report the
 * site will pull from PioneerRx is written against the names this page reads, so the names come
 * first. What comes back from a query is shown on this page and stored nowhere: this is a window,
 * not a feed. The feeds that store are written one at a time beside the reader each replaces.
 */

export default async function PioneerSqlPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; q?: string; sql?: string }> }) {
  await requireManager();
  const { done, error, q, sql: sqlText } = await searchParams;
  const s = await getSettings();
  const config = await pioneerConfig();
  const schema = await storedSchema();

  async function test() {
    "use server";
    const u = await requireManager();
    const r = await testConnection();
    await audit({ action: "pioneer-sql.test", userId: u.id, userName: u.name, details: r.ok ? `ok, ${r.tables} tables in ${r.tookMs}ms` : `failed: ${r.error.slice(0, 200)}` });
    revalidatePath("/tools/pioneer-sql");
    redirect("/tools/pioneer-sql?" + (r.ok ? `done=${encodeURIComponent(`Connected in ${r.tookMs}ms: ${r.tables} tables. ${r.version}`)}` : `error=${encodeURIComponent(r.error)}`));
  }

  async function discover() {
    "use server";
    const u = await requireManager();
    try {
      const r = await discoverSchema();
      await audit({ action: "pioneer-sql.discover", userId: u.id, userName: u.name, details: `${r.tables} tables, ${r.columns} columns in ${r.tookMs}ms` });
      revalidatePath("/tools/pioneer-sql");
      redirect("/tools/pioneer-sql?done=" + encodeURIComponent(`Read ${r.tables} tables and ${r.columns} columns in ${r.tookMs}ms. Names only; no row was read.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e; // Next's redirect
      redirect("/tools/pioneer-sql?error=" + encodeURIComponent(e instanceof Error ? e.message : String(e)));
    }
  }

  async function run(fd: FormData) {
    "use server";
    await requireManager();
    const text = String(fd.get("sql") ?? "").trim();
    const check = isReadOnlySelect(text);
    if (!check.ok) redirect("/tools/pioneer-sql?error=" + encodeURIComponent(`Refused: ${check.why}.`));
    redirect("/tools/pioneer-sql?sql=" + encodeURIComponent(text));
  }

  // The query is run on view, from the address, so the page can be refreshed and shared as a link to a question.
  let result: Awaited<ReturnType<typeof query>> | null = null;
  let queryError: string | null = null;
  if (sqlText && !("missing" in config)) {
    try {
      result = await query(sqlText, {}, 500);
    } catch (e) {
      queryError = e instanceof Error ? e.message : String(e);
    }
  }

  const needle = (q ?? "").trim().toLowerCase();
  const tables = schema
    ? schema.tables
        .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.columns.some((c) => c.name.toLowerCase().includes(needle)))
        .slice(0, needle ? 200 : 60)
    : [];

  return (
    <>
      <BackLink href="/settings/connections">Connections</BackLink>
      <PageHeader
        title="PioneerRx database"
        subtitle="Read straight from PioneerRx. Test the connection, read the table names, and look at one table at a time. The site only reads; nothing here is stored."
      />

      {done && <Notice kind="ok">{done}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {"missing" in config ? (
        <Notice kind="warn">
          Not set up yet: {config.missing.join(", ")}. Enter them under <a className="underline" href="/settings/connections">Settings → Connections → PioneerRx database</a>.
        </Notice>
      ) : (
        <Card title="Connection" className="mt-4">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-ink-3">Server</dt>
            <dd className="font-mono">{s.pioneer_sql_server}{config.instance ? "" : config.port ? ` (port ${config.port})` : ""}</dd>
            <dt className="text-ink-3">Database</dt>
            <dd className="font-mono">{config.database}</dd>
            <dt className="text-ink-3">User</dt>
            <dd className="font-mono">{config.user}</dd>
            <dt className="text-ink-3">Last test</dt>
            <dd>{s.pioneer_sql_last_test ? `${fmt(s.pioneer_sql_last_test.slice(0, 10))} — ${s.pioneer_sql_last_result}` : "never"}</dd>
            <dt className="text-ink-3">Table names</dt>
            <dd>{schema ? `${schema.tables.length} tables, read ${fmt(schema.readAt.slice(0, 10))} from ${schema.version || "the server"}` : "not read yet"}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={test}><button className="btn">Test the connection</button></form>
            <form action={discover}><button className="btn btn-primary">{schema ? "Read the table names again" : "Read the table names"}</button></form>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Reading the table names asks the server for its catalogue: table and column names, types and row counts. No row of any table is read, and the file it writes (data/pioneer-schema.json) holds no patient, price or claim.
          </p>
        </Card>
      )}

      {schema && (
        <Card title="Tables" className="mt-6">
          <form method="get" className="mb-3 flex flex-wrap gap-2">
            <input name="q" defaultValue={q ?? ""} placeholder="a table or column name — claim, ndc, remit, inventory…" className="w-full max-w-md rounded-md border border-line px-3 py-2 text-sm" />
            <button className="btn">Find</button>
          </form>
          {tables.length === 0 ? (
            <Empty>Nothing named like that.</Empty>
          ) : (
            <div className="space-y-2">
              {tables.map((t) => (
                <details key={`${t.schema}.${t.name}`} className="rounded border border-line p-2 text-sm" open={Boolean(needle) && tables.length <= 8}>
                  <summary className="cursor-pointer">
                    <span className="font-mono">{t.schema === "dbo" ? t.name : `${t.schema}.${t.name}`}</span>
                    <span className="ml-2 text-xs text-ink-3">{t.columns.length} columns{t.rows !== null ? ` · ${t.rows.toLocaleString()} rows` : ""}</span>
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.columns.map((c) => (
                      <span key={c.name} className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${needle && c.name.toLowerCase().includes(needle) ? "bg-amber-50 text-amber-900" : "bg-surface-2 text-ink-2"}`} title={`${c.type}${c.maxLength ? `(${c.maxLength})` : ""}${c.nullable ? ", nullable" : ""}`}>
                        {c.name}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-xs"><a className="underline" href={`/tools/pioneer-sql?sql=${encodeURIComponent(`select top 20 * from ${t.schema === "dbo" ? `[${t.name}]` : `[${t.schema}].[${t.name}]`} order by 1 desc`)}`}>Look at the last 20 rows →</a></p>
                </details>
              ))}
              {!needle && schema.tables.length > tables.length && <p className="text-xs text-ink-3">Showing {tables.length} of {schema.tables.length}. Search to find the rest.</p>}
            </div>
          )}
        </Card>
      )}

      {!("missing" in config) && (
        <Card title="Ask the database one question" className="mt-6">
          <form action={run} className="space-y-2">
            <textarea name="sql" defaultValue={sqlText ?? ""} rows={4} placeholder="select top 20 * from …" className="w-full rounded-md border border-line px-3 py-2 font-mono text-sm" />
            <div className="flex items-center gap-3">
              <button className="btn btn-primary">Run</button>
              <span className="text-xs text-ink-3">One SELECT at a time, read uncommitted so nobody at the counter waits, capped at 500 rows. Shown here, stored nowhere.</span>
            </div>
          </form>
          {queryError && <Notice kind="crit">{queryError}</Notice>}
          {result && (
            <div className="mt-3">
              <p className="mb-2 text-xs text-ink-3">{result.rows.length} rows in {result.tookMs}ms{result.encrypted ? "" : " · connection not encrypted"}</p>
              <div className="overflow-x-auto">
                <table className="table text-xs">
                  <thead><tr>{result.columns.map((c) => <th key={c} className="whitespace-nowrap text-left">{c}</th>)}</tr></thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>{result!.columns.map((c) => <td key={c} className="whitespace-nowrap font-mono">{cell(r[c])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().replace("T", " ").slice(0, 19);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
