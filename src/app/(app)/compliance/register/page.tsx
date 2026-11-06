import Link from "next/link";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { openItems, openStates, startedUsingSite, dismissedObligations } from "@/lib/compliance-status";
import { ensureObligations, CLOSURES } from "@/lib/obligations";
import { periodsBetween, periodLabel, periodKeyFor } from "@/lib/periods";
import { judgedPeriods, judgedFrom, cellState, type CellState } from "@/lib/judged";
import { todayIso, fmt } from "@/lib/dates";
import { PageHeader, BackLink } from "@/components/ui";

export const metadata = { title: "Compliance register" };
export const dynamic = "force-dynamic";

const CELL_CLASS: Record<CellState, string> = {
  satisfied: "bg-emerald-100 text-emerald-800",
  missed: "bg-red-100 text-red-800",
  partial: "bg-amber-100 text-amber-900",
  open: "bg-ground text-ink-3",
  awaiting: "border border-dashed border-amber-400 bg-amber-50 text-amber-900",
  not_judged: "border border-dashed border-line text-ink-3",
};

function cellTitle(c: { label: string; state: CellState; on: string | null; by: string | null }, from: string): string {
  if (c.state === "not_judged") return `${c.label} — not judged: this duty is counted from the period that holds ${fmt(from)}`;
  return `${c.label}${c.on ? ` — ${fmt(c.on)} by ${c.by}` : ""}`;
}

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
  const states = openStates(open);

  const start = await startedUsingSite();
  const dismissed = await dismissedObligations();

  const rows = obligations
    .map((o) => {
      const periods = periodsBetween(o.cadence, start, today).slice(-8);
      const closure = o.seedKey ? CLOSURES[o.seedKey] : undefined;
      const judged = new Set(judgedPeriods(o, start, today));
      return {
        o,
        closure,
        from: judgedFrom(o.confirmedOn, start),
        cells: periods.map((p) => {
          const filed = completions.filter((c) => c.obligationId === o.id && (c.periodKey ?? periodKeyFor(o.cadence, c.completedOn)) === p);
          return {
            key: p,
            label: periodLabel(p),
            // The state the list on Compliance decided for a period still outstanding. A period it does not carry is covered only if it was
            // judged at all; otherwise it reads awaiting (the duty has no answer yet) or not judged (before the day counting started).
            state: cellState(o, p, judged, states.get(`${o.id}|${p}`)),
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
            {rows.map(({ o, closure, cells, from }) => (
              <tr key={o.id} className="border-t border-line align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{o.title}</div>
                  <div className="text-xs text-ink-3">{o.citation ?? "—"} · {o.cadence}</div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {o.kind === "attest" && <span>you confirm it{closure?.minutes ? ` · ~${closure.minutes} min` : ""}</span>}
                  {o.kind === "evidence" && <span>a document{o.expectedPerPeriod > 1 ? ` (${o.expectedPerPeriod} per period)` : ""}</span>}
                  {o.kind === "witnessed" && <span className="text-emerald-700">closes itself</span>}
                  {o.kind === "renewal" && (
                    <>
                      <span className="text-emerald-700">closes itself</span>
                      <div className="mt-0.5 text-ink-3">when a certificate that runs past the end of the period is entered under Licences</div>
                    </>
                  )}
                  {o.witnessSource && <div className="mt-0.5 text-ink-3">{o.witnessSource}</div>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {o.needsConfirmation && (
                      <Link href="/compliance" className={`rounded px-1.5 py-0.5 text-xs hover:underline ${CELL_CLASS.awaiting}`}>
                        Awaiting your yes or no. Not judged for any period until you answer, on Compliance or Today.
                      </Link>
                    )}
                    {!o.needsConfirmation && cells.map((c) => (
                      <span key={c.key} title={cellTitle(c, from)} className={`rounded px-1.5 py-0.5 text-xs ${CELL_CLASS[c.state]}`}>
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

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Considered and not applicable</h2>
        {dismissed.length === 0 ? (
          <p className="mt-1 text-xs text-ink-3">No duty has been answered &ldquo;no&rdquo;.</p>
        ) : (
          <>
            <p className="mt-1 text-xs text-ink-3">
              Answered &ldquo;no&rdquo; on Compliance or Today. None of their periods are counted; they are listed here so an inspector sees each was decided,
              with the day and the person. Anything with its own screen, such as a person&rsquo;s training or a licence, is still tracked there.
            </p>
            <ul className="mt-2 divide-y divide-line rounded-lg border border-line text-sm">
              {dismissed.map((d) => (
                <li key={d.obligationId} className="px-3 py-2">
                  <div className="font-medium">{d.title}</div>
                  <div className="text-xs text-ink-3">
                    {d.citation ?? "—"} · {d.cadence} · decided {d.decidedOn ? fmt(d.decidedOn) : "(date not recorded)"} by {d.decidedBy ?? "(nobody recorded)"}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="mt-4 text-xs text-ink-3">
        Green is covered, red is late (its day has passed and nothing covers it), amber is part done, grey is not due yet. A dashed grey period
        ended before this duty was confirmed as the pharmacy&rsquo;s own, so it was never judged; a dashed amber duty is still waiting for your
        yes or no and is not judged for any period. A duty done only when it happens has no periods, so its row has none. Hover a period to see
        when it was closed and by whom.{" "}
        <Link href="/compliance" className="underline">Back to what needs you</Link>
      </p>
    </>
  );
}
