import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { checkReport, type ReportCheck, type FieldResult } from "@/lib/report-check";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty } from "@/components/ui";
import { CLAIM_NEEDS } from "@/lib/report-check";
import { COLUMNS } from "@/lib/claims";

export const metadata = { title: "Report check" };
export const dynamic = "force-dynamic";

/**
 * The result is held in a cookie rather than the database: this is a scratch check run against a
 * candidate report, not a record of anything. Nothing about it is worth keeping.
 */
const RESULT_COOKIE = "report-check";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { error } = await searchParams;
  const raw = (await cookies()).get(RESULT_COOKIE)?.value;
  let check: ReportCheck | null = null;
  try {
    check = raw ? (JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as ReportCheck) : null;
  } catch {
    check = null;
  }

  async function run(fd: FormData) {
    "use server";
    await requireUser();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) redirect("/reports?error=" + encodeURIComponent("Choose a file."));
    try {
      const result = checkReport(file.name, Buffer.from(await file.arrayBuffer()));
      const jar = await cookies();
      jar.set(RESULT_COOKIE, Buffer.from(JSON.stringify(result)).toString("base64"), {
        httpOnly: true, sameSite: "lax", path: "/reports", maxAge: 3600,
      });
      redirect("/reports");
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/reports?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read that file."));
    }
  }

  const critMissing = check?.results.filter((r) => r.critical && r.state !== "populated") ?? [];

  return (
    <>
      <PageHeader
        title="Report check"
        subtitle="Drop a report in and see exactly what it can and cannot support, then send the gaps back to whoever builds it."
      />

      {error && <Notice kind="crit">{error}</Notice>}

      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <p className="text-sm text-ink-2">
          A written specification tells you a column is missing. It cannot tell you a column is present and{" "}
          <b>empty</b> — which is what actually happened with Dispensed Quantity and Acquisition Cost. This reads the
          real file and reports three states, not two.
        </p>
        <form action={run} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="file" name="file" accept=".xlsx,.csv" className="text-sm" />
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Check it</button>
        </form>
        <p className="mt-2 text-xs text-ink-3">
          Nothing is saved. This reads the file, reports on it, and forgets it — use Claims or Purchasing to actually
          load one.
        </p>
      </section>

      {!check ? (
        <>
          <Empty>No report checked yet.</Empty>

          {/*
            What to ask for, before there is a file to check.
            
            The checker answers "is this report good enough" and cannot answer "what report should
            I build" — which is the question that comes first and the one somebody has to take to
            whoever writes the report. The names below lead with PioneerRx's own, so a report built
            from this list imports without anybody renaming a column afterwards.
          */}
          <section className="mt-6 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">What to ask for</h2>
            <p className="mt-1 text-sm text-ink-2">
              Ask for the <b>Completed Prescriptions</b> report, one row per fill, with the primary third-party
              columns added — that report is one row per dispensing, which is the unit the statutory floor is
              calculated on. A transaction-level claims report carries a submission, a reversal and a resubmission as
              three rows for the same fill, which has to be unpicked before anything can be priced.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                  <tr>
                    <th className="px-3 py-2">Column</th>
                    <th className="px-3 py-2">Ask for it as</th>
                    <th className="px-3 py-2">Needed</th>
                    <th className="px-3 py-2">Without it</th>
                  </tr>
                </thead>
                <tbody>
                  {CLAIM_NEEDS.map((n) => {
                    const names = (COLUMNS as Record<string, readonly string[]>)[n.field] ?? [];
                    return (
                      <tr key={n.field} className="border-t border-line align-top">
                        <td className="px-3 py-2 font-medium">
                          {n.name}
                          {n.ncpdp && <div className="text-xs text-ink-3">NCPDP {n.ncpdp}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs text-ink-2">
                          {names[0] ?? "—"}
                          {names.length > 1 && (
                            <div className="text-ink-3">or: {names.slice(1).join(", ")}</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {n.critical ? (
                            <span className="badge badge-crit">required</span>
                          ) : (
                            <span className="badge badge-muted">helpful</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-ink-2">{n.blocks}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-3">
              Three more columns are worth asking for even though nothing here needs them yet, because each closes an
              assumption the floor review currently has to make in the pharmacy&rsquo;s favour: whether the claim was
              <b> reversed</b>, whether it was a <b>compound</b>, and whether it was dispensed under <b>340B</b>.
              None of the three is priced against NADAC.
            </p>
          </section>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Recognised as" value={check.kind === "unrecognised" ? "unknown" : check.kind.replace(/_/g, " ")} tone={check.kind === "unrecognised" ? "warn" : "ok"} />
            <Stat label="Rows" value={check.rows.toLocaleString()} />
            <Stat label="Columns" value={String(check.headers.length)} />
            <Stat label="Blocking gaps" value={String(critMissing.length)} tone={critMissing.length ? "crit" : "ok"} />
          </div>

          {check.kind === "unrecognised" && (
            <Notice kind="warn">
              This was not recognised as a claims export or a supplier catalogue, so it has been checked against the
              claims requirements as the more likely of the two. {check.why}
            </Notice>
          )}

          <h2 className="mt-8 text-sm font-semibold">Field by field</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">Field</th>
                  <th className="px-3 py-2">Column found</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">What it blocks</th>
                </tr>
              </thead>
              <tbody>
                {check.results.map((r) => (
                  <tr key={r.name} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      {r.name}
                      {r.ncpdp && <div className="font-mono text-xs text-ink-3">{r.ncpdp}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.column ?? <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 py-2"><State r={r} /></td>
                    <td className="px-3 py-2 text-xs text-ink-3">{r.state === "populated" ? "" : r.blocks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-8 text-sm font-semibold">Send this back</h2>
          <p className="mb-2 text-xs text-ink-3">
            Only what is actually wrong with this file. Copy it into the request box.
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-4 text-sm">{check.askBack}</pre>

          {check.extraColumns.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold">Columns the site does not use</h2>
              <p className="mt-1 text-xs text-ink-3">
                Harmless, and worth keeping if they are useful to you elsewhere. Listed so a column you expected to be
                read is visible when it is not.
              </p>
              <p className="mt-2 font-mono text-xs text-ink-2">{check.extraColumns.join(" · ")}</p>
            </>
          )}
        </>
      )}
    </>
  );
}

function State({ r }: { r: FieldResult }) {
  if (r.state === "populated") return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">populated</span>;
  if (r.state === "partial")
    return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">{Math.round(r.fillRate * 100)}% filled</span>;
  if (r.state === "empty")
    return <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">column present, all blank</span>;
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${r.critical ? "bg-red-100 text-red-800" : "bg-ground text-ink-3"}`}>
      {r.critical ? "missing" : "not on report"}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" | "crit" }) {
  const c = tone === "crit" ? "border-red-300 bg-red-50" : tone === "warn" ? "border-amber-300 bg-amber-50" : tone === "ok" ? "border-emerald-300 bg-emerald-50" : "border-line bg-surface";
  return (
    <div className={`rounded-lg border p-3 ${c}`}>
      <div className="text-lg font-semibold capitalize tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}
