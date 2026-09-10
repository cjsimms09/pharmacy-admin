import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { addCashReceipt, deleteCashReceipt, cashReceiptsFor } from "@/lib/expenses";
import { readBankStatement, lastStatementLines } from "./bank";
import { Field, Settled } from "@/components/ui";
import { formatCents, parseCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";
import { parsePeriod, periodOf, neighbours, type PeriodKind } from "@/lib/ledger";
import { booksFor, recentMonths } from "@/lib/ledger-store";
import { moneyFound } from "@/lib/money-found";
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

export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ period?: string; ok?: string; error?: string }> }) {
  await requireUser();
  const { period: periodParam, ok, error } = await searchParams;
  const today = todayIso();
  const period = (periodParam && parsePeriod(periodParam)) || periodOf("month", today.slice(0, 7));
  const [books, recent, found, banked, bankLines] = await Promise.all([booksFor(period, today), recentMonths(6, today), moneyFound().catch(() => null), cashReceiptsFor(period.months), lastStatementLines(period.months)]);
  const { accrual, cash, scripts, gap, pace, sources, countedOnce, feeds, difference, balances } = books;
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
  const hist = (pick: (r: (typeof recent)[number]) => number | null) => recent.map((r) => (r.pl.revenue.length ? pick(r) : null));
  const d = (now: number, before: number | null | undefined) => deltaOf(now, before, formatCents);

  return (
    <>
      <PageHeader
        tabs={familyTabs("money", "/money")}
        title="Money"
        subtitle="The books: what the period earned and what reached the bank, both kept, neither mixed."
        help={
          <>
            <p><b>Cost of goods comes from what was dispensed, not what was bought.</b> PioneerRx prints the acquisition cost of every fill, so the cost of what actually sold is known per bottle and no stocktake is needed. Purchases less dispensed cost is stock moving on or off the shelf, reported as cash, never as profit.</p>
            <p><b>Rebates reduce cost; they are never revenue.</b> Earned against the month that earned them on the accrual basis, received against the month they were banked on the cash basis.</p>
            <p><b>DIR fees come out of revenue, not overheads,</b> so the dispensing margin is not flattered.</p>
            <p><b>Cash and accrual are both true.</b> A prescription dispensed on the 30th is this month&rsquo;s earnings and next month&rsquo;s money. The gap is the receivable, and it is named rather than hidden.</p>
            <p><b>Every figure links to its rows.</b> A wrong figure is corrected on the linked page, never here. The specification is <code>docs/reference/money-ledger.md</code>.</p>
          </>
        }
        actions={
          <>
            <Link href="/expenses" className="btn">Spending</Link>
            <Link href="/money/found" className="btn">Money found</Link>
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/* The period, chosen and stated. Arrows step it; the three words change its size. */}
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
        {isCurrent && pace && <span className="text-xs text-ink-3">{pace.says}</span>}
      </div>

      {/*
        Months in the period with nothing on file at all.

        They are left out of the arithmetic rather than run through it as noughts — a month nobody
        has loaded a claim, a bill, a till report or a deposit for is not a month the pharmacy took
        nothing in, and a column of noughts says the second thing. Which makes naming them
        obligatory: a quarter quietly built from two months is a quarter read as three.
      */}
      {accrual.emptyMonths.length > 0 && (
        <Notice kind="warn">
          <b>
            {accrual.emptyMonths.length} of the {period.months.length} months in {period.label}{" "}
            {accrual.emptyMonths.length === 1 ? "has" : "have"} nothing on file.
          </b>{" "}
          {accrual.emptyMonths.join(", ")} {accrual.emptyMonths.length === 1 ? "is" : "are"} not in the figures below —
          not as noughts, not at all. Load the claims, the System Sales Summary, the bills or the deposits for
          {accrual.emptyMonths.length === 1 ? " it" : " them"} and {accrual.emptyMonths.length === 1 ? "it joins" : "they join"} the period.
        </Notice>
      )}

      {/*
        Computed, and leaning. Kept apart from the incomplete-account notice above: that one says
        the bottom line cannot be read at all, this one says it can be read and is too high. A
        pharmacist who is told everything is a crisis stops reading either.
      */}
      {accrual.usable && accrual.caveats.length > 0 && (
        <Notice kind="warn">
          <b>Right as far as it goes, and high.</b>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {accrual.caveats.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </Notice>
      )}

      {!accrual.usable && (
        <Notice kind="crit">
          <b>Not yet a complete account of {period.label}.</b> Until these are in, the bottom line is wrong in the flattering direction:
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {accrual.missing.slice(0, 6).map((m, i) => <li key={i}>{m}</li>)}
            {accrual.missing.length > 6 && <li>and {accrual.missing.length - 6} more on the statement.</li>}
            {accrual.caveats.map((c, i) => <li key={`c${i}`}>{c}</li>)}
          </ul>
          <span className="mt-1 block">
            Record them on <Link href="/expenses" className="underline">Spending</Link>.
          </span>
        </Notice>
      )}

      {/* The five figures the period comes down to, on the accrual basis, each a link to its rows. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat size="sm" value={formatCents(accrual.netRevenueCents)} label="Net revenue" sub={pace?.netRevenueCents ? `${formatCents(pace.netRevenueCents)} at this pace` : "after DIR and chargebacks"} tone="muted" href={sources.revenue} delta={d(accrual.netRevenueCents, previous?.pl.netRevenueCents)} history={hist((r) => r.pl.netRevenueCents)} />
        <Stat size="sm" value={formatCents(accrual.grossProfitCents)} label="Gross profit" sub={accrual.grossMarginPercent !== null ? `${accrual.grossMarginPercent}% of net revenue` : "cost of goods not known"} tone={tone(accrual.grossProfitCents)} href={sources.costOfGoods} delta={d(accrual.grossProfitCents, previous?.pl.grossProfitCents)} history={hist((r) => r.pl.grossProfitCents)} />
        <Stat size="sm" value={formatCents(accrual.operatingCents)} label="Keeping the doors open" sub={pct(accrual.operatingCents) ?? "operating costs entered"} tone="muted" href={sources.expenses} delta={d(accrual.operatingCents, previous?.pl.operatingCents)} upIsGood={false} history={hist((r) => r.pl.operatingCents)} />
        <Stat size="sm" value={formatCents(accrual.netProfitCents)} label={accrual.netProfitCents < 0 ? "Net loss" : "Net profit"} sub={accrual.usable ? "every line in" : "lines missing, see above"} tone={accrual.usable ? tone(accrual.netProfitCents) : "warn"} href={`/money/monthly?period=${period.key}`} delta={d(accrual.netProfitCents, previous?.pl.netProfitCents)} history={hist((r) => r.pl.netProfitCents)} />
        <Stat size="sm" value={scripts.scripts.toLocaleString()} label="Scripts" sub={scripts.perDay !== null ? `${scripts.perDay} a day · ${scripts.cash} cash` : "none in the period"} tone="muted" href={sources.scripts} delta={previous ? deltaOf(scripts.scripts, previous.scripts, (n) => String(n)) : null} history={recent.map((r) => (r.pl.revenue.length ? r.scripts : null))} />
      </div>

      {/* Both bases, side by side, and the gap said for what it is. */}
      <Card className="mt-4" title="Earned against banked" subtitle="Accrual is what the period earned; cash is what reached the bank and left it. The difference is money owed, not money missing.">
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
              <Line label="Revenue" a={accrual.revenueCents} c={cash.revenueCents} href={sources.revenue} note={cash.revenue.length === 0 ? "no receipts entered for the period" : undefined} />
              {(accrual.netRevenueCents !== accrual.revenueCents || cash.netRevenueCents !== cash.revenueCents) && (
                <Line label="Net revenue" a={accrual.netRevenueCents} c={cash.netRevenueCents} note="after DIR fees and chargebacks" />
              )}
              <Line label="Cost of goods" a={accrual.costOfGoodsCents} c={cash.costOfGoodsCents} href={sources.purchases} note={cash.costOfGoods.length === 0 ? "no wholesaler invoice falls in the period by its payment date or its terms" : undefined} />
              <Line label="Gross profit" a={accrual.grossProfitCents} c={cash.grossProfitCents} strong />
              <Line label="Operating" a={accrual.operatingCents} c={cash.operatingCents} href={sources.expenses} />
              <Line label="Net" a={accrual.netProfitCents} c={cash.netProfitCents} strong note="accrual: profit before tax · cash: net cash from operations" />
              {cash.otherCashOut.length > 0 && <Line label="Loan principal, draws, equipment, tax" a={0} c={cash.otherCashOutCents} note="not a cost; cash out all the same" />}
              <Line label="Cash change" a={null} c={cash.cashChangeCents ?? cash.netProfitCents} strong note="what the bank balance did in the period; there is no accrual side to it" />
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-2">{gap.says}</p>

        {/*
          Why the two columns differ, in parts that add to exactly the difference.

          Two bottom lines and no account of the gap between them invites the reader to decide one
          of them is wrong. It is not a discrepancy: it is the receivable, the payable, and the
          bills incurred and not yet paid, and each is worth knowing on its own. The parts are an
          identity rather than an estimate, so when they do not add up the page says so instead of
          printing four numbers that nearly work.
        */}
        {accrual.months.length > 0 && (
          <div className={`mt-3 rounded-lg border p-3 ${difference.adds ? "border-line bg-ground/40" : "border-crit bg-crit-soft"}`}>
            <p className="text-xs font-semibold">{difference.says}</p>
            <ul className="mt-1.5 space-y-1">
              {difference.parts.filter((x) => x.cents !== 0).map((x) => (
                <li key={x.what} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="tabular-nums font-semibold">{formatCents(x.cents)}</span>
                  <span className="font-medium">{x.what}</span>
                  <span className="min-w-0 grow text-ink-3">{x.says}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/*
          The statement adds up, or it does not and says where.

          Cheap, and it catches the one fault nobody spots by reading a page: a line in a list that
          is not in the total above it. On a quarter it is a real check rather than a tautology —
          the totals are added from the months while the lines are merged by label, so the two only
          agree if both are right.
        */}
        {balances.accrual.ok && balances.cash.ok ? (
          <p className="mt-2 text-[11px] text-ink-3">
            Every total above is the sum of its own lines and every subtotal follows from the one before it, on both bases. Checked when this page was drawn.
          </p>
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
          <p className="mt-1 text-xs text-ink-3">
            {formatCents(Math.abs(accrual.stockMovementCents))} {accrual.stockMovementCents > 0 ? "went onto the shelf" : "came off the shelf"} in the period: bought less dispensed. Not profit; where the cash went.
          </p>
        )}
      </Card>

      {/* What reached the bank, typed until the bank's statement is read; the cash account's revenue. */}
      <Card
        className="mt-4"
        title="What reached the bank"
        count={banked.length}
        subtitle="The cash account's revenue: each deposit by the month it arrived, never the month it was earned. A plan's remittance, the card and cash takings, a facilitator payment, a rebate cheque. Enter it net as it landed; a fee the payer took out of a deposit is already out of it."
      >
        {banked.length > 0 && (
          <div className="mb-3 overflow-x-auto">
            <table className="table text-sm">
              <thead><tr><th>Banked</th><th>Kind</th><th>Payer</th><th className="num">Amount</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                {banked.map((r) => (
                  <tr key={r.id}>
                    {/* The day it landed where a report gave one; the month where somebody typed it. */}
                    <td className="whitespace-nowrap">{r.receivedOn ?? r.month}</td>
                    <td>{KINDS.find((k) => k.key === r.kind)?.label ?? r.kind}</td>
                    <td className="text-ink-2">{r.payer ?? "—"}</td>
                    <td className="num">{formatCents(r.amountCents)}</td>
                    <td className="text-xs text-ink-3">{r.notes ?? ""}</td>
                    <td>
                      {/* A payment banked from a report is removable like any other: the bank statement is the record. */}
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
        {/*
          * The whole month of plan deposits, in one file, rather than typed one at a time.
          *
          * It is the same money the form below records, read off the payer's own report: a payment
          * number, a payer, the day it was deposited and the amount. Keyed on the payment number,
          * so a report re-run for an overlapping range banks only what is new — these reports are
          * date ranges and a date range gets re-run.
          */}
        <div className="mb-4 rounded-lg border border-line bg-ground/40 p-3">
          <form action={uploadPayments} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="period" value={period.key} />
            <Field label="A payer payment report" hint="The CSV from the remittance service, any date range.">
              <input type="file" name="file" accept=".csv,.txt" className="w-full text-xs" />
            </Field>
            <button className="btn btn-primary">Bank the report</button>
          </form>
          <p className="mt-2 text-xs text-ink-3">
            Sent to the site&rsquo;s mailbox it files itself; this is for a range that was missed. Each payment is
            banked in the month it was <b>deposited</b>, and a payment already held is never banked twice. The
            report&rsquo;s remittance and claim-match columns are recorded and not yet used by any figure —
            they belong to the 835 work.
          </p>
        </div>

        <form action={bankIt} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <input type="hidden" name="period" value={period.key} />
          <Field label="Month it arrived">
            <input type="month" name="month" defaultValue={period.months[period.months.length - 1]} required className="w-full" />
          </Field>
          <Field label="Kind">
            <select name="kind" className="w-full" defaultValue="third_party">
              {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Amount, in dollars">
            <input name="amount" inputMode="decimal" placeholder="12345.67" required className="w-full" />
          </Field>
          <Field label="Payer" hint="The PBM, the card processor, the wholesaler.">
            <input name="payer" placeholder="Caremark" className="w-full" />
          </Field>
          <Field label="Notes">
            <input name="notes" className="w-full" />
          </Field>
          <div className="flex items-end"><button className="btn btn-primary">Bank it</button></div>
        </form>
        {/*
          The bank's own statement, read in. Deposits from a payer the site knows are banked;
          a payment that exactly matches one open bill or invoice from the name on it marks it
          paid; everything else is listed here to be placed by hand. Every line is remembered,
          so the same export read twice banks nothing twice.
        */}
        <form action={readBankStatement} encType="multipart/form-data" className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <input type="hidden" name="period" value={period.key} />
          <Field label="Or read the bank's statement" hint="The CSV export from the bank's site: date, description, amount.">
            <input type="file" name="file" accept=".csv,.txt" required className="w-full" />
          </Field>
          <button className="btn">Read the statement</button>
        </form>
        {bankLines.unplaced.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold">{bankLines.unplaced.length} line{bankLines.unplaced.length === 1 ? "" : "s"} from the statement not placed</p>
            <ul className="mt-1 max-h-48 overflow-auto text-xs text-ink-2">
              {bankLines.unplaced.map((l) => (
                <li key={l.id} className="flex flex-wrap gap-2 py-0.5">
                  <span className="tabular-nums">{l.on}</span>
                  <span className="min-w-0 grow truncate">{l.description}</span>
                  <span className={`tabular-nums ${l.amountCents < 0 ? "text-crit" : ""}`}>{formatCents(l.amountCents)}</span>
                  <span className="text-ink-3">{l.why}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-ink-3">A deposit here is banked with the form above; a payment is marked paid on Spending or the invoices page.</p>
          </div>
        )}
        {bankLines.placed > 0 && bankLines.unplaced.length === 0 && (
          <p className="mt-2 text-xs text-ink-3">{bankLines.placed} statement lines placed in this period; nothing left over.</p>
        )}
      </Card>

      {/* The trend, because the trend is the point here. Each bar opens its month. */}
      <Card className="mt-4" title="The last six months" subtitle="Net revenue and gross profit on the accrual basis, with scripts. A bar with nothing on it is a month with no account.">
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
                {recent.map((r) => <th key={r.month} className="num">{r.month}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr><td>Scripts</td>{recent.map((r) => <td key={r.month} className="num">{r.scripts.toLocaleString()}</td>)}</tr>
              <tr><td>Gross margin</td>{recent.map((r) => <td key={r.month} className="num">{r.pl.grossMarginPercent !== null ? `${r.pl.grossMarginPercent}%` : "—"}</td>)}</tr>
              <tr><td>Net</td>{recent.map((r) => <td key={r.month} className={`num ${r.pl.netProfitCents < 0 ? "text-crit" : ""}`}>{r.pl.revenue.length ? formatCents(r.pl.netProfitCents) : "—"}</td>)}</tr>
              <tr><td>Complete</td>{recent.map((r) => <td key={r.month} className="num">{r.pl.usable ? "yes" : `${r.pl.missing.length} missing`}</td>)}</tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {/* What the period's cost of goods was checked against. A finding is a finding on the statement. */}
        <Card title="Does it tie out?" subtitle="Each month's figures against their independent record.">
          <ul className="rows">
            {accrual.months.map((m) => {
              const checks = [...m.reconciliation.cogs.checks, ...m.reconciliation.revenue];
              const findings = checks.filter((c) => !c.expected && c.agrees === false).length;
              const ties = checks.filter((c) => c.agrees === true).length;
              return (
                <li key={m.month} className="row">
                  <div className="min-w-0">
                    <div className="row-title">
                      <Link href={`/money/monthly?period=${m.month}`} className="text-accent underline">{m.month}</Link>
                      {findings > 0 ? <span className="badge badge-warn ml-2">{findings} to look at</span> : ties > 0 ? <span className="badge badge-ok ml-2">ties</span> : <span className="badge badge-muted ml-2">not enough held</span>}
                    </div>
                    <p className="row-why">{checks.map((c) => c.what).join(" · ")}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* The three lines worth the most from the money list, so the books lead to the action. */}
        <Card title="Worth the most right now" subtitle="From the money list: amounts this site can see and what to do about each." actions={<Link href="/money/found" className="btn btn-sm">All of it</Link>}>
          {found && found.rows.length > 0 ? (
            <ol className="rows">
              {found.rows.slice(0, 3).map((r) => (
                <li key={r.key} className="row">
                  <div className="min-w-0">
                    <div className="row-title">{r.says}</div>
                    <p className="row-why">{r.todo}</p>
                  </div>
                  <div className="whitespace-nowrap text-right text-sm">
                    <Link href={r.href} className="font-semibold tabular-nums text-accent">{formatCents(r.amountCents)}</Link>
                    <span className="block text-[11px] text-ink-3">{r.cadence === "recurring_monthly" ? "a month" : "one-off"}</span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-ink-3">Nothing on the list yet. It fills in as invoices, catalogues and claims arrive.</p>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {/*
          Counted once, and the working shown.

          The risk is never that somebody adds a number twice on purpose. It is that two feeds
          arrive carrying the same money in different words — the till report's prescription line
          and the claims, the wholesaler's rebate statement and the estimate from the ladder — and
          both are true, and adding both is the natural thing for a program to do. Each pair is
          decided in one place and listed here, so the decision is on the page rather than in a
          branch nobody will read.
        */}
        <Card title="Counted once" subtitle="Money this pharmacy has on file in two places, which record the books believe, and what that kept out of this period.">
          {/*
            The checks that found nothing are one line between them.

            Seven of these run every draw and each printed two paragraphs to say "one record only".
            That is seven subsections of prose to report that nothing happened, above the one or two
            where a decision was actually taken and money was actually kept out. The reasoning is
            still here, a tap away, because it is what makes the figure auditable — but a question
            with no answer to give does not get the same room as one that does.
          */}
          {countedOnce.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing recorded in this period, so there is nothing that could have been counted twice.</p>
          ) : (
            <ul className="rows">
              {[...countedOnce].filter((r) => r.bothPresent).map((r) => (
                <li key={r.what} className="row">
                  <div className="min-w-0">
                    <div className="row-title">
                      {r.what}
                      {r.bothPresent ? <span className="badge badge-ok ml-2">both on file, counted once</span> : <span className="badge badge-muted ml-2">one record only</span>}
                    </div>
                    <p className="row-why">{r.says}</p>
                    <p className="row-why text-ink-3">{r.rule}</p>
                  </div>
                  {r.keptOutCents !== null && r.keptOutCents !== 0 && (
                    <div className="whitespace-nowrap text-right text-sm">
                      <span className="font-semibold tabular-nums">{formatCents(Math.abs(r.keptOutCents))}</span>
                      <span className="block text-[11px] text-ink-3">kept out</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {countedOnce.some((r) => !r.bothPresent) && (
            <Settled
              className="mt-2"
              says={`${countedOnce.filter((r) => !r.bothPresent).length} more checked, each with one record only — nothing to decide between.`}
            >
              <ul className="space-y-2">
                {countedOnce.filter((r) => !r.bothPresent).map((r) => (
                  <li key={r.what}>
                    <b>{r.what}.</b> {r.says}
                  </li>
                ))}
              </ul>
            </Settled>
          )}
        </Card>

        {/*
          What is not in the books, said out loud.

          The second requirement — "needs to not forget about expenses or revenue it knows" —
          cannot be met by looking at the account, because what is being looked for is not on it.
          It can only be met by listing every feed that carries money and saying what the books do
          with each. Three reach neither basis today, and "deliberately outside the account" and
          "nobody has wired it up" look identical until somebody writes down which is which.
        */}
        <Card
          title="What is in the books, and what is not"
          subtitle="Every feed this site holds that carries money, and where each one lands. The ones that reach neither account are named with what that costs."
          actions={<span className="text-xs text-ink-3">{feeds.filter((f) => f.reaches === "none").length} reach neither</span>}
        >
          <ul className="rows">
            {/*
              A feed that reaches an account is doing its job. Fourteen of them explaining that at
              two paragraphs each buried the four that reach neither, which are the only ones that
              cost anything.
            */}
            {[...feeds].filter((f) => f.reaches === "none" || f.gap).sort((a, b) => Number(!!b.gap) - Number(!!a.gap)).map((f) => (
              <li key={f.name} className="row">
                <div className="min-w-0">
                  <div className="row-title">
                    <Link href={f.href} className="text-accent underline">{f.name}</Link>
                    <span className={`badge ml-2 ${f.reaches === "none" ? "badge-warn" : "badge-muted"}`}>
                      {f.reaches === "none" ? "on no account" : f.reaches === "both" ? "both bases" : f.reaches}
                    </span>
                  </div>
                  <p className="row-why">{f.how}</p>
                  {f.gap && <p className="row-why text-warn">{f.gap}</p>}
                </div>
              </li>
            ))}
          </ul>
          {feeds.some((f) => f.reaches !== "none" && !f.gap) && (
            <Settled
              className="mt-2"
              says={`${feeds.filter((f) => f.reaches !== "none" && !f.gap).length} more feeds, each landing where it should.`}
            >
              <ul className="space-y-2">
                {feeds
                  .filter((f) => f.reaches !== "none" && !f.gap)
                  .map((f) => (
                    <li key={f.name}>
                      <b>{f.name}</b> &mdash; {f.carries}, {f.reaches}. {f.how}
                    </li>
                  ))}
              </ul>
            </Settled>
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Every figure links to the rows it was added from; a wrong figure is corrected there, never here. The statement carries every
        line with its source, printable and as a file: <Link href={`/money/monthly?period=${period.key}`} className="text-accent underline">open it</Link>.
      </p>
    </>
  );
}

/** One statement line. `a` null means the line has no accrual meaning, and neither column pretends it does. */
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
