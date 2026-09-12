import Link from "next/link";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { openItems } from "@/lib/compliance-status";
import { ensureObligations, CLOSURES } from "@/lib/obligations";
import { periodsBetween, periodLabel, stateOf, periodKeyFor } from "@/lib/periods";
import { todayIso, fmt } from "@/lib/dates";
import { PageHeader, BackLink } from "@/components/ui";

export const metadata = { title: "Compliance register" };
export const dynamic = "force-dynamic";

/**
 * The full register: every duty, every period, satisfied or not.
 *
 * Deliberately not the main screen. A PIC does not want to read twenty-seven duties, they want
 * the two that need them today — but the register is what gets shown to an inspector, and it is
 * where a gap becomes visible as a gap rather than as a date.
 */
export default async function RegisterPage() {
  await requireUser();
  await ensureObligations();
  const today = todayIso();
  const obligations = (await db.query.obligations.findMany()).filter((o) => o.active);
  const completions = await db.query.obligationCompletions.findMany();
  const open = await openItems();
  const openKeys = new Set(open.map((i) => `${i.obligationId}|${i.periodKey}`));

  const [first] = obligations;
  const start = (first?.createdAt ?? new Date().toISOString()).slice(0, 10);

  const rows = obligations
    .map((o) => {
      const periods = periodsBetween(o.cadence, start, today).slice(-8);
      const closure = o.seedKey ? CLOSURES[o.seedKey] : undefined;
      return {
        o,
        closure,
        cells: periods.map((p) => {
          const filed = completions.filter((c) => c.obligationId === o.id && (c.periodKey ?? periodKeyFor(o.cadence, c.completedOn)) === p);
          const stillOpen = openKeys.has(`${o.id}|${p}`);
          return {
            key: p,
            label: periodLabel(p),
            state: stillOpen ? stateOf(filed.length, o.expectedPerPeriod, p, today) : ("satisfied" as const),
            on: filed[0]?.completedOn ?? null,
            by: filed[0]?.completedBy ?? null,
          };
        }),
      };
    })
    .sort((a, b) => a.o.title.localeCompare(b.o.title));

  return (
    <>
      <BackLink href="/compliance">Compliance</BackLink>
      <PageHeader
        title="Compliance register"
        subtitle="Every duty against every period. This is the view that shows a gap as a gap, rather than as a date that has passed."
        actions={<Link href="/compliance/attestations" className="btn">What I have signed</Link>}
      />

      <div className="mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
            <tr>
              <th className="px-3 py-2">Duty</th>
              <th className="px-3 py-2">Closed by</th>
              <th className="px-3 py-2">Recent periods</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ o, closure, cells }) => (
              <tr key={o.id} className="border-t border-line align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{o.title}</div>
                  <div className="text-xs text-ink-3">{o.citation ?? "—"} · {o.cadence}</div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {o.kind === "attest" && <span>you confirm it{closure?.minutes ? ` · ~${closure.minutes} min` : ""}</span>}
                  {o.kind === "evidence" && <span>a document{o.expectedPerPeriod > 1 ? ` (${o.expectedPerPeriod} per period)` : ""}</span>}
                  {o.kind === "witnessed" && <span className="text-emerald-700">closes itself</span>}
                  {o.kind === "renewal" && <span>renewal</span>}
                  {o.witnessSource && <div className="mt-0.5 text-ink-3">{o.witnessSource}</div>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {cells.map((c) => (
                      <span
                        key={c.key}
                        title={`${c.label}${c.on ? ` — ${fmt(c.on)} by ${c.by}` : ""}`}
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          c.state === "satisfied"
                            ? "bg-emerald-100 text-emerald-800"
                            : c.state === "missed"
                              ? "bg-red-100 text-red-800"
                              : c.state === "partial"
                                ? "bg-amber-100 text-amber-900"
                                : "bg-ground text-ink-3"
                        }`}
                      >
                        {c.label.replace(/(\w+) (\d{4})/, (_, m: string, y: string) => `${m.slice(0, 3)} ${y.slice(2)}`)}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Green is covered, red is a period that went by, amber is part done, grey is not due yet. Hover a period to see
        when it was closed and by whom. <Link href="/compliance" className="underline">Back to what needs you</Link>
      </p>
    </>
  );
}
