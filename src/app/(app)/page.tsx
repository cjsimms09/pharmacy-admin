import Link from "next/link";
import { cqiSnapshot, csInventoryStatus } from "@/lib/compliance";
import { dueList, type DueItem } from "@/lib/due";
import { complianceSummary, type OpenItem } from "@/lib/compliance-status";
import { staffMatrix, type Cell, type MatrixRow, type StaffMatrix } from "@/lib/staff-matrix";
import { automationStatus, type JobStatus } from "@/lib/automation-status";
import { openFindings } from "@/lib/self-inspection";
import { attestAction, answerAction, sendTrainingAction } from "./_actions/compliance";
import { daysUntil, fmt, fmtLong, todayIso } from "@/lib/dates";
import { PERSON_ROLE_LABEL } from "@/lib/labels";
import { Notice, Card, Figure, PageHeader } from "@/components/ui";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

/**
 * The one screen a pharmacist-in-charge should be able to trust.
 *
 * Four things in a deliberate order, and nothing else: how bad is it, is my staff covered, what
 * needs doing, and is the machinery still running.
 *
 * Two rules produced this layout, both learned from the version it replaces.
 *
 * Weight has to match importance. Every row on the old screen was the same 13px grey line in the
 * same white card, so a lapsed licence and a note about a background job read as equally urgent
 * and the eye had nowhere to land. The numbers at the top are large because they are the answer
 * to the only question asked from the doorway.
 *
 * And a screen is read by requirement, not by person. Three people with no immunization protocol
 * on file is one job; listing it three times under three headings that read identically is how a
 * list becomes wallpaper. Anything that can be one row is one row, with the names on it.
 *
 * Nothing appears in red until it is genuinely past its date. A duty for September is not a
 * September problem, and being told on the third of the month that the month is unfinished is
 * exactly how a compliance screen earns the right to be ignored.
 */

type Tone = "crit" | "warn" | "muted";

type Row = {
  key: string;
  title: string;
  why: string;
  badge: string;
  tone: Tone;
  href: string;
  attest?: { obligationId: string; periodKey: string; statement: string; minutes: number | null };
};

const openRow = (i: OpenItem): Row => ({
  key: `${i.obligationId}-${i.periodKey}`,
  title: i.title,
  why:
    i.state === "partial"
      ? `${i.periodLabel} — ${i.have} of ${i.expected} filed. ${i.missing ?? ""}`.trim()
      : `${i.periodLabel} — ${i.missing ?? i.detail ?? "Nothing was filed for this period."}`,
  badge: i.state === "open" ? `due ${fmt(i.dueOn)}` : i.state === "partial" ? "part done" : `${i.daysLate}d late`,
  tone: i.state === "missed" ? "crit" : i.state === "partial" ? "warn" : "muted",
  href: i.href ?? "/compliance",
  attest:
    i.kind === "attest" && i.statement
      ? { obligationId: i.obligationId, periodKey: i.periodKey, statement: i.statement, minutes: i.minutes }
      : undefined,
});

