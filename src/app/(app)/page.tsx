import Link from "next/link";
import { cqiSnapshot, csInventoryStatus } from "@/lib/compliance";
import { dueList, type DueItem } from "@/lib/due";
import { complianceSummary, type OpenItem } from "@/lib/compliance-status";
import { staffMatrix } from "@/lib/staff-matrix";
import { StaffBoard } from "@/components/staff-board";
import { invoiceIssues } from "@/lib/invoices";
import { alerts, SOON_DAYS } from "@/lib/alerts";
import { automationStatus, type JobStatus } from "@/lib/automation-status";
import { feedsNow } from "@/lib/feeds";
import { openFindings } from "@/lib/self-inspection";
import { attestAction, answerAction } from "./_actions/compliance";
import { daysUntil, fmt, fmtLong, todayIso } from "@/lib/dates";
import { getSettings } from "@/lib/settings";
import { mailHealth } from "@/lib/mail-health";
import { pendingUpdates } from "@/lib/updates";
import { moneyPosition } from "@/lib/money-position";
import { moneyFound } from "@/lib/money-found";
import { booksFor } from "@/lib/ledger-store";
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
  const [compliance, dated, matrix, cqi, cs, jobs, selfFindings, settings, mail, updates, invoiceProblems, alertList, money, found, books, clocks] =
    await Promise.all([
    complianceSummary(),
    dueList({ horizonDays: 60 }),
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
    moneyPosition(),
    moneyFound().catch(() => null),
    /*
     * The month's bottom line so far, from the books: gross profit less the bills in and the
     * standing costs accrued to today. The scoreboard's other figures are dispensing; this is the
     * one that says whether the month is making money after the doors are kept open.
     */
    booksFor(parsePeriod(todayIso().slice(0, 7))!).catch(() => null),
    // Contract deadlines with a date on them, so a renewal window is on the same list as a licence.
    contractClocksDue(90).catch(() => [] as Awaited<ReturnType<typeof contractClocksDue>>),
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
  const net = books?.accrual ?? null;

  const stalled = jobs.filter((j) => j.state === "stale");
  // The feeds the figures come from, judged from their own tables; the sensors and backup are already in `jobs`.
  const lateFeeds = (await feedsNow()).late.filter((f) => f.group === "arriving");

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={fmtLong(today)}
        actions={
          <>
            {/*
              The one thing on this page that is about making money rather than keeping out of
              trouble. Everything else here protects revenue; this is where it is found.
            */}
            <Link href="/money/found" className="btn btn-primary">Where the money is</Link>
            <Link href="/compliance" className="btn">Compliance</Link>
            <Link href="/compliance/training" className="btn">Training</Link>
            {lateCount > 0 && <Link href="#now" className="btn btn-primary">Work through {lateCount}</Link>}
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        An update nobody knows about is an update nobody installs. This used to be discoverable
        only by opening a settings sub-page and pressing a button, so repairs sat on GitHub while
        the pharmacy went on hitting the bug they repaired and reporting it again.
      */}
      {updates.behind > 0 && (
        <Notice kind="warn">
          <b>
            {updates.behind} update{updates.behind === 1 ? "" : "s"} {updates.behind === 1 ? "is" : "are"} waiting to be
            installed.
          </b>{" "}
          {updates.newest && <>The newest is &ldquo;{updates.newest}&rdquo;. </>}
          Nothing on this computer changes until you install{" "}
          {updates.behind === 1 ? "it" : "them"}, so a fix made for you is not in front of you yet.{" "}
          <Link href="/settings/updates" className="underline">Install now</Link>.
        </Notice>
      )}

      {/*
        Every "Send" on this page goes through the mail server, so its state belongs on this page
        rather than three clicks away under Settings. The distinction the old wording missed:
        configured is not working. A Gmail address with the account password rather than an app
        password is configured, cannot send anything, and looked fine everywhere.
      */}
      {mail.state !== "ok" && (
        <Notice kind={mail.state === "unproven" ? "warn" : "crit"}>
          <b>{mail.summary}</b>{" "}
          {mail.failed.length > 0 && (
            <>
              The last error was: <i>{mail.failed[0].error}</i>{" "}
            </>
          )}
          <Link href="/settings/email" className="underline">
            {mail.configured ? "Check the mail settings and send yourself a test" : "Set up sending"}
          </Link>
          .
        </Notice>
      )}

      {setup.length > 0 && (
        <Notice kind="crit">
          Every Board form this site prints carries the pharmacy&rsquo;s own details, and{" "}
          {setup.length === 1 ? "one is" : `${setup.length} are`} missing: {setup.join(", ")}. A C-250 or a C-900
          handed over with a blank where the registration number belongs is a finding.{" "}
          <Link href="/settings" className="underline">Fill them in once</Link> and every form is right from then on.
        </Notice>
      )}

      {clocksNear.length > 0 && (
        <Notice kind="warn">
          <b>A contract deadline falls within two weeks:</b>{" "}
          {clocksNear.map((c) => `${c.what} with ${c.pbmName} by ${fmt(c.on)}`).join("; ")}.{" "}
          <Link href={clocksNear[0].href} className="underline">See the clock</Link>.
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
      <section className="mb-6">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Scoreboard</h2>
          <span className="text-xs text-ink-3">
            Month to date · {fmtLong(today)} · <Link href="/money" className="text-accent underline">the books</Link>
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {/*
            What was dispensed and what it made — prescriptions only.

            The transaction report does not carry front-of-shop merchandise, so this is not the
            whole till and does not pretend to be. Cash fills are in it: a bottle the pharmacy
            priced itself is revenue like any other, and for months they were thrown away on import,
            which silently deleted the margin on the only business the pharmacy fully controls.
          */}
          <Figure
            value={formatCents(money.dispensing.marginCents)}
            label="Gross profit this month"
            tone={money.dispensing.marginCents < 0 ? "crit" : "ok"}
            href="/claims"
            sub={
              money.dispensing.fills === 0
                ? "No fills loaded for this month yet."
                : [
                    `on ${formatCents(money.dispensing.revenueCents)} dispensed across ${money.dispensing.fills.toLocaleString()} fills`,
                    money.dispensing.cashFills > 0
                      ? `${formatCents(money.dispensing.cashMarginCents)} of it from cash`
                      : null,
                    money.dispensing.promisedCents > 0
                      ? `${formatCents(money.dispensing.promisedCents)} promised and unpaid`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
            }
          />

          {/*
            The bottom line so far: gross profit less the bills in and the standing costs accrued to
            today. The one figure here that includes keeping the doors open, and it says what it is
            missing rather than looking finished.
          */}
          <Figure
            value={net ? formatCents(net.netProfitCents) : "—"}
            label={net && net.netProfitCents < 0 ? "Net loss so far" : "Net profit so far"}
            tone={!net ? "muted" : !net.usable ? "warn" : net.netProfitCents < 0 ? "crit" : "ok"}
            href="/money"
            sub={
              !net
                ? "The books could not be drawn."
                : [
                    `${formatCents(net.operatingCents)} to keep the doors open so far`,
                    net.missing.length > 0 ? `${net.missing.length} line${net.missing.length === 1 ? "" : "s"} not yet in` : "every line in",
                    books?.pace?.netAfterBillsSoFarCents != null ? `${formatCents(books.pace.netAfterBillsSoFarCents)} at this pace` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
            }
          />

          {/*
            Money actually banked from the facilitator, and only that.

            An earlier version put "still owed" here from the gap between the report's gross profit
            and ours. That gap is real but its cause is not knowable from a fill — one was $146.18
            of facilitator money, another $5.56 on a generic Losartan that no facilitator would ever
            pay — so forecasting from it invented a receivable. The gap belongs on the claims screen
            as a reconciliation, not here as money coming.
          */}
          <Figure
            value={formatCents(money.facilitator.receivedCents)}
            label="Facilitator money in"
            tone={money.facilitator.receivedCents > 0 ? "ok" : "muted"}
            href="/remits/mtf"
            sub={
              [
                money.facilitator.payments > 0
                  ? `${money.facilitator.payments} payment${money.facilitator.payments === 1 ? "" : "s"} this month`
                  : "nothing received this month",
                money.facilitator.lastMonthCents > 0 ? `${formatCents(money.facilitator.lastMonthCents)} last month` : null,
                money.facilitator.unmatched > 0 ? `${money.facilitator.unmatched} not yet matched to a claim` : null,
              ]
                .filter(Boolean)
                .join(" · ")
            }
          />

          {/* ── The ratio, which is the lever ───────────────────────── */}
          <Figure
            value={money.ratio?.percent !== null && money.ratio?.percent !== undefined ? `${money.ratio.percent.toFixed(2)}%` : "—"}
            label={money.ratio ? `Scrubbed GCR — ${money.ratio.supplierName}` : "Scrubbed GCR"}
            tone={money.ratio?.percent === null || money.ratio === null ? "muted" : money.ratio.next ? "warn" : "ok"}
            href={money.ratio ? `/suppliers/${money.ratio.supplierId}/terms` : "/suppliers"}
            sub={
              money.ratio === null
                ? "No supplier on file yet."
                : money.ratio.percent === null
                  ? "No drill down has been read yet — it arrives daily and files itself."
                  : [
                      money.ratio.contractGenericPercent !== null
                        ? `${money.ratio.contractGenericPercent}% off a contract generic today`
                        : "no ladder on file to price it",
                      money.ratio.next
                        ? `${money.ratio.next.shortByPercent.toFixed(2)}% short of ${money.ratio.next.rebatePercent}%`
                        : "top band",
                      money.ratio.source === "daily report" ? `today's report` : money.ratio.source === "monthly statement" ? `settled figure` : null,
                      money.ratio.driftPercent !== null && Math.abs(money.ratio.driftPercent) > 0.5
                        ? `today's drill down reads ${money.ratio.dailyPercent?.toFixed(2)}%, a different measure`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
            }
          />

          {/* ── What the buying already done is earning ─────────────── */}
          <Figure
            value={formatCents(money.rebates.estimatedCents)}
            label="Rebates earned this month"
            tone={money.rebates.incomplete || money.rebates.unmarkedLines > 0 ? "warn" : money.rebates.estimatedCents > 0 ? "ok" : "muted"}
            href="/suppliers"
            sub={
              money.rebates.purchasedCents === 0
                ? "No invoices loaded for this month yet."
                : [
                    `on ${formatCents(money.rebates.purchasedCents)} bought`,
                    money.rebates.bySupplier.length === 1 ? money.rebates.bySupplier[0].supplierName : `${money.rebates.bySupplier.length} suppliers`,
                    money.rebates.unmarkedLines > 0 ? `${money.rebates.unmarkedLines} lines unmarked, earning nothing here` : null,
                    money.rebates.incomplete ? "a supplier has no ladder on file" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
            }
          />
        </div>
        {/*
          The whole till, which is the only figure here that includes the front of shop.

          Every other number on this scoreboard is dispensing. The System Sales Summary is the one
          report that carries over-the-counter business too, and it is drawn by the calendar month
          rather than by the day a claim was transmitted — so it is the figure that reconciles
          against the bank, and it is labelled with the month it actually covers rather than being
          quietly presented as this one.
        */}
        {money.sales && (
          <p className="mt-3 rounded-lg border border-line bg-surface p-3 text-xs text-ink-2">
            <b>
              {formatCents(money.sales.totalCents ?? 0)} taken in {money.sales.month}
              {money.sales.isCurrentMonth ? "" : " — the last month closed"}
            </b>{" "}
            — the whole till, retail and prescriptions together, from the System Sales Summary. Of that,{" "}
            {formatCents(money.sales.rxRemitCents ?? 0)} came from the plans,{" "}
            {formatCents(money.sales.rxPatientCents ?? 0)} from patients at the counter and{" "}
            {formatCents(money.sales.retailCents ?? 0)} over the counter. This is the only figure on this
            page that includes the front of shop; everything above it is dispensing.
          </p>
        )}

        {/*
          The report's own bottom line, which nothing on this site computed.

          It is the only authoritative total sales figure the pharmacy has — the transaction report
          prints a grand total, and that total is the thing to reconcile against the bank. Said as
          the report's figure for the report's period, never quietly reinterpreted as the month's:
          those are the same only when the file sent is the monthly one.
        */}
        {money.dispensing.reported && (
          <p className="mt-2 text-xs text-ink-2">
            <b>{formatCents(money.dispensing.reported.salesCents)} taken and{" "}
            {formatCents(money.dispensing.reported.grossProfitCents)} made</b>{" "}
            — the report&rsquo;s own grand total for the last file loaded
            {money.dispensing.reported.from
              ? `, covering ${money.dispensing.reported.from}${
                  money.dispensing.reported.to && money.dispensing.reported.to !== money.dispensing.reported.from
                    ? ` to ${money.dispensing.reported.to}`
                    : ""
                }`
              : ""}
            . This is the one figure here nobody worked out — PioneerRx printed it — so it is what to
            reconcile against the bank.
          </p>
        )}
        {money.unreconciled.fills > 0 && (
          <p className="mt-2 text-xs text-ink-3">
            Separately, {formatCents(money.unreconciled.cents)} across {money.unreconciled.fills} fills is revenue the
            daily report booked that this site has not found in the claim rows. It is not money coming — it is a column
            to identify, and it may already be in the bank.{" "}
            <Link href="/claims" className="text-accent underline">Reconcile it on Claims</Link>.
          </p>
        )}
      </section>

      {/*
        The three things worth the most, before anything that is merely due.

        The scoreboard says how the month stands; this says what to do about it. Three, not the
        whole list, because the whole list is a page of its own and the point here is that a
        pharmacist who reads nothing else knows the one action worth the most this morning.
      */}
      {found && found.rows.length > 0 && (
        <section className="mb-6">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Worth the most this morning</h2>
            <span className="text-xs text-ink-3">
              {formatCents(found.firstYearCents)} in the first year if all of it is done ·{" "}
              <Link href="/money/found" className="text-accent underline">all {found.rows.length}</Link>
            </span>
          </div>
          <ol className="grid gap-3 lg:grid-cols-3">
            {found.rows.slice(0, 3).map((r, i) => (
              <li key={r.key} className="card flex flex-col">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-ink-3">{i + 1}.</span>
                  <span className="text-right">
                    <span className="block text-lg font-semibold tabular-nums text-ink">{formatCents(r.amountCents)}</span>
                    <span className="block text-[11px] text-ink-3">{r.cadence === "recurring_monthly" ? "a month" : "one-off"}</span>
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium">{r.says}</p>
                <p className="mt-1 flex-1 text-xs text-ink-2">{r.todo}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Link href={r.href} className="btn btn-sm btn-primary">Go and do it</Link>
                  {found.ages[r.key] !== undefined && (
                    <span className="text-[11px] text-ink-3">{found.ages[r.key] <= 1 ? "new today" : `${found.ages[r.key]} days on the list`}</span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

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

      {(() => {
        const now = alertList.filter((a) => a.level === "now");
        const soon = alertList.filter((a) => a.level === "soon");
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
                        <span className="mt-0.5 block text-xs text-ink-3">{a.why}</span>
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
                          <span className="mt-0.5 block text-xs text-ink-3">{a.why}</span>
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

      {lateFeeds.length > 0 && (
        <Card
          tone="crit"
          title={lateFeeds.length === 1 ? "A report the site runs on has stopped arriving" : `${lateFeeds.length} reports the site runs on have stopped arriving`}
          className="mb-6"
        >
          <p className="text-sm text-ink-2">
            {lateFeeds.map((f) => `${f.label} (last ${f.lastAt ? f.lastAt.slice(0, 10) : "never"})`).join(", ")}. Every figure downstream of {lateFeeds.length === 1 ? "it" : "them"} is quietly going stale while continuing to look right.{" "}
            <Link href="/settings/feeds" className="underline">Is everything arriving?</Link>
          </p>
        </Card>
      )}

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
