import Link from "next/link";
import { Suspense } from "react";
import { cqiSnapshot, csInventoryStatus } from "@/lib/compliance";
import { dueList, type DueItem } from "@/lib/due";
import { complianceSummary, type OpenItem } from "@/lib/compliance-status";
import { staffMatrix } from "@/lib/staff-matrix";
import { StaffBoard } from "@/components/staff-board";
import { invoiceIssues } from "@/lib/invoices";
import { dailyCheck } from "@/lib/daily-check-store";
import { alerts, SOON_DAYS, type Alert } from "@/lib/alerts";
import { claimsProofNow } from "@/lib/data-health-claims-proof-store";
import { claimsProofAlert } from "@/lib/data-health-claims-proof";
import { automationStatus, type JobStatus } from "@/lib/automation-status";
import { feedsNow } from "@/lib/feeds";
import { openFindings } from "@/lib/self-inspection";
import { attestAction, answerAction } from "../_actions/compliance";
import { daysUntil, fmt, fmtLong, todayIso } from "@/lib/dates";
import { getSettings } from "@/lib/settings";
import { mailHealth } from "@/lib/mail-health";
import { pendingUpdates } from "@/lib/updates";
import { booksFor } from "@/lib/ledger-store";
import { db, schema } from "@/db";
import { desc, isNotNull } from "drizzle-orm";
import { parsePeriod } from "@/lib/ledger";
import { contractClocksDue } from "@/lib/contract-docs";
import { formatCents } from "@/lib/money";
import { requireUser } from "@/lib/auth";
import { Notice, Card, Figure, PageHeader } from "@/components/ui";
import { AttestForm } from "@/components/attest-form";

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
  // The signer's own name, to fill in the attestation form without asking them to remember it.
  const user = await requireUser();
  const [compliance, dated, matrix, cqi, cs, jobs, selfFindings, settings, mail, updates, invoiceProblems, alertList, clocks, claimsProof, health] =
    await Promise.all([
    complianceSummary(),
    dueList({ horizonDays: 60 }).then((d) => d.filter((x) => !String((x as { id?: string }).id ?? "").startsWith("cred-missing-pharmacy-"))),
    staffMatrix(),
    cqiSnapshot(),
    csInventoryStatus(),
    automationStatus(),
    openFindings(),
    getSettings(),
    mailHealth(),
    pendingUpdates(),
    invoiceIssues(),
    alerts(),
    /*
     * The money figures are not here. Each is read by its own section below, inside a Suspense
     * boundary, so the rest of the page is sent while they are worked out. Before, this list waited
     * for all of them together: after any new file, money found alone was nineteen seconds from cold
     * (measured 15 September 2026), and a lapsed licence could not be seen for as long as that took.
     */
    // Contract deadlines with a date on them, so a renewal window is on the same list as a licence.
    contractClocksDue(90).catch(() => [] as Awaited<ReturnType<typeof contractClocksDue>>),
    /*
     * The claims proof, read back from what the nightly script left behind.
     *
     * A settings read and nothing else — the proving itself happens in a process of its own each
     * night, because re-reading every stored daily report is exactly the kind of work that must
     * never happen on the thread answering this page.
     */
    claimsProofNow().catch(() => null),
    /*
     * The morning check. Six counts and two dates, so it is cheap enough to run on a page load, and
     * it is the same function the nightly pass calls — this page and that record cannot disagree.
     */
    dailyCheck().catch(() => ({ checks: [], failing: 0, says: "", ranAt: "" })),
  ]);

  /*
   * Details that print on Board forms.
   *
   * Missing, they do not break anything visibly — the C-250 and the C-900 just go out with a
   * blank where the registration number belongs, and nobody notices until the form is in an
   * inspector's hand. So it is said once, at the top, until it is fixed.
   */
  const setup = ([
    ["pharmacy_name", "the pharmacy's name"],
    ["pharmacy_registration_number", "the Kansas registration number"],
    ["pharmacy_dea", "the DEA registration"],
    ["pharmacy_address", "the address"],
  ] as const).filter(([k]) => !settings[k]?.trim()).map(([, label]) => label);

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

  /*
    The invoice archive going wrong belongs here, not only on its own page.

    Its failures are silent by nature — the supplier changes the address they send from and the
    invoices stop, with no error anywhere and nothing to notice. A pharmacist who does not open
    that page for a month would find out during an inspection. So they sit with the rest of the
    late work, where the morning glance already goes.
  */
  for (const p of invoiceProblems) {
    latePharmacy.push({
      key: `invoice-${p.key}`,
      title: p.title,
      why: p.detail,
      badge: p.severity === "blocking" ? "fix this" : "look at",
      tone: p.severity === "blocking" ? "crit" : "warn",
      href: p.href ?? "/inventory/invoices",
    });
  }

  const lateCount = lateTraining.length + lateCredentials.length + latePharmacy.length;
  /* What the needs-you list already names is not drawn a second time in the late queue below it. */
  const nowTitles = new Set(alertList.filter((a) => a.level === "now").map((a) => a.title));

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

  for (const c of clocks) {
    const left = daysUntil(c.on!) ?? 0;
    soon.push({
      key: `clock-${c.pbmName}-${c.what}`,
      title: `${c.what} — ${c.pbmName}`,
      why: `${c.rule}.${c.consequence ? ` ${c.consequence}` : ""}`,
      badge: `due ${fmt(c.on)}`,
      tone: left <= 14 ? "warn" : "muted",
      href: c.href,
    });
  }
  const clocksNear = clocks.filter((c) => (daysUntil(c.on!) ?? 99) <= 14);

  const stalled = jobs.filter((j) => j.state === "stale");
  // The feeds the figures come from, judged from their own tables; the sensors and backup are already in `jobs`.
  const lateFeeds = (await feedsNow()).late.filter((f) => f.group === "arriving");

  /*
   * Everything wrong with the site itself, gathered into one list and ranked.
   *
   * These were five banners and two full cards, each writing its own paragraph. The prose was good
   * and there was far too much of it: on a bad morning it filled the screen before the scoreboard,
   * which is the opposite of what a dashboard is for. The reasons survive as the short clause after
   * each name — the rule being that a person should be able to tell in four words whether it is
   * their problem right now, and follow the link when it is.
   *
   * Ranked by what it costs to leave: a form going to the Board with a blank on it, then data that
   * has stopped arriving, then money that cannot be sent or chased, then housekeeping. A stale feed
   * is third from nothing because every figure downstream of it goes on looking right.
   */
  const attention: { what: string; detail: string | null; href: string; action: string; kind: "crit" | "warn" }[] = [];
  if (setup.length > 0) {
    attention.push({
      what: "The pharmacy's own details are missing",
      detail: `${setup.join(", ")} — a C-250 or C-900 handed over with a blank is a finding`,
      href: "/settings",
      action: "Fill them in once",
      kind: "crit",
    });
  }
  if (mail.state !== "ok") {
    attention.push({
      what: mail.summary,
      detail: mail.failed.length > 0 ? `last error: ${mail.failed[0].error}` : "configured is not the same as working",
      href: "/settings/email",
      action: mail.configured ? "Check and send a test" : "Set up sending",
      kind: mail.state === "unproven" ? "warn" : "crit",
    });
  }
  /*
   * A feed that has stopped, and a job that has stopped, which were two crit cards of their own.
   *
   * Both are the same sentence — something that should be happening is not — and both were taking a
   * full panel to say it. The feed one matters most of anything on this list: a report that stops
   * arriving does not blank a figure, it freezes one, so everything downstream goes on looking
   * exactly as right as it did yesterday. "Is everything arriving?" is now a page of its own, which
   * is where the detail belongs.
   */
  if (lateFeeds.length > 0) {
    attention.push({
      what: lateFeeds.length === 1 ? "A report the site runs on has stopped arriving" : `${lateFeeds.length} reports the site runs on have stopped arriving`,
      detail: `${lateFeeds.map((f) => `${f.label} (last ${f.lastAt ? f.lastAt.slice(0, 10) : "never"})`).join(", ")} — every figure downstream is going stale while still looking right`,
      href: "/expected",
      action: "What we're expecting",
      kind: "crit",
    });
  }
  if (stalled.length > 0) {
    attention.push({
      what: stalled.length === 1 ? "Something the site does for you has stopped" : `${stalled.length} things the site does for you have stopped`,
      detail: `${stalled.map((j) => j.label).join(", ")} — a job that quietly stops looks exactly like one with nothing to do`,
      href: "/tools/check",
      action: "The morning check",
      kind: "crit",
    });
  }
  if (clocksNear.length > 0) {
    attention.push({
      what: "A contract deadline falls within two weeks",
      detail: clocksNear.map((c) => `${c.what} with ${c.pbmName} by ${fmt(c.on)}`).join("; "),
      href: clocksNear[0].href,
      action: "See the clock",
      kind: "warn",
    });
  }
  if (health.failing > 0) {
    attention.push({
      what: health.failing === 1 ? "The morning check found something" : `The morning check found ${health.failing} things`,
      detail: health.checks.filter((c) => !c.ok).map((c) => `${c.what.toLowerCase()} — ${c.observed}`).join("; "),
      href: "/tools/check",
      action: "What each one means",
      kind: "warn",
    });
  }
  if (updates.behind > 0) {
    attention.push({
      what: `${updates.behind} update${updates.behind === 1 ? "" : "s"} waiting`,
      detail: updates.newest ? `newest is "${updates.newest}" — nothing changes here until it is installed` : "nothing changes here until they are installed",
      href: "/settings/updates",
      action: "Install now",
      kind: "warn",
    });
  }


  return (
    <>
      <PageHeader
        title="Today"
        subtitle={fmtLong(today)}
        /*
          Three buttons, and one of them only exists on a day with work on it.

          There were eight. Compliance, Training and Inbox are words in the bar above this one, so
          three of the eight were the navigation printed twice; "Finish setting up" is a job that
          finishes, and a permanent button for it is a permanent reproach. What is left is the two
          things done FROM this page rather than navigated to — the money list and the day's
          deliveries — and the one that appears only when something is late.

          The owner, of the site as a whole: "It looks very amateur." A row of eight buttons that
          wraps to three lines on a laptop is most of why.
        */
        actions={
          <>
            <Link href="/money" className="btn btn-primary">The books</Link>
            <Link href={`/deliveries?month=${today.slice(0, 7)}`} className="btn">Today&rsquo;s deliveries</Link>
            {lateCount > 0 && <Link href="#now" className="btn btn-primary">Work through {lateCount}</Link>}
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        Everything wrong with the site itself, in one block instead of five.

        There were five separate full-width banners stacked here — updates, mail, missing pharmacy
        details, a contract deadline, the morning check — each a paragraph of prose explaining itself
        at length. On a bad morning the first actual figure on this page was below the fold, and the
        owner's verdict on the whole site was 'It looks very amateur'. Five paragraphs of apology
        before a single number is most of what he meant.

        One block, one line each, worst first. The reason each matters is still written — it has
        just stopped being the thing you read before you can see your own scoreboard.
      */}
      {attention.length > 0 && (
        <Notice kind={attention.some((a) => a.kind === 'crit') ? 'crit' : 'warn'}>
          <b>{attention.length === 1 ? "One thing needs attention" : `${attention.length} things need attention`}</b>
          <ul className="mt-1 space-y-0.5">
            {attention.map((a) => (
              <li key={a.what} className="text-sm">
                <span className="font-medium">{a.what}</span>
                {a.detail && <span className="text-ink-2"> — {a.detail}</span>}{' '}
                <Link href={a.href} className="underline">{a.action}</Link>
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {/*
        Where the money stands, before anything else on the page.

        The rest of this screen protects revenue by keeping the pharmacy out of trouble. These three
        figures are the revenue itself, and they are the three levers there are: the ratio picks the
        band, the band prices every generic bought today, and the facilitator owes what it owes.
        A pharmacist who reads nothing else should still know, by lunchtime, whether the ratio moved,
        what this month's buying is earning, and whether the money that was promised has arrived.

        Each is a position, not a settlement — the drill down arrives daily and the statement a month
        later. Where a link in the chain is missing the card says which link and where to fix it,
        because the alternative is a confident zero that somebody prices an order against.
      */}
      <Suspense fallback={<Pending title="This month so far" note="Reading the books…" tall />}>
        <Scoreboard today={today} />
      </Suspense>

      {/*
        The three things worth the most, before anything that is merely due.

        The scoreboard says how the month stands; this says what to do about it. Three, not the
        whole list, because the whole list is a page of its own and the point here is that a
        pharmacist who reads nothing else knows the one action worth the most this morning.
      */}
      {/* Retired 2 October 2026 (src/lib/retired.ts): money found and money waiting are outside the six things the site is for. */}

      {/*
        Money already earned and waiting on somebody, which is a different question from the list above.
        "Worth the most" is money to go and make; this is money the pharmacy has made and not been paid.
        Three lines and the total, because the whole list is a page of its own.
      */}

      {/*
        Two levels, and nothing else on the screen shouts.

        The old list showed everything due inside sixty days, which is not an alert list — it is
        an inventory of the future. A licence expiring in eight weeks sat in red beside one that
        expired last Tuesday, and the result of that is not vigilance: it is a screen nobody
        reads, which is worse than no screen.

        Now means the pharmacy is exposed today and somebody could be asked to explain it this
        afternoon. Soon means it needs doing this month and takes weeks to do. Everything else
        stays on its own page, so that these two keep meaning something.
      */}
      {/* ── The four numbers. Large, because this is the question asked from the doorway. ── */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
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
        {/*
          "Coming up" was a fourth tile here and is gone.

          Its own subtitle read "none of it late" — a tile that is green by definition, whose number
          only ever means "the future exists", pointing at a collapsed panel further down the same
          page. Three tiles that can turn red are a scoreboard; a fourth that cannot is furniture,
          and furniture is what makes a dashboard read as amateur. The panel itself is still there.
        */}
      </div>

      {(() => {
        /*
          The claims disagreeing with the reports they came from, which outranks everything here.

          The owner's words: "these things need to be right!! we need to make sure claims are
          matching their info properly and continue to … this is the most important thing." Every
          money figure on this site starts at the claims, so a claim that disagrees with the report
          it was read from is not one wrong row — it is a reason to stop believing the scoreboard
          above it until somebody has looked.

          "Now", always, and never "soon". There is no version of this worth reading next month,
          and the proof is silent on every night it finds nothing, so a row appearing here at all
          means something changed.
        */
        const proofWarning = claimsProofAlert(claimsProof);
        const proofAlert: Alert[] = proofWarning
          ? [{ key: "claims-proof", level: "now", ...proofWarning, href: "/money", action: "See the checks" }]
          : [];
        const extra = [...proofAlert];
        const now = [...alertList, ...extra].filter((a) => a.level === "now");
        const soon = [...alertList, ...extra].filter((a) => a.level === "soon");
        if (now.length === 0 && soon.length === 0) {
          return (
            <Card tone="ok" title="Nothing needs you today" className="mb-6">
              <p className="card-sub">
                Nothing has expired, lapsed or stopped running, and nothing falls due in the next {SOON_DAYS} days.
                What is further out is on its own page rather than here.
              </p>
            </Card>
          );
        }
        return (
          <>
            {now.length > 0 && (
              <Card
                id="now"
                tone="crit"
                title="Needs you today"
                count={now.length}
                subtitle="Each of these is something the pharmacy is exposed on right now — expired, lapsed, missed, or stopped working."
                className="mb-4"
              >
                <ul className="rows">
                  {now.map((a) => (
                    <li key={a.key} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                      <span className="min-w-0">
                        <Link href={a.href} className="text-sm font-medium text-accent hover:underline">{a.title}</Link>
                        <Why text={a.why} />
                      </span>
                      <Link href={a.href} className="btn btn-sm btn-primary shrink-0">{a.action ?? "Fix it"}</Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {soon.length > 0 && (
              /*
                Folded shut on purpose. These are real and they are not today's problem, and
                putting them on screen next to the expired ones is exactly what taught everybody
                to stop reading the expired ones.
              */
              <details className="mb-6" open={now.length === 0}>
                <summary className="cursor-pointer text-sm font-medium text-accent">
                  {soon.length} more within {SOON_DAYS} days — renewals and rounds that take weeks
                </summary>
                <Card className="mt-2">
                  <ul className="rows">
                    {soon.map((a) => (
                      <li key={a.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                        <span className="min-w-0">
                          <Link href={a.href} className="text-sm hover:underline">{a.title}</Link>
                          <Why text={a.why} />
                        </span>
                        <Link href={a.href} className="btn btn-sm shrink-0">{a.action ?? "Open"}</Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              </details>
            )}
          </>
        );
      })()}

      {/*
        Is my staff covered — second, and prominent, because it is the question an inspector asks
        and the only view that answers it in one look.

        It was briefly moved off this page on a misreading, and it belongs here: the list above
        names what is late one thing at a time, and this says whether the people are covered. The
        overlap is the point rather than the problem — one is a queue of work, the other is the
        board you turn round to show somebody.
      */}
      <StaffBoard m={matrix} back="/" />

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
                  </div>
                </div>
                {/*
                  Signing it from here, rather than a button that records a click.

                  The statement is the evidence and has to be read before it is agreed to, so the
                  form opens rather than sitting inline on a dashboard row — and it carries the two
                  deliberate acts an electronic signature needs. Still done from where the duty is
                  seen: being sent to another screen to sign one sentence is exactly the friction
                  that leaves duties open for a fortnight.
                */}
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-accent hover:underline">
                    Sign it — read what gets recorded
                  </summary>
                  <AttestForm
                    action={attestAction}
                    obligationId={r.attest!.obligationId}
                    periodKey={r.attest!.periodKey}
                    statement={r.attest!.statement}
                    back="/"
                    defaultName={user.name}
                  />
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
          /*
            One queue, banded — not three cards.

            Training, licences and pharmacy duties were a card each, with their own heading, their
            own count and their own button. Three panels, all answering the same question: what is
            late and what do I do about it. On a morning with one item in each, that was three
            bordered boxes holding three rows between them, and the eye has to start again at every
            border.

            Banded inside one card instead, worst first, each band naming where the work is done.
            The same rows, the same counts, the same links out — one object to read instead of three.
          */
          <LateQueue
            bands={[
              { title: "Pharmacy duties", rows: latePharmacy.filter((r) => !r.attest && !nowTitles.has(r.title)), href: "/compliance", label: "Compliance" },
              { title: "Licences and credentials", rows: lateCredentials.filter((r) => !nowTitles.has(r.title)), href: "/staff", label: "Staff" },
              { title: "Training", rows: lateTraining.filter((r) => !nowTitles.has(r.title)), href: "/compliance/training", label: "Send training" },
            ]}
          />
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
 * Everything late, in one card, banded by where the work gets done.
 *
 * This was three separate cards, one per band, each with its own heading, count and button. The
 * owner's verdict on the site was that it is busy and reads as amateur, and three bordered boxes
 * holding three rows between them is a good part of what that looks like: the eye has to start
 * again at every border, and nothing tells it which box matters more.
 *
 * The banding itself is kept, because those are three different afternoons — sending training out,
 * chasing paperwork off individual people, and duties only the PIC can discharge — and a single
 * list sorted by days late interleaves all three and makes every one of them feel unfinished. What
 * changed is that they are now bands inside one object rather than three objects, worst first, and
 * an empty band is dropped rather than drawn.
 */
function LateQueue({ bands }: { bands: { title: string; rows: Row[]; href: string; label: string }[] }) {
  const live = bands.filter((b) => b.rows.length > 0);
  if (live.length === 0) return null;
  const total = live.reduce((n, b) => n + b.rows.length, 0);
  return (
    <Card title="Late" count={total}>
      <div className="divide-y divide-line">
        {live.map((b) => (
          <div key={b.title} className="py-2.5 first:pt-0 last:pb-0">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
                {b.title} <span className="font-normal tabular-nums">({b.rows.length})</span>
              </h3>
              <Link href={b.href} className="text-xs text-accent hover:underline">{b.label}</Link>
            </div>
            <BandRows rows={b.rows} href={b.href} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function BandRows({ rows, href }: { rows: Row[]; href: string }) {
  return (
    <>
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
        <p className="mt-2 text-xs text-ink-3">
          <Link href={href} className="underline">and {rows.length - 10} more</Link>
        </p>
      )}
    </>
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

/**
 * The month to date, sent after the rest of the page.
 *
 * Its two readings are the heaviest on Today — the dispensing position and the books — and neither
 * decides whether anything is late. Streamed in its own boundary, the checklist above and below it
 * is on screen while these are worked out, and a failure here costs this section, not the page.
 */
/**
 * The month so far, from the books the engine stored, and the bank's last proven balance. Four figures, one fact
 * each. The buying levers that stood here — the ratio, the rebates earned, the facilitator's money — went with the
 * buying pages on 2 October 2026; what remains is what he asked to see from the doorway.
 */
async function Scoreboard({ today }: { today: string }) {
  const month = today.slice(0, 7);
  const [books, proven] = await Promise.all([
    booksFor(parsePeriod(month)!).catch(() => null),
    db.query.monthStatus.findFirst({ where: isNotNull(schema.monthStatus.bankClosingCents), orderBy: [desc(schema.monthStatus.month)] }).catch(() => null),
  ]);
  const a = books?.accrual ?? null;
  const dayOfMonth = Number(today.slice(8, 10));
  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">This month so far</h2>
        <span className="text-xs text-ink-3">
          day {dayOfMonth} · <Link href="/money" className="text-accent underline">the books</Link>
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={a ? formatCents(a.netRevenueCents) : "—"} label="Net revenue" sub={a ? "earned at pickup" : "no account yet"} tone="muted" href="/money" />
        <Figure value={a ? formatCents(a.grossProfitCents) : "—"} label="Gross profit" sub={a && a.grossMarginPercent !== null ? `${a.grossMarginPercent}% of net revenue` : "cost of goods not known"} tone={a && a.grossProfitCents < 0 ? "crit" : "ok"} href="/money" />
        <Figure value={a ? formatCents(a.netProfitCents) : "—"} label={a && a.netProfitCents < 0 ? "Net loss so far" : "Net profit so far"} sub={a ? (a.missing.length ? `${a.missing.length} line${a.missing.length === 1 ? "" : "s"} still to come` : "every line in") : "no account yet"} tone={a && a.netProfitCents < 0 ? "crit" : "ok"} href="/money" />
        <Figure value={proven?.bankClosingCents !== null && proven?.bankClosingCents !== undefined ? formatCents(proven.bankClosingCents) : "—"} label="Cash in bank" sub={proven ? `proven to the end of ${proven.month}` : "no statement read yet"} tone="muted" href={proven ? `/money/bank-review?month=${proven.month}` : "/money/bank-review"} />
      </div>
    </section>
  );
}

/** One sentence at rest; the rest behind a press. The owner, 2 October 2026: "I get a headache looking at this site and trying to read all the paragraphs and words." */
function Why({ text }: { text: string }) {
  const whole = text.replace(/\s+/g, " ").trim();
  const first = whole.split(/(?<=\.)\s/)[0];
  if (first.length >= whole.length) return <span className="mt-0.5 block text-xs text-ink-3">{whole}</span>;
  return (
    <details className="mt-0.5 text-xs text-ink-3">
      <summary className="cursor-pointer list-none">
        {first} <span className="text-accent">more</span>
      </summary>
      <span className="block pt-1">{whole}</span>
    </details>
  );
}

function Pending({ title, note, tall = false }: { title: string; note: string; tall?: boolean }) {
  return (
    <section className="mb-6" aria-busy="true">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-ink-3">{note}</span>
      </div>
      <div className={`grid gap-3 sm:grid-cols-2 ${tall ? "lg:grid-cols-5" : "lg:grid-cols-3"}`}>
        {Array.from({ length: tall ? 5 : 3 }, (_, i) => (
          <div key={i} className={`card animate-pulse motion-reduce:animate-none ${tall ? "h-28" : "h-32"}`} />
        ))}
      </div>
    </section>
  );
}

/**
 * Money earned and not yet paid: the three largest pots, and what each is waiting for.
 *
 * Streamed like the others, and silent where nothing is waiting. The full list is /payers/waiting; this is the glance
 * that says whether anything needs chasing before the day starts.
 */
