import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { inspectionReport, type Check } from "@/lib/inspection";
import { fmtLong } from "@/lib/dates";
import { PageHeader, Card, Figure } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inspection readiness" };

/**
 * The screen to open the morning an inspector walks in — and, better, on a quiet afternoon
 * beforehand.
 *
 * Organised around what actually gets asked for on a visit rather than around the shape of this
 * database. Nobody asks whether the obligations table is satisfied; they ask to see the
 * registration, the technician list, the last controlled substance inventory, the CQI records,
 * the temperature logs, who is licensed and what training those people have had. Each of those is
 * a question this site can answer or cannot, and saying which is far more use than a score out of
 * ten.
 *
 * Deliberately harsh in one direction: anything that cannot be produced counts as not held. A
 * record that exists but nobody can find during a visit is, on the day, the same as no record.
 */
export default async function InspectionPage({
  searchParams,
}: {
  searchParams: Promise<{ who?: string }>;
}) {
  await requireUser();
  const { who } = await searchParams;
  const r = await inspectionReport();

  // The Board and DEA arrive separately and want different things. Showing one list of
  // twenty-odd questions makes both visits look harder than either actually is.
  const lens = who === "dea" || who === "board" ? who : "all";
  const shown = r.checks.filter((c) => lens === "all" || c.who === lens || c.who === "both");

  const blocking = shown.filter((c) => c.state === "blocking");
  const gaps = shown.filter((c) => c.state === "gap");
  const ready = shown.filter((c) => c.state === "ready");

  return (
    <>
      <PageHeader
        title="If they walked in tomorrow"
        subtitle={`${r.pharmacy.name}${r.pharmacy.registration ? ` · registration ${r.pharmacy.registration}` : ""}${r.pharmacy.dea ? ` · DEA ${r.pharmacy.dea}` : ""} — checked ${fmtLong(r.takenOn)}`}
        actions={
          <>
            <Link href="/inspection/walk" className="btn btn-primary">Walk the pharmacy</Link>
            <Link href="/inspection/print" className="btn">Print the pack</Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        <Link href="/inspection" className={`btn btn-sm ${lens === "all" ? "btn-primary" : ""}`}>
          Everything ({r.checks.length})
        </Link>
        <Link href="/inspection?who=board" className={`btn btn-sm ${lens === "board" ? "btn-primary" : ""}`}>
          What the Board asks ({r.checks.filter((c) => c.who === "board" || c.who === "both").length})
        </Link>
        <Link href="/inspection?who=dea" className={`btn btn-sm ${lens === "dea" ? "btn-primary" : ""}`}>
          What DEA asks ({r.checks.filter((c) => c.who === "dea" || c.who === "both").length})
        </Link>
      </div>

      <Card tone={r.blocking > 0 ? "crit" : r.gaps > 0 ? "warn" : "ok"} className="mb-6">
        <p className="text-lg font-semibold">{r.verdict}</p>
        <p className="mt-1 text-sm text-ink-2">
          {ready.length} of {shown.length} questions can be answered straight from this site today
          {lens === "all" ? "" : lens === "dea" ? ", on a DEA visit" : ", on a Board visit"}.
        </p>
      </Card>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Figure value={blocking.length} label="Would be a finding" sub="Fix these first" tone={blocking.length === 0 ? "ok" : "crit"} href="#blocking" />
        <Figure value={gaps.length} label="Weaker than it should be" sub="Answerable, but not well" tone={gaps.length === 0 ? "ok" : "warn"} href="#gaps" />
        <Figure value={ready.length} label="Ready to hand over" sub="Producible on the spot" tone="ok" href="#ready" />
      </div>

      {blocking.length > 0 && <Group id="blocking" title="Would be a finding today" checks={blocking} tone="crit" />}
      {gaps.length > 0 && <Group id="gaps" title="Answerable, but weaker than it needs to be" checks={gaps} tone="warn" />}
      {ready.length > 0 && <Group id="ready" title="Ready to hand over" checks={ready} tone="ok" />}
    </>
  );
}

function Group({ id, title, checks, tone }: { id: string; title: string; checks: Check[]; tone: "crit" | "warn" | "ok" }) {
  return (
    <Card id={id} title={title} count={checks.length} tone={tone === "ok" ? undefined : tone} className="mb-6">
      <ul className="rows">
        {checks.map((c) => (
          <li key={c.key} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3>&ldquo;{c.asks}&rdquo;</h3>
                <p className="mt-1 text-sm text-ink-2">{c.answer}</p>
                <p className="mt-1 text-xs text-ink-3">
                  <span className="badge badge-muted mr-1.5">{c.who === "dea" ? "DEA" : c.who === "board" ? "Board" : "Both"}</span>
                  {c.authority}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span className={`badge ${c.state === "blocking" ? "badge-crit" : c.state === "gap" ? "badge-warn" : "badge-ok"}`}>
                  {c.state === "blocking" ? "finding" : c.state === "gap" ? "thin" : "ready"}
                </span>
                {c.printHref && <Link href={c.printHref} className="btn btn-sm">Print</Link>}
                {c.href && <Link href={c.href} className="btn btn-sm">Open</Link>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
