import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { addCashReceipt, automaticReceiptsLike, deleteCashReceipt, cashReceiptsFor } from "@/lib/expenses";
import { readBankStatement, lastStatementLines, scannedStatementReview, confirmScannedStatement } from "./bank";
import { Field, Settled } from "@/components/ui";
import { formatCents, parseCents } from "@/lib/money";
import { todayIso, fmt } from "@/lib/dates";
import { parsePeriod, periodOf, neighbours, type PeriodKind } from "@/lib/ledger";
import { booksFor, recentMonths } from "@/lib/ledger-store";
import { claimsCompleteness } from "@/lib/claims-completeness";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { closeMonthFromBooks } from "./close-month";
import { PageHeader, Card, Notice } from "@/components/ui";
import { Bars } from "@/components/bars";
import { Stat, deltaOf } from "@/components/kit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money" };

/**
 * The books.
 *
 * One screen that says what the period took, what the goods cost, what the doors cost, and what
 * is left — on both bases, with the gap between them named for what it is — and puts a link on
 * every figure to the rows it was added from. It refuses to print a confident bottom line over a
 * hole: what is missing is said first, and the total is marked for what it is.
 *
 * The specification is docs/reference/money-ledger.md.
 */
/*
 * The payer payment report, uploaded by hand.
 *
 * It arrives by email and files itself, and this is for the day it does not: a report re-run for a
 * range that was missed, or a month somebody wants in before the sweep. Same reader, same key, so
 * a payment already banked is recognised whichever way it came in.
 *
 * At module level rather than inside the component: an inline action's closed-over values are
 * serialised into the form and a function cannot be.
 */
async function uploadPayments(fd: FormData): Promise<never> {
  "use server";
  const u = await requireManager();
  const period = String(fd.get("period") ?? "");
  const back = `/money?period=${encodeURIComponent(period)}`;
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) redirect(`${back}&error=${encodeURIComponent("No file was chosen.")}`);
  const text = Buffer.from(await (f as File).arrayBuffer()).toString("utf8");
  const { looksLikePayerPayments } = await import("@/lib/payer-payments");
  if (!looksLikePayerPayments(text)) {
    redirect(`${back}&error=${encodeURIComponent("That is not a payer payment report: it needs a payment number, a payer, a deposit date and an amount. Nothing was banked.")}`);
  }
  const { importPayerPayments } = await import("@/lib/payer-payments-store");
  const r = await importPayerPayments(text, { userId: u.id, userName: u.name, fileName: (f as File).name });
  revalidatePath("/money");
  if (!r.ok) redirect(`${back}&error=${encodeURIComponent(r.why)}`);
  const said =
    r.banked === 0
      ? r.alreadyHeld > 0
        ? `Nothing new: all ${r.alreadyHeld} payments in that report were already banked.`
        : "That report covered a period with no deposits, so nothing was banked."
      : `${formatCents(r.bankedCents)} banked across ${r.banked} payment${r.banked === 1 ? "" : "s"}${r.from ? `, ${r.from} to ${r.to}` : ""}` +
        `${r.alreadyHeld ? `. ${r.alreadyHeld} were already held and were not banked again` : ""}` +
        `${r.skipped.length ? `. ${r.skipped.length} row${r.skipped.length === 1 ? "" : "s"} could not be read: ${r.skipped.slice(0, 2).map((x) => `row ${x.row}, ${x.why}`).join("; ")}` : ""}.`;
  redirect(`${back}&ok=${encodeURIComponent(said)}`);
}