const dueRow = (d: DueItem): Row => ({
  key: d.id,
  title: d.title,
  why: d.action,
  badge: d.daysLeft === null ? "nothing on file" : d.daysLeft < 0 ? `${Math.abs(d.daysLeft)}d late` : `${d.daysLeft}d`,
  tone: d.daysLeft === null ? "warn" : d.daysLeft < 0 ? "crit" : "muted",
  href: d.href,
});

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { ok, error } = await searchParams;
  const [compliance, dated, matrix, cqi, cs, jobs, selfFindings] = await Promise.all([
    complianceSummary(),
    dueList({ horizonDays: 60 }),
    staffMatrix(),
    cqiSnapshot(),
    csInventoryStatus(),
    automationStatus(),
    openFindings(),
  ]);

  const today = todayIso();
  const cqiDays = daysUntil(cqi.dueOn)!;
  const cqiFiled = cqi.status === "final";
  const csDays = cs.dueOn ? daysUntil(cs.dueOn) : null;

  // ── What is actually wrong right now, in three groups the PIC thinks in ──
  const lateTraining = dated.filter((d) => d.kind === "training" && (d.severity === "overdue" || d.severity === "no_date")).map(dueRow);
  const lateCredentials = dated.filter((d) => d.kind === "credential" && (d.severity === "overdue" || d.severity === "no_date")).map(dueRow);
  const latePharmacy: Row[] = [...compliance.missed.map(openRow), ...compliance.partial.map(openRow)];

  if (!cqiFiled && cqiDays < 0) {
    latePharmacy.push({
      key: "cqi",
      title: `CQI summary — ${cqi.label}`,
      why: `${cqi.incidentCount} incident${cqi.incidentCount === 1 ? "" : "s"} in the period. Currently ${cqi.status}.`,
      badge: `${-cqiDays}d late`,
      tone: "crit",
      href: cqi.summaryId ? `/cqi/summaries/${cqi.summaryId}` : "/cqi",
    });
  }
  if (cs.dueOn === null || (csDays !== null && csDays < 0)) {
    latePharmacy.push({
      key: "cs-inventory",
      title: "Annual controlled substance inventory",
      why: cs.last ? `Last taken ${fmt(cs.last)}. A year and ten days is the outside limit.` : "None has ever been recorded here.",
      badge: csDays === null ? "none on file" : `${-csDays}d late`,
      tone: csDays === null ? "warn" : "crit",
      href: "/inventory",
    });
  }

  // Something the pharmacy found itself and has not put right is worse than something it has
  // not looked at, not better — it is a known defect with a date on it. These sit with the late
  // work rather than in a corner of the inspection screen.
  for (const fnd of selfFindings) {
    latePharmacy.push({
      key: `finding-${fnd.id}`,
      title: fnd.ask,
      why: `Found on your own walkthrough ${fmt(fnd.foundOn)}${fnd.note ? ` — ${fnd.note}` : ""}. Say what was done and it closes.`,
      badge: `open ${fnd.daysOpen}d`,
      tone: fnd.daysOpen > 30 ? "crit" : "warn",
      href: fnd.fixHref ?? "/inspection/walk",
    });
  }

  const lateCount = lateTraining.length + lateCredentials.length + latePharmacy.length;

  // ── One-click closures, pulled out of the pile ──
  // A duty whose entire content is one sentence and one button does not belong in a list of
  // things to go and do somewhere else. Ten of these are twenty minutes of work presented as
  // twenty separate problems.
  const quick: Row[] = [...latePharmacy, ...compliance.openNow.map(openRow)]
    .filter((r) => r.attest)
    // Genuinely late first. Everything after that is somebody getting ahead of a period that has
    // not ended, which is worth offering and must not be dressed up as a deadline.
    .sort((a, b) => Number(a.tone === "muted") - Number(b.tone === "muted"));
  const quickLate = quick.filter((r) => r.tone !== "muted").length;
  const quickMinutes = quick.reduce((n, r) => n + (r.attest?.minutes ?? 0), 0);

  // ── What is coming, quietly ──
  const soon: Row[] = [
    ...dated.filter((d) => d.severity === "due_soon").map(dueRow),
    ...compliance.openNow
      .filter((i) => i.kind !== "attest")
      .map((i) => ({
        key: `${i.obligationId}-${i.periodKey}`,
        title: i.title,
        why: `${i.periodLabel}. Not late, and will not count against you until the period ends.`,
        badge: `due ${fmt(i.dueOn)}`,
        tone: "muted" as Tone,
        href: i.href ?? "/compliance",
      })),
  ];
  if (!cqiFiled && cqiDays >= 0) {
    soon.push({
      key: "cqi",
      title: `CQI summary — ${cqi.label}`,
      why: `${cqi.incidentCount} incident${cqi.incidentCount === 1 ? "" : "s"} in the period. Currently ${cqi.status}.`,
      badge: `due ${fmt(cqi.dueOn)}`,
      tone: "muted",
      href: cqi.summaryId ? `/cqi/summaries/${cqi.summaryId}` : "/cqi",
    });
  }
  if (csDays !== null && csDays >= 0) {
    soon.push({
      key: "cs-inventory",
      title: "Annual controlled substance inventory",
      why: `Last taken ${fmt(cs.last)}.`,
      badge: `due ${fmt(cs.dueOn)}`,
      tone: "muted",
      href: "/inventory",
    });
  }

  const stalled = jobs.filter((j) => j.state === "stale");

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={fmtLong(today)}
        actions={
          <>
            <Link href="/compliance" className="btn">Compliance</Link>
            <Link href="/compliance/training" className="btn">Training</Link>
            {lateCount > 0 && <Link href="#now" className="btn btn-primary">Work through {lateCount}</Link>}
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/* ── The four numbers. Large, because this is the question asked from the doorway. ── */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          value={lateCount}
          label="Late"
          sub={lateCount === 0 ? "Nothing has passed its date" : "Past a deadline now"}
          tone={lateCount === 0 ? "ok" : "crit"}
          href="#now"
        />
        <Figure
          value={`${matrix.covered}/${matrix.rows.length}`}
          label="Staff fully covered"
          sub={matrix.gaps === 0 ? "No gaps anywhere" : `${matrix.gaps} gap${matrix.gaps === 1 ? "" : "s"} to close`}
          tone={matrix.gaps === 0 ? "ok" : "warn"}
          href="#staff"
        />
        <Figure
          value={quick.length}
          label="One-click closures"
          sub={quick.length === 0 ? "Nothing waiting on a signature" : `${quickLate} late · about ${quickMinutes} min in all`}
          tone={quick.length === 0 ? "ok" : quickLate > 0 ? "warn" : "ok"}
          href="#quick"
        />
        <Figure
          value={soon.length}
          label="Coming up"
          sub="Next 60 days · none of it late"
          tone="ok"
          href="#soon"
        />
      </div>

      {stalled.length > 0 && (
        <Card
          tone="crit"
          title={stalled.length === 1 ? "Something the site does for you has stopped" : `${stalled.length} things the site does for you have stopped`}
          className="mb-6"
        >
          <p className="text-sm text-ink-2">
            {stalled.map((j) => j.label).join(", ")}. A job that quietly stops looks exactly like one with nothing to
            do — which is the one failure mode of automating any of this.
          </p>
        </Card>
      )}

      {/* ── Is my staff covered. Second, and prominent, because it is the question an inspector
             actually asks and the only view that answers it in one look. ── */}
      <StaffBoard m={matrix} />

      {/* ── One-click closures ── */}
      {quick.length > 0 && (
        <Card
          id="quick"
          title="One-click closures"
          count={`${quickLate} late · ${quick.length - quickLate} early`}
          actions={<span className="text-sm text-ink-3">about {quickMinutes} min of real work in total</span>}
          subtitle="Each of these is done outside the site and confirmed here. Open one to read the exact sentence that gets recorded, word for word, with your name and today's date."
          className="mb-6"
        >
          <ul className="rows">
            {quick.map((r) => (
              <li key={r.key} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3>{r.title}</h3>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {r.attest!.minutes !== null ? `about ${r.attest!.minutes} min of actual work` : "one confirmation"}
                      {r.tone === "muted" && " · not due yet, but two minutes now"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className={`badge ${r.tone === "crit" ? "badge-crit" : r.tone === "warn" ? "badge-warn" : "badge-muted"}`}>
                      {r.badge}
                    </span>
                    <form action={attestAction}>
                      <input type="hidden" name="obligationId" value={r.attest!.obligationId} />
                      <input type="hidden" name="periodKey" value={r.attest!.periodKey} />
                      <input type="hidden" name="statement" value={r.attest!.statement} />
                      <input type="hidden" name="back" value="/" />
                      <button className="btn btn-sm btn-primary">Confirm</button>
                    </form>
                  </div>
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">what gets recorded</summary>
                  <p className="mt-1 text-xs italic text-ink-2">&ldquo;{r.attest!.statement}&rdquo;</p>
                </details>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── Everything else that is late, grouped the way it gets worked ── */}
      <section id="now" className="mb-6">
        {lateCount === 0 ? (
          <Card tone="ok" title="Nothing is late">
            <p className="text-sm text-ink-2">
              Every compliance period that has ended is covered, every licence and training is current, and no record
              is sitting here without a date on it.
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            <Group title="Training" rows={lateTraining} action={{ href: "/compliance/training", label: "Send training" }} />
            <Group title="Licences and credentials" rows={lateCredentials} action={{ href: "/staff", label: "Staff" }} />
            <Group title="Pharmacy duties" rows={latePharmacy.filter((r) => !r.attest)} action={{ href: "/compliance", label: "Compliance" }} />
          </div>
        )}
      </section>

      {/* ── Questions the site cannot answer for him ── */}
      {compliance.unanswered.length > 0 && (
        <Card
          title="Does this apply here?"
          count={compliance.unanswered.length}
          subtitle="Duties the site cannot decide for you. Nothing here counts against you until you say it applies, and a “no” is recorded with the date so the register shows it was considered rather than missed."
          className="mb-6"
        >
          <div className="divide-y divide-line">
            {compliance.unanswered.map((q) => (
              <div key={q.obligationId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{q.title}</p>
                  {q.citation && <p className="text-xs text-ink-3">{q.citation}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <form action={answerAction}>
                    <input type="hidden" name="obligationId" value={q.obligationId} />
                    <input type="hidden" name="applies" value="yes" />
                    <input type="hidden" name="back" value="/" />
                    <button className="btn btn-primary">Yes</button>
                  </form>
                  <form action={answerAction}>
                    <input type="hidden" name="obligationId" value={q.obligationId} />
                    <input type="hidden" name="applies" value="no" />
                    <input type="hidden" name="back" value="/" />
                    <button className="btn">Not us</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Coming up: closed, because none of it is a problem today ── */}
      {soon.length > 0 && (
        <details id="soon" className="card mb-6">
          <summary className="cursor-pointer text-lg font-semibold">
            Coming up{" "}
            <span className="text-sm font-normal text-ink-3">
              — {soon.length} thing{soon.length === 1 ? "" : "s"} in the next 60 days, none of it late
            </span>
          </summary>
          <ul className="mt-3 divide-y divide-line">
            {soon
              .slice()
              .sort((a, b) => a.badge.localeCompare(b.badge))
              .map((r) => (
                <li key={r.key} className="flex flex-wrap items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Link href={r.href} className="text-sm font-medium hover:text-accent hover:underline">{r.title}</Link>
                    <p className="text-xs text-ink-3">{r.why}</p>
                  </div>
                  <span className="badge badge-muted whitespace-nowrap">{r.badge}</span>
                </li>
              ))}
          </ul>
        </details>
      )}

      <AutomationStrip jobs={jobs} />
    </>
  );
}

/**
 * One band of late things.
 *
 * Grouped by the kind of work rather than by severity, because those are three different
 * afternoons: sending training out, chasing paperwork off individual people, and duties only the
 * PIC can discharge. A single list sorted by days late interleaves all three and makes every one
 * of them feel unfinished.
 */
function Group({ title, rows, action }: { title: string; rows: Row[]; action: { href: string; label: string } }) {
  if (rows.length === 0) return null;
  return (
    <Card title={title} count={rows.length} actions={<Link href={action.href} className="btn btn-sm">{action.label}</Link>}>
      <ul className="rows">
        {rows.slice(0, 10).map((r) => (
          <li key={r.key}>
            <Link href={r.href} className="row">
              <span className="min-w-0">
                <span className="row-title block">{r.title}</span>
                <span className="row-why block">{r.why}</span>
              </span>
              <span className={`badge ${r.tone === "crit" ? "badge-crit" : "badge-warn"}`}>{r.badge}</span>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length > 10 && (
        <p className="mt-3 text-xs text-ink-3">
          <Link href={action.href} className="underline">and {rows.length - 10} more</Link>
        </p>
      )}
    </Card>
  );
}

/**
 * Who is missing what.
 *
 * The question an inspector asks is not "what is overdue", it is "show me your staff are trained
 * and licensed". That is a person-by-requirement question and only a grid answers it in one look.
 * An empty cell is a finding; a cell merely approaching its date is not, and is not coloured as
 * though it were.
 */
function StaffBoard({ m }: { m: StaffMatrix }) {
  if (m.rows.length === 0) {
    return (
      <Card id="staff" title="Staff compliance" className="mb-6">
        <p className="text-sm text-ink-3">
          No active staff yet. <Link href="/staff/new" className="text-accent underline">Add the first person</Link> and
          this becomes the board you show an inspector.
        </p>
      </Card>
    );
  }
  return (
    <Card
      id="staff"
      title="Staff compliance"
      actions={
        <>
          <Link href="/compliance/training" className="btn btn-sm btn-primary">Send training</Link>
          <Link href="/staff" className="btn btn-sm">Manage staff</Link>
        </>
      }
      subtitle={
        m.gaps === 0
          ? `All ${m.rows.length} active staff are covered on every requirement.`
          : `${m.gaps} gap${m.gaps === 1 ? "" : "s"} across ${m.rows.length - m.covered} of ${m.rows.length} people. A gap is nothing on file, or lapsed — not merely approaching its date.`
      }
      className="mb-6"
    >
      {/* The grid is wider than a laptop on purpose — ten requirements is ten requirements — so it
          scrolls inside its own box rather than squeezing the columns until nothing is readable. */}
      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[62rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="py-2 pr-3 font-semibold">Person</th>
              {m.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-1 py-2 font-semibold" title={c.label}>{c.short}</th>
              ))}
              <th className="py-2 pl-2 text-right font-semibold">Gaps</th>
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r: MatrixRow) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="py-2 pr-3 whitespace-nowrap">
                  <Link href={`/staff/${r.id}`} className="font-medium text-accent hover:underline">{r.name}</Link>
                  <div className="text-xs text-ink-3">
                    {PERSON_ROLE_LABEL[r.role as keyof typeof PERSON_ROLE_LABEL] ?? r.role}{r.isPic ? " · PIC" : ""}
                  </div>
                </td>
                {m.columns.map((c) => (
                  <td key={c.key} className="px-1 py-2 align-top"><CellBadge cell={r.cells[c.key]} /></td>
                ))}
                <td className="py-2 pl-2 text-right">
                  {r.gaps === 0 ? (
                    <span className="badge badge-ok">clear</span>
                  ) : (
                    <span className="badge badge-crit">{r.gaps}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        Hover any cell for the date and where it came from. &ldquo;—&rdquo; means the requirement does not apply to
        that person. Training sends from here: the cell then says when it went out and offers the follow-up. Licence
        and CPR gaps are fixed on the person&rsquo;s own page — click their name.
      </p>
    </Card>
  );
}

/**
 * One cell of the staff board.
 *
 * Where the cell is a gap the site can do something about, the cell is the control: send it, and
 * afterwards the same cell says when it went and offers the follow-up. A grid that only reports
 * makes you go and find the screen that acts, and the going is where the work stops happening.
 */
function CellBadge({ cell }: { cell: Cell }) {
  if (cell.state === "na") return <span className="text-xs text-ink-3" title={cell.title}>—</span>;
  const cls =
    cell.state === "missing" || cell.state === "late" ? "badge-crit" : cell.state === "soon" ? "badge-warn" : "badge-ok";
  const badge = <span className={`badge ${cls}`} title={cell.title}>{cell.label}</span>;
  if (!cell.action) return badge;

  const { trainingType, personId, sentOn, reminders, sendError } = cell.action;
  return (
    <div className="w-[5.5rem]">
      {badge}
      {sentOn || sendError ? (
        <>
          <div className="mt-1 text-[11px] leading-tight text-ink-3">
            {sendError ? <span className="text-crit">{sendError}</span> : <>sent {sentOn}</>}
            {reminders > 0 && <> · {reminders} reminder{reminders === 1 ? "" : "s"}</>}
          </div>
          <form action={sendTrainingAction} className="mt-1">
            <input type="hidden" name="personId" value={personId} />
            <input type="hidden" name="trainingType" value={trainingType} />
            <input type="hidden" name="followUp" value="1" />
            <input type="hidden" name="back" value="/" />
            <button className="btn btn-sm w-full px-1">Follow up</button>
          </form>
        </>
      ) : (
        <form action={sendTrainingAction} className="mt-1">
          <input type="hidden" name="personId" value={personId} />
          <input type="hidden" name="trainingType" value={trainingType} />
          <input type="hidden" name="back" value="/" />
          <button className="btn btn-sm btn-primary w-full px-1">Send</button>
        </form>
      )}
    </div>
  );
}

/** How long ago, in the words a person would use. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(h)) return "never";
  if (h < 1) return "just now";
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/**
 * What is running without being asked.
 *
 * Last, and deliberately understated — it is reassurance, not work. It earns its place because
 * the one failure mode of automating compliance is that a job stops and its silence is
 * indistinguishable from having nothing to do.
 */
function AutomationStrip({ jobs }: { jobs: JobStatus[] }) {
  return (
    <details className="card">
      <summary className="cursor-pointer text-lg font-semibold">
        Running by itself{" "}
        <span className="text-sm font-normal text-ink-3">
          — {jobs.filter((j) => j.state === "ok").length} of {jobs.length} reporting in
        </span>
      </summary>
      <ul className="mt-3 divide-y divide-line">
        {jobs.map((j) => (
          <li key={j.key} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <Link href={j.href} className="text-sm font-medium hover:text-accent hover:underline">{j.label}</Link>
              <p className="text-xs text-ink-3">{j.detail}</p>
            </div>
            <span
              className={`badge whitespace-nowrap ${
                j.state === "stale" ? "badge-crit" : j.state === "never" ? "badge-warn" : j.state === "off" ? "badge-muted" : "badge-ok"
              }`}
            >
              {j.state === "off" ? "off" : j.state === "never" ? "not yet run" : ago(j.lastAt)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
