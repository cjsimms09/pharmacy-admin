import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fmt, todayIso } from "@/lib/dates";
import { buildHealth, summarise, type Health, type HealthRow } from "@/lib/data-health";
import { measureDataHealth, storedHealth, lastRun } from "@/lib/data-health-store";
import { PageHeader, Card, Notice, Empty } from "@/components/ui";

/**
 * Data health: the site measured against itself.
 *
 * The owner: "The logic and data in this site needs to be correct, full, and cleanly organized. If
 * we are missing data, I need to know and we need to fix it. Data needs to link when it should!"
 *
 * Every other page here answers a question about money, and every one of those answers is defined
 * only on the rows that linked. Where a link fails the figure is not wrong, it is absent — and an
 * absent figure looks exactly like a good month. This page is the one place that says what is
 * absent, so that no other page has to be read with a doubt attached.
 *
 * It reads stored counts and never counts on its own. Every libsql call blocks the Node event loop;
 * several of these counts read the whole catalogue and the whole NADAC table, and a page that
 * recounted on every view would take the site down while reporting its own health. Measuring is the
 * button.
 */

export const dynamic = "force-dynamic";

const TONE: Record<Health, { badge: string; label: string }> = {
  broken: { badge: "badge-crit", label: "matches nothing" },
  unmeasured: { badge: "badge-warn", label: "not measured" },
  poor: { badge: "badge-crit", label: "poor" },
  empty: { badge: "badge-muted", label: "no data yet" },
  fair: { badge: "badge-warn", label: "fair" },
  good: { badge: "badge-muted", label: "good" },
  complete: { badge: "badge-muted", label: "complete" },
};

export default async function DataHealthPage() {
  const user = await requireUser();
  const canMeasure = user.role !== "staff";

  async function measure() {
    "use server";
    const u = await requireManager();
    const r = await measureDataHealth();
    await audit({
      action: "data-health.measure",
      userId: u.id,
      userName: u.name,
      details: `${r.measured} measurements in ${r.tookMs}ms; ${r.skipped.length} not measurable`,
    });
    revalidatePath("/tools/data-health");
  }

  const [stored, run] = await Promise.all([storedHealth(), lastRun()]);
  const rows = buildHealth(stored, todayIso());
  const state = summarise(rows);
  const groups: HealthRow["group"][] = ["Links that must hold", "Datasets"];

  return (
    <>
      <PageHeader
        title="Data health"
        subtitle="What the site knows, what it is missing, and which joins every other page quietly depends on."
        help={
          <>
            <p>
              Every money figure on this site is defined only on the rows that linked. A margin exists for a fill whose
              NDC found a catalogue row with a pack size. A reimbursement formula exists for a claim that matched a
              contract. Where the link fails the figure is not wrong — it is <em>absent</em>, and an absent figure looks
              exactly like a good month.
            </p>
            <p>
              So three things are always kept apart here. <strong>0%</strong> means the link was tried and matched
              nothing. <strong>Nothing to measure</strong> means there is no data to try it on. <strong>Not
              measured</strong> means nobody has asked yet. A percentage reads 100% only when nothing at all is missing:
              26,245 of 26,246 prints as 99.9%, because one row is missing and this page exists to say so.
            </p>
            <p>
              The counts are stored rather than run on view. Reading 200,000 rows blocks the server for nearly two
              seconds, so measuring is a deliberate act rather than something that happens every time somebody looks.
            </p>
          </>
        }
        actions={
          canMeasure ? (
            <form action={measure}>
              <button className="btn btn-primary" type="submit">
                {run.measuredAt ? "Measure again" : "Measure now"}
              </button>
            </form>
          ) : undefined
        }
      />

      {run.measuredAt === null ? (
        <Notice kind="warn">
          Nothing has been measured yet. Until it is, this page can only list what it would measure — which is itself
          worth reading, because it is the set of joins every other figure on the site depends on.
        </Notice>
      ) : (
        <Notice kind={state.worst === "broken" || state.worst === "poor" ? "crit" : state.worst === "complete" ? "ok" : "warn"}>
          {state.says} Last measured {fmt(run.measuredAt)}
          {run.tookMs > 0 ? `, taking ${(run.tookMs / 1000).toFixed(1)} seconds` : ""}.
        </Notice>
      )}

      {groups.map((group) => {
        const inGroup = rows.filter((r) => r.group === group);
        if (inGroup.length === 0) return null;
        return (
          <Card
            key={group}
            title={group}
            count={inGroup.length}
            subtitle={
              group === "Links that must hold"
                ? "A join that fails does not produce a wrong number. It produces no number, on a page that still looks finished."
                : "Is it here at all, and is it current enough to be the figure in force."
            }
            className="mb-4"
          >
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>What</th>
                    <th className="whitespace-nowrap">How much of it</th>
                    <th className="whitespace-nowrap">Missing</th>
                    <th className="whitespace-nowrap">Measured</th>
                  </tr>
                </thead>
                <tbody>
                  {inGroup.map((r) => (
                    <tr key={r.key}>
                      <td className="align-top">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-medium">{r.title}</span>
                          <span className={`badge ${TONE[r.health].badge}`}>{TONE[r.health].label}</span>
                          {r.stale && <span className="badge badge-warn" title="The data may have moved since this was counted.">stale</span>}
                        </div>
                        <p className="mt-1 text-xs text-ink-3">{r.why}</p>
                        <p className="mt-0.5 text-[11px] text-ink-3">{r.of}</p>
                        {r.note && <p className="mt-1 text-xs text-ink-2">{r.note}</p>}
                        {r.gaps.length > 0 && (
                          <ul className="mt-1 list-disc pl-4 text-xs text-ink-2">
                            {r.gaps.map((g, i) => (
                              <li key={i}>{g}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      {/* The fraction leads and the percentage follows it. The owner acts on the
                          count — "29 NDCs with no NADAC" is a morning's work with a list at the end
                          of it — where the percentage is only how the row is scanned. */}
                      <td className="whitespace-nowrap align-top tabular-nums">{r.countText}</td>
                      <td className="whitespace-nowrap align-top tabular-nums">
                        {r.missing === null ? <span className="text-ink-3">—</span> : r.missing.toLocaleString("en-US")}
                      </td>
                      <td className="whitespace-nowrap align-top text-xs text-ink-3">
                        {r.measuredAt ? fmt(r.measuredAt) : "never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      {rows.length === 0 && <Empty>Nothing is defined to measure, which should not be possible.</Empty>}
    </>
  );
}
