import Link from "next/link";
import { cqiSnapshot, csInventoryStatus } from "@/lib/compliance";
import { dueList } from "@/lib/due";
import { complianceSummary, type OpenItem } from "@/lib/compliance-status";
import { staffMatrix, type Cell, type MatrixRow, type StaffMatrix } from "@/lib/staff-matrix";
import { automationStatus, type JobStatus } from "@/lib/automation-status";
import { attestAction, answerAction } from "./_actions/compliance";
import { daysUntil, fmt, fmtLong, todayIso } from "@/lib/dates";
import { PERSON_ROLE_LABEL } from "@/lib/labels";
import { PageHeader, Notice } from "@/components/ui";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

/**
 * The one screen a pharmacist-in-charge should be able to trust.
 *
 * It answers three questions in this order and nothing else: what is actually wrong right now,
 * is my staff covered, and is the machinery still running. Everything that used to be here and
 * is not one of those three — counts of documents on file, a tile repeating a number shown two
 * inches below it, a duty for the month we are still in dressed up as a deadline — has gone,
 * because a screen with nine panels teaches you to read none of them.
 *
 * The hard rule underneath it: nothing appears in red until it is genuinely late. A duty for
 * September is not a September problem, and being told on the third of the month that the month
 * is not finished is precisely how a compliance screen earns the right to be ignored.
 */

type Tone = "crit" | "warn" | "muted";

type Row = {
  key: string;
  title: string;
  why: string;
  badge: string;
  tone: Tone;
  href: string;
  /** Set where the whole duty is one sentence and one click, so it can be closed from here. */
  attest?: { obligationId: string; periodKey: string; statement: string; minutes: number | null };
};