export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ period?: string; ok?: string; error?: string; scan?: string }> }) {
  await requireUser();
  const { period: periodParam, ok, error, scan } = await searchParams;
  /* A scanned bank statement waiting on a person: the stretches its balances could not prove. See scanned-bank-solve.ts. */
  const scanReview = scan ? await scannedStatementReview(scan).catch(() => null) : null;
  const today = todayIso();
  const period = (periodParam && parsePeriod(periodParam)) || periodOf("month", today.slice(0, 7));
  const [books, recent, banked, bankLines] = await Promise.all([booksFor(period, today), recentMonths(6, today), cashReceiptsFor(period.months), lastStatementLines(period.months)]);
  const { accrual, cash, scripts, gap, pace, sources, countedOnce, feeds, difference, balances } = books;
  /* Read back from the last pull, so this can never disagree with the feed that computed it. */
  const completeness = await claimsCompleteness();
  /* Whether the month can be closed, as the engine judged it: every bank line placed, the receipts gap named, the month over. */
  const status = period.kind === "month" ? await db.query.monthStatus.findFirst({ where: eq(schema.monthStatus.month, period.key) }).catch(() => null) : null;
  /*
   * The cash account is the bank statement, categorised (cash-from-bank.ts; the owner, 2 October 2026: "cash
   * accounting should match the bank"). Where every month of the period has its statement read, the cash column
   * is the bank's own movement to the cent, and what nobody has named yet is inside it under its own heading.
   */
  const bankMonths = books.cash.months.filter((m) => m.onBank);
  const onBank =
    bankMonths.length > 0 && bankMonths.length === books.cash.months.length
      ? {
          lines: bankMonths.reduce((n, m) => n + (m.onBank?.lines ?? 0), 0),
          unnamedLines: bankMonths.reduce((n, m) => n + (m.onBank?.unnamed ?? []).reduce((k, l) => k + Number((l.note ?? "0").split(" ")[0]), 0), 0),
          unnamedCents: bankMonths.reduce((n, m) => n + (m.onBank?.unnamedCents ?? 0), 0),
          unconfirmedReceipts: Object.values(
            bankMonths
              .flatMap((m) => m.onBank?.unconfirmedReceipts ?? [])
              .reduce<Record<string, { label: string; amountCents: number; note: string }>>((acc, u) => {
                const e = acc[u.label] ?? { label: u.label, amountCents: 0, note: "" };
                e.amountCents += u.amountCents;
                e.note = u.note ?? e.note;
                acc[u.label] = e;
                return acc;
              }, {}),
          ),
        }
      : null;
  const KINDS: { key: "third_party" | "patient" | "retail" | "facilitator" | "rebate" | "other"; label: string }[] = [
    { key: "third_party", label: "Plan remittances" },
    { key: "patient", label: "Patient payments" },
    { key: "retail", label: "Retail takings" },
    { key: "facilitator", label: "Facilitator payments" },
    { key: "rebate", label: "Wholesaler rebate" },
    { key: "other", label: "Other" },
  ];

  /*
   * Banking it.
   *
   * The cash account had a table for receipts and nothing that wrote to it, so its revenue was
   * missing on every month. Until the bank's own statement is imported, what reached the bank is
   * typed here: one line per deposit or per payer per month, by the month the money arrived —
   * never the month it was earned, which is the accrual account's business.
   */
  async function bankIt(fd: FormData) {
    "use server";
    const u = await requireManager();
    const month = String(fd.get("month") ?? "").trim();
    const kind = String(fd.get("kind") ?? "") as (typeof KINDS)[number]["key"];
    const amountCents = parseCents(String(fd.get("amount") ?? ""));
    const back = `/money?period=${encodeURIComponent(String(fd.get("period") ?? month))}`;
    if (!/^\d{4}-\d{2}$/.test(month)) redirect(`${back}&error=${encodeURIComponent("Say which month the money arrived, as YYYY-MM.")}`);
    if (!KINDS.some((k) => k.key === kind)) redirect(`${back}&error=${encodeURIComponent("Say what kind of money it was.")}`);
    if (amountCents === null || amountCents === 0) redirect(`${back}&error=${encodeURIComponent("Put the amount in dollars.")}`);
    /* Money a feed already banked is not typed again beside it. See `automaticReceiptsLike`. */
    if (fd.get("different") !== "yes") {
      const already = await automaticReceiptsLike(month, amountCents!);
      if (already.length > 0) {
        const said = already.map((a) => `${a.payer ? `from ${a.payer}` : "a receipt"}${a.receivedOn ? ` on ${a.receivedOn}` : ""}${a.reference ? ` (${a.reference})` : ""}`).join(" + ");
        redirect(
          `${back}&error=${encodeURIComponent(
            `${formatCents(amountCents!)} is already banked automatically${already.length > 1 ? `, as ${already.length} receipts together: ${said}` : ` ${said}`}. Nothing was banked. If this really is different money, tick "This is different money" and bank it again.`,
          )}`,
        );
      }
    }
    const { id } = await addCashReceipt({ month, kind, amountCents, payer: String(fd.get("payer") ?? "").trim() || null, notes: String(fd.get("notes") ?? "").trim() || null, createdBy: u.id });
    await audit({ action: "cash_receipt.add", userId: u.id, userName: u.name, entity: "cash_receipt", entityId: id ?? undefined, details: `${month} ${kind} ${formatCents(amountCents)}` });
    revalidatePath("/money");
    revalidatePath("/money/monthly");
    redirect(`${back}&ok=${encodeURIComponent(`${formatCents(amountCents)} banked against ${month}.`)}`);
  }
  async function unbank(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const back = `/money?period=${encodeURIComponent(String(fd.get("period") ?? ""))}`;
    if (!id) redirect(back);
    await deleteCashReceipt(id);
    await audit({ action: "cash_receipt.delete", userId: u.id, userName: u.name, entity: "cash_receipt", entityId: id });
    revalidatePath("/money");
    revalidatePath("/money/monthly");
    redirect(`${back}&ok=${encodeURIComponent("Receipt removed.")}`);
  }
  const { before, after } = neighbours(period);
  const isCurrent = period.kind === "month" && period.key === today.slice(0, 7);
  const link = (kind: PeriodKind) => `/money?period=${periodOf(kind, period.months[period.months.length - 1]).key}`;

  const tone = (c: number) => (c < 0 ? "crit" : "ok");
  const pct = (c: number) => (accrual.netRevenueCents > 0 ? `${Math.round((c / accrual.netRevenueCents) * 1000) / 10}% of net revenue` : undefined);
  /*
   * The change against the period before, and the six-month line under each figure.
   *
   * For a month the comparison is the month before; for a quarter or a year the figures are the
   * period's and the line is still the months, because the months are what moved.
   */
  const previous = period.kind === "month" ? recent[recent.findIndex((r) => r.month === period.key) - 1] ?? null : null;
  /* No comparison against a month before the books: "up $659,594.64 vs last" on the first month is not a change, it is the books starting. */
  const previousInBooks = previous && previous.pl.revenue.length > 0 ? previous : null;
  const hist = (pick: (r: (typeof recent)[number]) => number | null) => recent.map((r) => (r.pl.revenue.length ? pick(r) : null));
  const d = (now: number, before: number | null | undefined) => deltaOf(now, before, formatCents);

  const lastMonth = period.months[period.months.length - 1];
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  /* The engine's "as of" sentence goes in the footer, not in the list of things still to come. */
  const asOf = [...accrual.caveats, ...cash.caveats].find((c) => /as the engine computed them/.test(c)) ?? null;
  const toCome = [...accrual.missing, ...accrual.caveats.filter((c) => !/as the engine computed them/.test(c))];
  const checksByMonth = accrual.months.map((m) => {
    const checks = [...m.reconciliation.cogs.checks, ...m.reconciliation.revenue];
    return { month: m.month, checks, findings: checks.filter((c) => !c.expected && c.agrees === false).length, ties: checks.filter((c) => c.agrees === true).length };
  });
  const findings = checksByMonth.reduce((n, m) => n + m.findings, 0);
  const pairsDecided = countedOnce.filter((r) => r.bothPresent);
  const feedsOff = feeds.filter((f) => f.reaches === "none");
  const feedsGap = feeds.filter((f) => f.reaches !== "none" && f.gap);

  return (
    <>
      <PageHeader
        tabs={familyTabs("money", "/money")}
        title="The books"
        help={
          <>
            <p><b>Cost of goods is what was dispensed, not what was bought.</b> PioneerRx prints the acquisition cost of every fill, so the cost of what sold is known per bottle.</p>
            <p><b>Rebates reduce cost; they are never revenue.</b> Earned in the month that earned them on the accrual basis; received in the month the bank got them on the cash basis.</p>
            <p><b>Payer fees come out of revenue,</b> measured from the remittances, so the dispensing margin is not flattered.</p>
            <p><b>Cash and accrual are both true.</b> A prescription dispensed on the 30th is this month&rsquo;s earnings and next month&rsquo;s money. The cash account is the bank statement, categorised, and equals the bank to the cent.</p>
            <p><b>Every figure links to its rows.</b> A wrong figure is corrected on the linked page, never here.</p>
          </>
        }
        actions={
          <>
            <Link href={`/money/bank-review?month=${lastMonth}`} className="btn">The bank</Link>
            <Link href="/expenses" className="btn">Spending</Link>
            <Link href={`/money/monthly?period=${period.key}`} className="btn">Statement</Link>
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/* The period: arrows, the word, the size, and where the month stands. One line. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href={`/money?period=${before.key}`} className="btn btn-sm" aria-label="Earlier">←</Link>
        <span className="font-semibold">{period.label}</span>
        <Link href={`/money?period=${after.key}`} className="btn btn-sm" aria-label="Later">→</Link>
        <span className="ml-2 inline-flex overflow-hidden rounded-md border border-line text-xs">
          {(["month", "quarter", "year"] as PeriodKind[]).map((k) => (
            <Link key={k} href={link(k)} className={`px-2.5 py-1 ${period.kind === k ? "bg-accent font-semibold text-white" : "bg-surface text-ink-2 hover:bg-ground"}`}>
              {k}
            </Link>
          ))}
        </span>
        {isCurrent && (
          <span className="text-xs text-ink-3">
            day {dayOfMonth} of {daysInMonth}
            {pace ? ` · ${pace.says}` : ""}
          </span>
        )}
        {/* Closing, from the page the month is read on. He asked "can we close sept?" and then "dont see close button?": the only one had been on the retired screens. */}
        {status?.closeState === "closed" && <span className="badge badge-ok ml-auto">closed {status.closedAt ? fmt(status.closedAt.slice(0, 10)) : ""}</span>}
        {status?.closeState === "ready" && (
          <form action={closeMonthFromBooks} className="ml-auto">
            <input type="hidden" name="month" value={period.key} />
            <button className="btn btn-sm btn-primary">Close {period.label}</button>
          </form>
        )}
      </div>

      {/* Months in the period with nothing on file: left out, and said. */}
      {accrual.emptyMonths.length > 0 && (
        <Notice kind="warn">
          <b>{accrual.emptyMonths.join(", ")}: nothing on file,</b> so {accrual.emptyMonths.length === 1 ? "it is" : "they are"} not in these figures, not even as noughts.
        </Notice>
      )}

      {/*
        Where the account stands, in one line, with what is still to come behind a press.

        This was a red box of three paragraphs on a month two days old, telling him to go and type things. A month in
        progress is not a crisis; it is in progress. What is still to come is listed when asked, and nothing here asks
        him to type a figure the feeds will bring.
      */}
      {toCome.length > 0 && (
        <details className={`mb-4 rounded-lg border px-3 py-2 text-sm ${isCurrent ? "border-line bg-surface" : "border-warn bg-warn-soft"}`}>
          <summary className="cursor-pointer">
            <b>{isCurrent ? `${period.label} is in progress` : `${period.label} is not complete`}</b>
            <span className="text-ink-2">
              {" "}
              — {toCome.length} thing{toCome.length === 1 ? "" : "s"} still to come{isCurrent ? "" : "; until then the bottom line reads high"}.
            </span>
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-2">
            {toCome.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      )}

      {/* Six figures. For a month in progress nothing is compared to the month before: two days against thirty is noise. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Stat size="sm" value={formatCents(accrual.netRevenueCents)} label="Net revenue" sub={isCurrent && pace?.netRevenueCents ? `${formatCents(pace.netRevenueCents)} at this pace` : "earned at pickup"} tone="muted" href={sources.revenue} delta={isCurrent ? null : d(accrual.netRevenueCents, previousInBooks?.pl.netRevenueCents)} history={hist((r) => r.pl.netRevenueCents)} />
        <Stat size="sm" value={formatCents(accrual.grossProfitCents)} label="Gross profit" sub={accrual.grossMarginPercent !== null ? `${accrual.grossMarginPercent}% of net revenue` : "cost of goods not known"} tone={tone(accrual.grossProfitCents)} href={sources.costOfGoods} delta={isCurrent ? null : d(accrual.grossProfitCents, previousInBooks?.pl.grossProfitCents)} history={hist((r) => r.pl.grossProfitCents)} />
        <Stat size="sm" value={formatCents(accrual.operatingCents)} label="Running costs" sub={pct(accrual.operatingCents) ?? "operating costs"} tone="muted" href={sources.expenses} delta={isCurrent ? null : d(accrual.operatingCents, previousInBooks?.pl.operatingCents)} upIsGood={false} history={hist((r) => r.pl.operatingCents)} />
        <Stat size="sm" value={formatCents(accrual.netProfitCents)} label={accrual.netProfitCents < 0 ? "Net loss" : "Net profit"} sub={isCurrent ? "so far" : "before tax"} tone={tone(accrual.netProfitCents)} delta={isCurrent ? null : d(accrual.netProfitCents, previousInBooks?.pl.netProfitCents)} history={hist((r) => r.pl.netProfitCents)} />
        <Stat size="sm" value={formatCents(cash.cashChangeCents ?? cash.netProfitCents)} label="Cash change" sub={onBank ? "the bank, to the cent" : "from the feeds; no statement yet"} tone={onBank ? "muted" : "warn"} href={`/money/bank-review?month=${lastMonth}`} />
        <Stat size="sm" value={scripts.scripts.toLocaleString()} label="Scripts" sub={scripts.perDay !== null ? `${scripts.perDay} a day` : "none in the period"} tone="muted" href={sources.scripts} />
      </div>

      {/* The account: both bases, and one sentence on the gap. The parts of the gap are a press away. */}
      <Card className="mt-4" title="The account">
        <div className="overflow-x-auto">
          <table className="table text-sm">
            <thead>
              <tr>
                <th></th>
                <th className="num">Accrual</th>
                <th className="num">Cash</th>
                <th className="num">Gap</th>
              </tr>
            </thead>
            <tbody>
              <Line label="Revenue" a={accrual.revenueCents} c={cash.revenueCents} href={sources.revenue} />
              {(accrual.netRevenueCents !== accrual.revenueCents || cash.netRevenueCents !== cash.revenueCents) && (
                <Line label="Net revenue" a={accrual.netRevenueCents} c={cash.netRevenueCents} note="after payer fees and chargebacks" />
              )}
              <Line label="Cost of goods" a={accrual.costOfGoodsCents} c={cash.costOfGoodsCents} href={sources.purchases} />
              <Line label="Gross profit" a={accrual.grossProfitCents} c={cash.grossProfitCents} strong />
              <Line label="Running costs" a={accrual.operatingCents} c={cash.operatingCents} href={sources.expenses} />
              <Line label="Net" a={accrual.netProfitCents} c={cash.netProfitCents} strong />
              {cash.otherCashOut.length > 0 && (
                <Line
                  label={onBank && onBank.unnamedLines > 0 ? "Not a cost, and lines not yet named" : "Not a cost: loan principal, draws, tax"}
                  a={0}
                  c={cash.otherCashOutCents}
                  href={onBank && onBank.unnamedLines > 0 ? `/money/bank-review?month=${lastMonth}` : undefined}
                  note={onBank && onBank.unnamedLines > 0 ? `${formatCents(onBank.unnamedCents)} on ${onBank.unnamedLines} line${onBank.unnamedLines === 1 ? "" : "s"} to name on the bank page` : undefined}
                />
              )}
              <Line label="Cash change" a={null} c={cash.cashChangeCents ?? cash.netProfitCents} strong note={onBank ? "the bank's own movement, to the cent" : "what the feeds have seen; the statement replaces it"} />
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-2">{gap.says}</p>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ink-3">Why the two columns differ, and what was checked</summary>
          <div className={`mt-2 rounded-lg border p-3 ${difference.adds ? "border-line bg-ground/40" : "border-crit bg-crit-soft"}`}>
            <p className="font-semibold">{difference.says}</p>
            <ul className="mt-1.5 space-y-1">
              {difference.parts.filter((x) => x.cents !== 0).map((x) => (
                <li key={x.what} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="tabular-nums font-semibold">{formatCents(x.cents)}</span>
                  <span className="font-medium">{x.what}</span>
                  <span className="min-w-0 grow text-ink-3">{x.says}</span>
                </li>
              ))}
            </ul>
          </div>
          {balances.accrual.ok && balances.cash.ok ? (
            <p className="mt-2 text-ink-3">Every total above is the sum of its own lines and every subtotal follows from the one before it, on both bases.</p>
          ) : (
            <Notice kind="crit">
              <b>This statement does not add up, so do not use it.</b>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {[...balances.accrual.checks.map((c) => ({ ...c, basis: "accrual" })), ...balances.cash.checks.map((c) => ({ ...c, basis: "cash" }))]
                  .filter((c) => !c.ok)
                  .map((c, i) => (
                    <li key={i}>
                      {c.basis}: {c.says.toLowerCase()} — it should be {formatCents(c.expectedCents)} and the account says {formatCents(c.actualCents)}.
                    </li>
                  ))}
              </ul>
            </Notice>
          )}
          {accrual.stockMovementCents !== null && accrual.stockMovementCents !== 0 && (
            <p className="mt-1 text-ink-3">
              {formatCents(Math.abs(accrual.stockMovementCents))} {accrual.stockMovementCents > 0 ? "went onto the shelf" : "came off the shelf"} in the period: bought against dispensed. Not profit.
            </p>
          )}
          {onBank && onBank.unconfirmedReceipts.length > 0 && (
            <p className="mt-1 text-ink-3">
              Beside the cash account, not in it: {onBank.unconfirmedReceipts.map((u) => `${u.label.toLowerCase()} ${formatCents(u.amountCents)} (${u.note})`).join("; ")}.
            </p>
          )}
        </details>
      </Card>

      {/* At the bank: one line on where the cash side stands; the tools for money the feeds did not see are behind a press. */}
      <Card
        className="mt-4"
        title={onBank ? "At the bank" : "At the bank, so far"}
        actions={<Link href={`/money/bank-review?month=${lastMonth}`} className="btn btn-sm">Every line</Link>}
      >
        {onBank ? (
          <p className="text-sm">
            {onBank.lines} lines on the statement; the cash account equals the bank to the cent.{" "}
            {onBank.unnamedLines > 0 ? (
              <>
                <b>{onBank.unnamedLines} line{onBank.unnamedLines === 1 ? "" : "s"}, {formatCents(onBank.unnamedCents)}, not yet named</b> — name {onBank.unnamedLines === 1 ? "it" : "them"} on the bank page and {onBank.unnamedLines === 1 ? "it moves" : "they move"} to where {onBank.unnamedLines === 1 ? "it belongs" : "they belong"}.
              </>
            ) : (
              "Every line is named."
            )}
          </p>
        ) : (
          <p className="text-sm">
            No statement for {period.label} yet; Emprise sends it after month end. Until then the cash column is what the feeds have seen: {formatCents(cash.revenueCents)} in and {formatCents(cash.costOfGoodsCents + cash.operatingCents + cash.otherCashOutCents)} out so far.
          </p>
        )}
        {onBank && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-ink-3">The cash account line by line, with the bank lines behind each row</summary>
            <AccountLines
              sections={[
                { title: "Revenue", rows: cash.revenue },
                { title: "Taken off revenue", rows: cash.offsets },
                { title: "Cost of goods", rows: cash.costOfGoods },
                { title: "Running costs", rows: cash.operating },
                { title: "Not a cost, or not yet named", rows: cash.otherCashOut },
              ]}
            />
          </details>
        )}
        {!onBank && bankLines.unplaced.length > 0 && (
          <p className="mt-1 text-xs text-ink-2">
            {bankLines.unplaced.length} line{bankLines.unplaced.length === 1 ? "" : "s"} from the statement not placed:{" "}
            {bankLines.unplaced.slice(0, 4).map((l) => `${fmt(l.on)} ${formatCents(l.amountCents)}`).join("; ")}
            {bankLines.unplaced.length > 4 ? `, and ${bankLines.unplaced.length - 4} more` : ""}.
          </p>
        )}
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-ink-3">Record money the feeds did not see, or read a statement</summary>
          <div className="mt-3 space-y-4">
            <form action={uploadPayments} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="period" value={period.key} />
              <Field label="A payer payment report" hint="The CSV from the remittance service, any date range. Each payment banks in the month it was deposited; one already held is never banked twice.">
                <input type="file" name="file" accept=".csv,.txt" className="w-full text-xs" />
              </Field>
              <button className="btn btn-primary">Bank the report</button>
            </form>
            <form action={bankIt} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <input type="hidden" name="period" value={period.key} />
              <Field label="Month it arrived">
                <input type="month" name="month" defaultValue={lastMonth} required className="w-full" />
              </Field>
              <Field label="Kind">
                <select name="kind" className="w-full" defaultValue="third_party">
                  {KINDS.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Amount, in dollars">
                <input name="amount" inputMode="decimal" placeholder="12345.67" required className="w-full" />
              </Field>
              <Field label="Payer">
                <input name="payer" placeholder="Caremark" className="w-full" />
              </Field>
              <Field label="Notes">
                <input name="notes" className="w-full" />
              </Field>
              <div className="flex flex-col items-start justify-end gap-1">
                <label className="flex items-center gap-1 text-xs text-ink-3">
                  <input type="checkbox" name="different" value="yes" /> This is different money
                </label>
                <button className="btn btn-primary">Bank it</button>
              </div>
            </form>
            <form action={readBankStatement} encType="multipart/form-data" className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <input type="hidden" name="period" value={period.key} />
              <Field label="Read the bank's statement" hint="Emprise's monthly statement as the PDF it comes in, or a CSV export.">
                <input type="file" name="file" accept=".pdf,.csv,.txt" required className="w-full" />
              </Field>
              <button className="btn">Read the statement</button>
            </form>
            {scan && scanReview && (
              <div className="rounded border border-line p-3" id="scan">
                <p className="font-semibold">{scanReview.fileName}: not placed yet</p>
                {scanReview.why ? (
                  <p className="mt-1 text-ink-2">{scanReview.why}</p>
                ) : (
                  <form action={confirmScannedStatement} className="mt-1 grid gap-2">
                    <input type="hidden" name="period" value={period.key} />
                    <input type="hidden" name="document" value={scan} />
                    <p className="text-ink-2">
                      The scan is unclear in {scanReview.unproven.length === 1 ? "one place" : `${scanReview.unproven.length} places`}: the lines it reads do not reach the bank&rsquo;s own balance. Check the figures below against the page.
                    </p>
                    {scanReview.unproven.map((u) => (
                      <fieldset key={`${u.from}-${u.lines[0]?.index ?? 0}`} className="grid gap-1 border-t border-line pt-2">
                        <legend className="font-semibold">
                          {fmt(u.from)}
                          {u.to === u.from ? "" : ` to ${fmt(u.to)}`}: {u.reason ?? `the lines must come to ${formatCents(Math.abs(u.differenceCents))} ${u.differenceCents > 0 ? "more" : "less"} than they read`}
                        </legend>
                        {u.lines.map((l) => (
                          <label key={l.index} className="flex flex-wrap items-center gap-2">
                            <span className="w-14 text-ink-3">page {l.page}</span>
                            <span className="w-24 text-ink-3">{l.section === "credits" ? "deposit" : l.section === "checks" ? "cheque" : l.section === "card" ? "card" : "withdrawal"}</span>
                            <span className="w-40 font-mono">
                              {l.dateText} {l.amountText}
                            </span>
                            <input name={`fix-${l.index}`} inputMode="decimal" defaultValue={(Math.abs(l.readAsCents) / 100).toFixed(2)} className="w-28 tabular-nums" aria-label={`Amount printed on page ${l.page}`} />
                          </label>
                        ))}
                      </fieldset>
                    ))}
                    <div>
                      <button className="btn btn-primary">Check these figures</button>
                    </div>
                  </form>
                )}
              </div>
            )}
            {banked.length > 0 && (
              <div className="overflow-x-auto border-t border-line pt-3">
                <p className="mb-1 font-semibold">Receipts recorded for the period</p>
                <table className="table text-xs">
                  <thead>
                    <tr>
                      <th>Banked</th>
                      <th>Kind</th>
                      <th>Payer</th>
                      <th className="num">Amount</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {banked.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap">{r.receivedOn ?? r.month}</td>
                        <td>{KINDS.find((k) => k.key === r.kind)?.label ?? r.kind}</td>
                        <td className="text-ink-2">{r.payer ?? "—"}</td>
                        <td className="num">{formatCents(r.amountCents)}</td>
                        <td>
                          <form action={unbank}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="period" value={period.key} />
                            <button className="btn btn-sm btn-danger">Remove</button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </details>
      </Card>

      {/* The trend. A month before the books is a month before the books, not a month with something missing. */}
      <Card className="mt-4" title="The last six months">
        <Bars
          labels={recent.map((r) => r.month.slice(5) + "/" + r.month.slice(2, 4))}
          series={[
            { label: "Net revenue", values: recent.map((r) => (r.pl.revenue.length ? r.pl.netRevenueCents : null)) },
            { label: "Gross profit", values: recent.map((r) => (r.pl.revenue.length ? r.pl.grossProfitCents : null)), tone: "ink" },
          ]}
          hrefs={recent.map((r) => `/money?period=${r.month}`)}
        />
        <div className="mt-2 overflow-x-auto">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Month</th>
                {recent.map((r) => (
                  <th key={r.month} className="num">
                    {r.month}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Scripts</td>
                {recent.map((r) => (
                  <td key={r.month} className="num">
                    {r.pl.revenue.length ? r.scripts.toLocaleString() : "—"}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Gross margin</td>
                {recent.map((r) => (
                  <td key={r.month} className="num">
                    {r.pl.grossMarginPercent !== null ? `${r.pl.grossMarginPercent}%` : "—"}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Net</td>
                {recent.map((r) => (
                  <td key={r.month} className={`num ${r.pl.netProfitCents < 0 ? "text-crit" : ""}`}>
                    {r.pl.revenue.length ? formatCents(r.pl.netProfitCents) : "—"}
                  </td>
                ))}
              </tr>
              <tr>
                <td>State</td>
                {recent.map((r) => (
                  <td key={r.month} className="num text-ink-3">
                    {!r.pl.revenue.length ? "before the books" : r.month === today.slice(0, 7) ? "in progress" : r.pl.usable ? "complete" : `${r.pl.missing.length} to come`}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {/* Checks: one line each, the working a press away. */}
      <Card className="mt-4" title="Checks">
        <ul className="rows">
          {checksByMonth.map((m) => (
            <li key={m.month} className="row">
              <div className="min-w-0">
                <div className="row-title">
                  <Link href={`/money/monthly?period=${m.month}`} className="text-accent underline">{m.month}</Link> against its own records
                  {m.findings > 0 ? <span className="badge badge-warn ml-2">{m.findings} to look at</span> : m.ties > 0 ? <span className="badge badge-ok ml-2">ties</span> : <span className="badge badge-muted ml-2">nothing to check yet</span>}
                </div>
                <p className="row-why">{m.checks.map((c) => c.what).join(" · ")}</p>
              </div>
            </li>
          ))}
          <li className="row">
            <div className="min-w-0">
              <div className="row-title">
                Counted once
                <span className="badge badge-ok ml-2">{countedOnce.length} pair{countedOnce.length === 1 ? "" : "s"} checked</span>
              </div>
              <p className="row-why">
                {countedOnce.length === 0
                  ? "Nothing recorded in this period in two places."
                  : `${pairsDecided.length} on file in two places, each counted once; ${countedOnce.length - pairsDecided.length} with one record only.`}
              </p>
              {pairsDecided.length > 0 && (
                <details className="mt-1 text-xs text-ink-2">
                  <summary className="cursor-pointer text-ink-3">which, and why</summary>
                  <ul className="mt-1 space-y-1">
                    {pairsDecided.map((r) => (
                      <li key={r.what}>
                        <b>{r.what}.</b> {r.says} <span className="text-ink-3">{r.rule}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </li>
          {completeness && (
            <li className="row">
              <div className="min-w-0">
                <div className="row-title">
                  Every fill PioneerRx has, against every fill here
                  {completeness.missingFills > 0 ? <span className="badge badge-warn ml-2">{completeness.missingFills} not captured</span> : <span className="badge badge-ok ml-2">complete</span>}
                </div>
                <p className="row-why">
                  {completeness.missingFills === 0
                    ? `Through ${fmt(completeness.coverTo ?? "")}, every one of the ${completeness.pioneerFills.toLocaleString()} fills PioneerRx holds is here.`
                    : `${formatCents(completeness.missingCents)} on ${completeness.missingFills} fill${completeness.missingFills === 1 ? "" : "s"} PioneerRx booked that are not here, through ${fmt(completeness.coverTo ?? "")}.`}
                  {completeness.takenFromPioneer.fills > 0 && (
                    <>
                      {" "}
                      The morning pull took {completeness.takenFromPioneer.fills} fill{completeness.takenFromPioneer.fills === 1 ? "" : "s"}, {formatCents(completeness.takenFromPioneer.cents)}, from PioneerRx
                      {completeness.takenFromPioneer.overReversed > 0 ? ` (${completeness.takenFromPioneer.overReversed} the nightly report had only as reversed)` : ""}.
                    </>
                  )}
                  {completeness.takenFromPioneer.payerRows > 0 && (
                    <>
                      {" "}
                      It also wrote {completeness.takenFromPioneer.payerRows} payer row{completeness.takenFromPioneer.payerRows === 1 ? "" : "s"} the nightly report never sent onto fills already here, carrying {formatCents(completeness.takenFromPioneer.payerRowsCostCents)} of cost.
                    </>
                  )}
                </p>
                {(completeness.missingFills > 0 || completeness.notAddingUp > 0) && (
                  <details className="mt-1 text-xs text-ink-2">
                    <summary className="cursor-pointer text-ink-3">the days, and what to do</summary>
                    {completeness.missingByDay.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {completeness.missingByDay.slice(0, 8).map((dd) => (
                          <li key={dd.day} className="flex items-center justify-between gap-3">
                            <span>{fmt(dd.day)}</span>
                            <span className="text-ink-3">{dd.fills} fill{dd.fills === 1 ? "" : "s"}</span>
                            <span className="tabular-nums">{formatCents(dd.cents)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {completeness.missingFills > 0 && (
                      <p className="mt-1">
                        The morning pull writes these in from PioneerRx by itself. One still listed after this morning&rsquo;s pull has no fill date in PioneerRx, or the pull did not run; the feeds page says which.
                      </p>
                    )}
                    {completeness.notAddingUp > 0 && (
                      <p className="mt-1">
                        {completeness.notAddingUp} fill{completeness.notAddingUp === 1 ? "" : "s"} where the payers and the patient do not add to the fill&rsquo;s price in PioneerRx&rsquo;s own figures:{" "}
                        {completeness.notAddingUpList
                          .slice(0, 6)
                          .map((x) => `Rx ${x.rxNumber}-${x.fillNumber} (${formatCents(x.addsToCents)} against ${formatCents(x.fillSaysCents)})`)
                          .join("; ")}
                        {completeness.notAddingUp > 6 ? `, and ${completeness.notAddingUp - 6} more` : ""}.
                      </p>
                    )}
                    {completeness.aheadFills > 0 && (
                      <p className="mt-1 text-ink-3">
                        {completeness.aheadFills.toLocaleString()} fills worth {formatCents(completeness.aheadCents)} are dated after the day-old copy reaches and are not counted either way.
                      </p>
                    )}
                  </details>
                )}
              </div>
            </li>
          )}
          <li className="row">
            <div className="min-w-0">
              <div className="row-title">
                Where each figure comes from
                {feedsOff.length > 0 ? <span className="badge badge-warn ml-2">{feedsOff.length} reach neither account</span> : <span className="badge badge-ok ml-2">every feed lands</span>}
              </div>
              <p className="row-why">
                {feeds.length} feeds carry money.{" "}
                {feedsOff.length > 0 ? `${feedsOff.map((f) => f.name).join(", ")} ${feedsOff.length === 1 ? "reaches" : "reach"} neither account.` : "Every one lands on an account."}
                {feedsGap.length > 0 ? ` ${feedsGap.length} land${feedsGap.length === 1 ? "s" : ""} with a gap noted.` : ""}
              </p>
              <details className="mt-1 text-xs text-ink-2">
                <summary className="cursor-pointer text-ink-3">each feed, and where it lands</summary>
                <ul className="mt-1 space-y-1">
                  {feeds.map((f) => (
                    <li key={f.name}>
                      <Link href={f.href} className="text-accent underline">{f.name}</Link> — {f.carries}, {f.reaches === "none" ? "on no account" : f.reaches === "both" ? "both bases" : f.reaches}. {f.how}
                      {f.gap && <span className="text-warn"> {f.gap}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </li>
        </ul>
      </Card>

      <p className="mt-4 text-[11px] text-ink-3">
        {asOf ? `${asOf} ` : ""}Every figure links to the rows it was added from and is corrected there, never here.{" "}
        <Link href={`/money/monthly?period=${period.key}`} className="text-accent underline">The statement</Link> carries every line with its source, printable and as a file.
      </p>
    </>
  );
}

function Line({ label, a, c, href, note, strong }: { label: string; a: number | null; c: number; href?: string; note?: string; strong?: boolean }) {
  const gap = a === null ? null : a - c;
  return (
    <tr className={strong ? "font-semibold" : ""}>
      <td>
        {href ? <Link href={href} className="text-accent underline">{label}</Link> : label}
        {note && <span className="block text-[11px] font-normal text-ink-3">{note}</span>}
      </td>
      <td className="num">{a === null ? <span className="text-ink-3">—</span> : formatCents(a)}</td>
      <td className="num">{formatCents(c)}</td>
      <td className={`num ${gap !== null && gap < 0 ? "text-crit" : "text-ink-2"}`}>{gap === null ? <span className="text-ink-3">—</span> : formatCents(gap)}</td>
    </tr>
  );
}

/** The three lines worth the most from the money list, read on their own so the books are not held up by them. */

/** Every row of the cash account with the bank lines that make it: the answer to "where did you get this?" on the page itself. */
type CashRow = { label: string; amountCents: number; note?: string; sources?: { on: string; what: string; amountCents: number; how: string }[] };
function AccountLines({ sections }: { sections: { title: string; rows: CashRow[] }[] }) {
  return (
    <div className="mt-2 space-y-3">
      {sections
        .filter((s) => s.rows.length > 0)
        .map((s) => (
          <div key={s.title}>
            <div className="font-semibold text-ink-2">{s.title}</div>
            <ul className="mt-1 divide-y divide-line">
              {s.rows.map((r) => (
                <li key={r.label} className="py-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0">
                      {r.label}
                      {r.note ? <span className="ml-1 text-ink-3">· {r.note}</span> : null}
                    </span>
                    <span className="tabular-nums">{formatCents(r.amountCents)}</span>
                  </div>
                  {r.sources && r.sources.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5 pl-3 text-ink-3">
                      {r.sources.map((x, i) => (
                        <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                          <span className="tabular-nums">{fmt(x.on)}</span>
                          <span className="min-w-0 grow truncate" title={x.what}>{x.what}</span>
                          <span className="tabular-nums">{formatCents(x.amountCents)}</span>
                          <span className="w-full text-[11px] sm:w-auto">{x.how}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