const fromOpenItem = (i: OpenItem): Row => ({
  key: `${i.obligationId}-${i.periodKey}`,
  title: i.title,
  why:
    i.state === "partial"
      ? `${i.periodLabel} — ${i.have} of ${i.expected} filed. ${i.missing ?? ""}`.trim()
      : `${i.periodLabel} — ${i.missing ?? i.detail ?? "Nothing was filed for this period."}`,
  badge: i.state === "partial" ? "part done" : `${i.daysLate}d late`,
  tone: i.state === "missed" ? "crit" : "warn",
  href: i.href ?? "/compliance",
  attest:
    i.kind === "attest" && i.statement
      ? { obligationId: i.obligationId, periodKey: i.periodKey, statement: i.statement, minutes: i.minutes }
      : undefined,
});

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { ok, error } = await searchParams;
  const [compliance, dated, matrix, cqi, cs, jobs] = await Promise.all([
    complianceSummary(),
    dueList({ horizonDays: 60 }),
    staffMatrix(),
    cqiSnapshot(),
    csInventoryStatus(),
    automationStatus(),
  ]);

  // ── What is actually wrong right now ──────────────────────────────
  const now: Row[] = [
    ...compliance.missed.map(fromOpenItem),
    ...compliance.partial.map(fromOpenItem),
    ...dated
      .filter((d) => d.severity === "overdue" || d.severity === "no_date")
      .map((d) => ({
        key: d.id,
        title: d.title,
        why: d.action,
        badge: d.daysLeft === null ? "nothing on file" : `${Math.abs(d.daysLeft)}d late`,
        tone: (d.daysLeft === null ? "warn" : "crit") as Tone,
        href: d.href,
      })),
  ];

  const cqiDays = daysUntil(cqi.dueOn)!;
  const cqiFiled = cqi.status === "final";
  if (!cqiFiled && cqiDays < 0) {
    now.push({
      key: "cqi",
      title: `CQI summary — ${cqi.label}`,
      why: `${cqi.incidentCount} incident${cqi.incidentCount === 1 ? "" : "s"} in the period. Currently ${cqi.status}.`,
      badge: `${-cqiDays}d late`,
      tone: "crit",
      href: cqi.summaryId ? `/cqi/summaries/${cqi.summaryId}` : "/cqi",
    });
  }

  const csDays = cs.dueOn ? daysUntil(cs.dueOn) : null;
  if (cs.dueOn === null || (csDays !== null && csDays < 0)) {
    now.push({
      key: "cs-inventory",
      title: "Annual controlled substance inventory",
      why: cs.last ? `Last taken ${fmt(cs.last)}. A year and ten days is the outside limit.` : "None has ever been recorded here.",
      badge: csDays === null ? "none on file" : `${-csDays}d late`,
      tone: csDays === null ? "warn" : "crit",
      href: "/inventory",
    });
  }

  // ── What is coming, quietly ───────────────────────────────────────
  const soon: Row[] = [
    ...dated
      .filter((d) => d.severity === "due_soon")
      .map((d) => ({
        key: d.id,
        title: d.title,
        why: d.action,
        badge: `${d.daysLeft}d`,
        tone: "muted" as Tone,
        href: d.href,
      })),
    ...compliance.openNow.map((i) => ({
      key: `${i.obligationId}-${i.periodKey}`,
      title: i.title,
      why: `${i.periodLabel}. Not late, and will not count against you until the period ends.`,
      badge: `due ${fmt(i.dueOn)}`,
      tone: "muted" as Tone,
      href: i.href ?? "/compliance",
      attest:
        i.kind === "attest" && i.statement
          ? { obligationId: i.obligationId, periodKey: i.periodKey, statement: i.statement, minutes: i.minutes }
          : undefined,
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
  soon.sort((a, b) => a.badge.localeCompare(b.badge));

  const stalled = jobs.filter((j) => j.state === "stale");

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={fmtLong(todayIso())}
        actions={<Link href="/compliance" className="btn">Compliance</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/* ── The headline. One sentence, and it is either good news or a number. ── */}
      {now.length === 0 ? (
        <section className="card mb-6 border-accent">
          <h2 className="text-lg font-semibold text-accent">Nothing is late.</h2>
          <p className="mt-1 text-sm text-ink-2">
            Every compliance period that has ended is covered, every licence and training is current, and no record is
            sitting here without a date on it.
            {soon.length > 0 && ` ${soon.length} thing${soon.length === 1 ? " is" : "s are"} coming up — none of it late.`}
          </p>
        </section>
      ) : (
        <section className="card mb-6 border-crit">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-crit">
                {now.length} thing{now.length === 1 ? "" : "s"} {now.length === 1 ? "is" : "are"} late
              </h2>
              <p className="mt-1 text-sm text-ink-2">
                Only what has actually passed its date. Nothing on this list is a warning about the future.
              </p>
            </div>
            <Link href="/compliance" className="btn btn-primary">Work through them</Link>
          </div>
        </section>
      )}

      {stalled.length > 0 && (
        <section className="card mb-6 border-warn">
          <h2 className="font-semibold text-warn">
            {stalled.length === 1 ? "Something the site does for you has stopped" : `${stalled.length} things the site does for you have stopped`}
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            {stalled.map((j) => j.label).join(", ")}. A job that quietly stops looks exactly like one with nothing to
            do, which is why it is said here rather than left at the bottom of the page.
          </p>
        </section>
      )}

      {now.length > 0 && <RowList title="Needs you now" rows={now} />}

      {/* ── Is my staff covered ──────────────────────────────────────── */}
      <StaffBoard m={matrix} />

      {soon.length > 0 && <RowList title="Coming up" rows={soon} subtitle="Nothing here is late. It is listed so it does not become a surprise." quiet />}

      {compliance.unanswered.length > 0 && (
        <section className="card mb-6">
          <h2 className="font-semibold">Does this apply here?</h2>
          <p className="mt-1 text-sm text-ink-2">
            {compliance.unanswered.length} duty{compliance.unanswered.length === 1 ? "" : " duties"} the site cannot decide
            for you. Answering takes a click each and stops them sitting in the register unresolved. Nothing here is
            counting against you until you say it applies.
          </p>
          <div className="mt-3 space-y-2">
            {compliance.unanswered.map((q) => (
              <div key={q.obligationId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-ground p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{q.title}</p>
                  {q.citation && <p className="text-xs text-ink-3">{q.citation}</p>}
                </div>
                <div className="flex gap-2">
                  <form action={answerAction}>
                    <input type="hidden" name="obligationId" value={q.obligationId} />
                    <input type="hidden" name="applies" value="yes" />
                    <input type="hidden" name="back" value="/" />
                    <button className="btn btn-primary">Yes, we do this</button>
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
        </section>
      )}

      <AutomationStrip jobs={jobs} />
    </>
  );
}

/**
 * A band of things needing attention.
 *
 * A licence, a training and a monthly duty render identically, because from where the PIC stands
 * they are the same kind of thing: something that needs doing. Where the whole duty is one
 * sentence, the sentence and its button are on the row — sending someone to another screen to
 * confirm one line is how a thirty-second job waits a fortnight.
 */
function RowList({ title, rows, subtitle, quiet }: { title: string; rows: Row[]; subtitle?: string; quiet?: boolean }) {
  return (
    <section className="card mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <Link href="/compliance" className="text-sm text-accent hover:underline">All compliance →</Link>
      </div>
      {subtitle && <p className="-mt-2 mb-3 text-xs text-ink-3">{subtitle}</p>}
      <ul className="divide-y divide-line">
        {rows.slice(0, quiet ? 8 : 15).map((r) => (
          <li key={r.key} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={r.href} className="text-sm font-medium text-ink hover:text-accent hover:underline">{r.title}</Link>
                <p className="mt-0.5 text-xs text-ink-2">{r.why}</p>
              </div>
              <span className={`badge ${r.tone === "crit" ? "badge-crit" : r.tone === "warn" ? "badge-warn" : "badge-muted"} whitespace-nowrap`}>
                {r.badge}
              </span>
            </div>
            {r.attest && (
              <form action={attestAction} className="mt-2 rounded-md border border-line bg-ground p-3">
                <input type="hidden" name="obligationId" value={r.attest.obligationId} />
                <input type="hidden" name="periodKey" value={r.attest.periodKey} />
                <input type="hidden" name="statement" value={r.attest.statement} />
                <input type="hidden" name="back" value="/" />
                <p className="text-xs italic text-ink-2">&ldquo;{r.attest.statement}&rdquo;</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button className="btn btn-primary">Confirm and record</button>
                  <span className="text-xs text-ink-3">
                    Recorded word for word, with your name and today&rsquo;s date
                    {r.attest.minutes !== null && ` · about ${r.attest.minutes} min of actual work`}.
                  </span>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
      {rows.length > (quiet ? 8 : 15) && (
        <p className="mt-2 text-xs text-ink-3">
          <Link href="/compliance" className="underline">and {rows.length - (quiet ? 8 : 15)} more</Link>
        </p>
      )}
    </section>
  );
}

/**
 * Who is missing what.
 *
 * The question an inspector asks is not "what is overdue", it is "show me that your staff are
 * trained and licensed". That is a person-by-requirement question and only a grid answers it in
 * one look. An empty cell here is a finding; a cell that is merely approaching its date is not,
 * and is not coloured as though it were.
 */
function StaffBoard({ m }: { m: StaffMatrix }) {
  if (m.rows.length === 0) {
    return (
      <section className="card mb-6">
        <h2 className="font-semibold">Staff compliance</h2>
        <p className="mt-1 text-sm text-ink-3">
          No active staff yet. <Link href="/staff/new" className="text-accent underline">Add the first person</Link> and this
          becomes the board you show an inspector.
        </p>
      </section>
    );
  }
  return (
    <section className="card mb-6">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Staff compliance</h2>
        <Link href="/staff" className="text-sm text-accent hover:underline">Manage staff →</Link>
      </div>
      <p className="mb-3 text-xs text-ink-3">
        {m.gaps === 0
          ? `All ${m.rows.length} active staff are covered on every requirement.`
          : `${m.gaps} gap${m.gaps === 1 ? "" : "s"} across ${m.rows.length - m.covered} of ${m.rows.length} people. A gap means nothing on file, or lapsed — not merely approaching its date.`}
      </p>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="text-left">Person</th>
              {m.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap text-left text-xs" title={c.label}>{c.short}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r: MatrixRow) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  <Link href={`/staff/${r.id}`} className="font-medium text-accent hover:underline">{r.name}</Link>
                  <div className="text-xs text-ink-3">
                    {PERSON_ROLE_LABEL[r.role as keyof typeof PERSON_ROLE_LABEL] ?? r.role}{r.isPic ? " · PIC" : ""}
                  </div>
                </td>
                {m.columns.map((c) => (
                  <td key={c.key}><CellBadge cell={r.cells[c.key]} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        Hover any cell for the date and where it came from. &ldquo;—&rdquo; means the requirement does not apply to that
        person.
      </p>
    </section>
  );
}

function CellBadge({ cell }: { cell: Cell }) {
  if (cell.state === "na") return <span className="text-xs text-ink-3" title={cell.title}>—</span>;
  const cls =
    cell.state === "missing" || cell.state === "late" ? "badge-crit" : cell.state === "soon" ? "badge-warn" : "badge-ok";
  return <span className={`badge ${cls} whitespace-nowrap`} title={cell.title}>{cell.label}</span>;
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
    <section className="card">
      <h2 className="font-semibold">Running by itself</h2>
      <p className="mt-1 text-xs text-ink-3">
        These happen without you. If one stops, it says so here rather than going quiet.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {jobs.map((j) => (
          <li key={j.key} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <Link href={j.href} className="text-sm font-medium text-ink hover:text-accent hover:underline">{j.label}</Link>
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
    </section>
  );
}
