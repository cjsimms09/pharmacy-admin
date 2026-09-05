import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fmt } from "@/lib/dates";
import {
  invoices,
  awaitingReview,
  invoiceCounts,
  invoiceIssues,
  invoiceSuppliers,
  invoiceMonths,
  setSchedule,
  setInvoiceDate,
  forwardInvoices,
  recentForwards,
  parseExpected,
  adoptableDocuments,
  adoptAll,
  uploadInvoice,
  filingFor,
  setInvoiceTotal,
  backfillTotals,
  missingTotals,
  sumOf,
  money,
} from "@/lib/invoices";
import { invoiceCompliance, RETENTION_YEARS } from "@/lib/invoice-compliance";
import { setSetting } from "@/lib/settings";
import { getSettings } from "@/lib/settings";
import { PageHeader, Card, Figure, Notice, Empty } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { INVOICE_SCHEDULES, type InvoiceSchedule } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supplier invoices" };

const TABS: { key: InvoiceSchedule | "all"; label: string; blurb: string }[] = [
  {
    key: "schedule_2",
    label: "Schedule II",
    blurb:
      "Kept separately from every other record the pharmacy holds, as 21 CFR 1304.04(h)(1) requires — its own category, its own folder on disk, and this list, which contains nothing else.",
  },
  {
    key: "schedule_3_5",
    label: "Schedule III-V",
    blurb:
      "21 CFR 1304.04(h)(2) allows these to be separate or merely readily retrievable. They are separate, which satisfies the stricter reading of the two.",
  },
  { key: "none", label: "No controlled substances", blurb: "Ordinary business records." },
  { key: "all", label: "Everything", blurb: "Every supplier invoice, whatever it carries." },
];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

/**
 * Every supplier invoice, filed by what it carries and findable by what is on it.
 *
 * The rule people read as "keep paper" is about separation, not medium. Schedule II records are
 * maintained separately from all other records of the registrant; Schedule III-V either
 * separately or readily retrievable. The test an electronic system has to pass is whether
 * somebody can produce every Schedule II invoice for a period, on its own, without sorting
 * through anything — which is the top of this page.
 *
 * Everything below it is the other half: the questions a pharmacist actually asks between
 * inspections. When did we last buy oxycodone. What did McKesson send in March. Send the
 * accountant last quarter. None of those are answerable by an archive that only knows the number
 * on the front of each document, so the item lines are searchable and the invoices can be sent
 * on from here.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    q?: string;
    month?: string;
    supplier?: string;
    from?: string;
    to?: string;
    on?: string;
    min?: string;
    max?: string;
    noamount?: string;
    unconfirmed?: string;
    undated?: string;
    ok?: string;
    error?: string;
  }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const active = (TABS.find((t) => t.key === sp.tab) ?? TABS[3]).key;
  const canManage = user.role !== "staff";
  const onlyUnconfirmed = sp.unconfirmed === "1";
  const onlyUndated = sp.undated === "1";
  const onlyNoAmount = sp.noamount === "1";
  // An empty box and a zero are different answers, so a blank never becomes a filter.
  const dollars = (v: string | undefined) => (v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

  const [rows, review, counts, issues, suppliers, months, sent, s, adoptable, complianceRows] = await Promise.all([
    invoices({
      schedule: active === "all" ? undefined : active,
      text: sp.q,
      month: sp.month,
      supplier: sp.supplier,
      from: sp.from,
      to: sp.to,
      on: sp.on,
      minAmount: dollars(sp.min),
      maxAmount: dollars(sp.max),
      noAmount: onlyNoAmount || undefined,
      unconfirmed: onlyUnconfirmed || undefined,
    }),
    awaitingReview(),
    invoiceCounts(),
    invoiceIssues(),
    invoiceSuppliers(),
    invoiceMonths(),
    recentForwards(5),
    getSettings(),
    adoptableDocuments(),
    invoiceCompliance(),
  ]);
  const noAmountCount = await missingTotals();
  const compliance = complianceRows;
  const unmet = compliance.filter((c) => c.state === "attention");

  const shown = onlyUndated ? rows.filter((r) => !r.invoiceDate) : rows;
  const rules = (s.mail_supplier_rules ?? "").trim();
  const filtered = Boolean(
    sp.q || sp.month || sp.supplier || sp.from || sp.to || sp.on || sp.min || sp.max || onlyUnconfirmed || onlyUndated || onlyNoAmount,
  );
  const totals = sumOf(shown);
  const expectations = parseExpected(s.supplier_expected_schedule ?? "");

  async function confirm(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const schedule = String(fd.get("schedule") ?? "") as InvoiceSchedule;
    if (!INVOICE_SCHEDULES.includes(schedule)) {
      redirect("/inventory/invoices?error=" + encodeURIComponent("Pick a schedule."));
    }
    try {
      await setSchedule(id, schedule, u);
      await audit({ action: "invoice.schedule", userId: u.id, userName: u.name, entity: "invoice", entityId: id, details: schedule });
      revalidatePath("/inventory/invoices");
      redirect("/inventory/invoices?ok=" + encodeURIComponent(`Filed under ${filingFor(schedule).label}, and moved out of everything else.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not change that."));
    }
  }

  async function dateIt(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await setInvoiceDate(id, String(fd.get("invoiceDate") ?? ""), u);
      await audit({ action: "invoice.date", userId: u.id, userName: u.name, entity: "invoice", entityId: id });
      revalidatePath("/inventory/invoices");
      redirect("/inventory/invoices?undated=1&ok=" + encodeURIComponent("Dated, so it comes back in a date range now."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?undated=1&error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not set that date."));
    }
  }

  /*
   * The amount, where the invoice would not say it clearly enough to read.
   *
   * One of this pharmacy's three wholesalers prints subtotals by schedule and no single figure
   * for the invoice, so there is nothing safe to read. Adding the parts up and calling the result
   * the total would put a number the site invented onto a financial record that gets reconciled
   * against a payment — a blank somebody fills in is the honest version of not knowing.
   */
  async function amount(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await setInvoiceTotal(id, Number(fd.get("dollars") ?? NaN), u);
      await audit({ action: "invoice.total", userId: u.id, userName: u.name, entity: "invoice", entityId: id });
      revalidatePath("/inventory/invoices");
      redirect("/inventory/invoices?noamount=1&ok=" + encodeURIComponent("Amount saved, and counted in the totals from now on."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?noamount=1&error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that amount."));
    }
  }

  /**
   * Reads the amounts off invoices filed before amounts were recorded.
   *
   * The reading happens once, as an invoice is filed, and nothing went back for the ones already
   * on file — so their totals were blank for good, against PDFs that plainly print a figure. That
   * looks like a broken reader rather than a question never asked.
   */
  async function readAmounts() {
    "use server";
    const u = await requireManager();
    const r = await backfillTotals();
    await audit({ action: "invoice.totals.backfill", userId: u.id, userName: u.name, details: `${r.read}` });
    revalidatePath("/inventory/invoices");
    redirect(
      "/inventory/invoices?ok=" +
        encodeURIComponent(
          r.read === 0
            ? `No amount could be read off ${r.stillMissing} invoice${r.stillMissing === 1 ? "" : "s"}. Some wholesalers print subtotals by schedule and no invoice total — those have to be typed in.`
            : `${r.read} amount${r.read === 1 ? "" : "s"} read off the invoices themselves.` +
              (r.stillMissing > 0
                ? ` ${r.stillMissing} still print no total that can be read — type those in below.`
                : " Every invoice now has an amount."),
        ),
    );
  }

  async function send(fd: FormData) {
    "use server";
    const u = await requireManager();
    const ids = fd.getAll("pick").map(String).filter(Boolean);
    const back = String(fd.get("back") ?? "/inventory/invoices");
    try {
      const r = await forwardInvoices(ids, String(fd.get("to") ?? ""), String(fd.get("note") ?? ""), u);
      await audit({ action: "invoice.forward", userId: u.id, userName: u.name, details: `${r.sent} to ${r.to}` });
      revalidatePath("/inventory/invoices");
      redirect(`${back}${back.includes("?") ? "&" : "?"}ok=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`${back}${back.includes("?") ? "&" : "?"}error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
    }
  }

  async function saveExpected(fd: FormData) {
    "use server";
    const u = await requireManager();
    await setSetting("supplier_expected_schedule", String(fd.get("expected") ?? "").trim());
    await audit({ action: "invoice.expectations", userId: u.id, userName: u.name });
    revalidatePath("/inventory/invoices");
    redirect(
      "/inventory/invoices?ok=" +
        encodeURIComponent(
          "Saved. Nothing is filed differently because of this — it is only used to tell you when a supplier sends something they never send.",
        ),
    );
  }

  async function fileThem() {
    "use server";
    const u = await requireManager();
    const r = await adoptAll({ userId: u.id, userName: u.name });
    await audit({ action: "invoice.adopt", userId: u.id, userName: u.name, details: `${r.filed}` });
    revalidatePath("/inventory/invoices");
    redirect(
      `/inventory/invoices?${r.problems.length ? "error" : "ok"}=` +
        encodeURIComponent(
          [
            r.filed
              ? `${r.filed} document${r.filed === 1 ? "" : "s"} filed as supplier invoices and sorted by schedule`
              : "Nothing could be filed",
            ...r.problems.slice(0, 3),
          ].join(". ") + ".",
        ),
    );
  }

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) {
      redirect("/inventory/invoices?error=" + encodeURIComponent("Choose a PDF."));
    }
    try {
      const r = await uploadInvoice(file as File, { userId: u.id, userName: u.name });
      await audit({ action: "invoice.upload", userId: u.id, userName: u.name, details: r.schedule });
      revalidatePath("/inventory/invoices");
      redirect(
        "/inventory/invoices?ok=" +
          encodeURIComponent(
            r.needsReview
              ? "Filed with the Schedule II records until you say what it carries — that is the cautious side, and the only safe one."
              : `Filed under ${filingFor(r.schedule).label}.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read that file."));
    }
  }

  const here = `/inventory/invoices?${new URLSearchParams(
    Object.entries(sp).filter(([k, v]) => v && k !== "ok" && k !== "error") as [string, string][],
  ).toString()}`;

  return (
    <>
      <PageHeader
        back={{ href: "/inventory", label: "Controlled substances" }}
        title="Supplier invoices"
        subtitle="Emailed in by the supplier, read on arrival, and filed by what each one carries. Schedule II invoices are kept apart from everything else, which is what the rule actually asks for."
        actions={
          <>
            <Link href="/suppliers" className="btn">Suppliers</Link>
            <Link href="#compliance" className={`btn ${unmet.length ? "btn-primary" : ""}`}>
              {unmet.length ? `${unmet.length} thing${unmet.length === 1 ? "" : "s"} to settle` : "How this meets the rules"}
            </Link>
          </>
        }
      />

      {sp.ok && <Notice kind="ok">{sp.ok}</Notice>}
      {sp.error && <Notice kind="crit">{sp.error}</Notice>}

      {!rules && (
        <Notice kind="warn">
          <b>No sender is named as a supplier yet, so nothing will be filed as an invoice.</b> Add your wholesalers
          on the <Link href="/suppliers" className="underline">Suppliers</Link> page, with the addresses they send
          from, then ask them to email invoices to this mailbox. From then on it happens with nobody doing
          anything.
        </Notice>
      )}

      {/*
        What is wrong, before what is here.

        A mail-fed archive fails silently — the supplier changes the address they send from and the
        invoices simply stop, with no error anywhere. Records the pharmacy is required to keep stop
        being kept, and the only symptom is a quiet list. So the failures come first on the page,
        and each says what to do rather than only what is wrong.
      */}
      {issues.length > 0 && (
        <Card
          tone={issues.some((i) => i.severity === "blocking") ? "crit" : "warn"}
          title="Needs attention"
          count={issues.length}
          className="mt-4 mb-6"
        >
          <ul className="rows">
            {issues.map((i) => (
              <li key={i.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={`badge ${i.severity === "blocking" ? "badge-crit" : "badge-warn"}`}>
                      {i.severity === "blocking" ? "fix this" : "look at"}
                    </span>
                    <span className="text-sm font-medium">{i.title}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-3">{i.detail}</p>
                </div>
                {i.href && (
                  <Link href={i.href} className="btn btn-sm shrink-0">{i.action ?? "Open"}</Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        Invoices the site already holds but never filed as invoices.

        Everything that arrived before this screen existed went into the document vault as an
        ordinary report, and so did anything from a sender not yet named as a supplier. They are
        in the building and not on this page, which is the worst of both worlds: the pharmacy
        holds Schedule II records it cannot produce on demand and believes it holds none.
      */}
      {adoptable.length > 0 && canManage && (
        <Card
          tone="warn"
          title="Already received, but not filed as invoices"
          count={adoptable.length}
          subtitle="These arrived by email and went into the document vault before this screen existed, or came from a sender not yet named as a supplier. Filing them reads each one and sorts it by schedule, exactly as an incoming one would be."
          className="mt-4 mb-6"
          actions={
            <form action={fileThem}>
              <button className="btn btn-sm btn-primary">File all {adoptable.length}</button>
            </form>
          }
        >
          <ul className="rows">
            {adoptable.slice(0, 12).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <a href={`/files/${d.id}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                    {d.title}
                  </a>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {[d.fileName, d.receivedFrom, d.effectiveOn ? fmt(d.effectiveOn) : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {adoptable.length > 12 && (
            <p className="mt-2 text-xs text-ink-3">and {adoptable.length - 12} more — all of them are filed by the one button.</p>
          )}
        </Card>
      )}

      {/*
        Amounts that were never read, offered as one press rather than a filter to discover.
        
        The entry form existed but only appeared behind a query string nobody would guess at, and
        the reason the amounts were blank — that nothing ever went back over invoices filed before
        the column existed — was invisible. Both are said here, where the blanks are seen.
      */}
      {noAmountCount > 0 && canManage && (
        <Card
          tone="warn"
          title={`${noAmountCount} invoice${noAmountCount === 1 ? " has" : "s have"} no amount`}
          subtitle="Anything filed before this system recorded amounts has a blank one, because the reading happens as an invoice is filed and nothing went back over the older ones. The PDFs are still here, so they can be read now."
          className="mt-4 mb-6"
          actions={
            <>
              <form action={readAmounts}>
                <SubmitButton className="btn btn-sm btn-primary" pendingLabel="Reading…">
                  Read them off the invoices
                </SubmitButton>
              </form>
              <Link href="/inventory/invoices?noamount=1" className="btn btn-sm">Type them in</Link>
            </>
          }
        >
          <p className="text-xs text-ink-3">
            Only a labelled total is ever read — net payable, total due, amount due, invoice total, balance due — and
            in that order, because one wholesaler prints both a purchases figure and a payable and only the second is
            what you are billed. An invoice that prints no total at all comes back blank and has to be typed in: that
            is IPD, which shows subtotals by schedule and no single figure. A number assembled from parts would be one
            this system invented, on a record that gets reconciled against a payment.
          </p>
        </Card>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Figure value={counts.schedule_2} label="Schedule II" sub="Kept apart from everything" href="/inventory/invoices?tab=schedule_2" tone={counts.schedule_2 ? "ok" : "muted"} />
        <Figure value={counts.schedule_3_5} label="Schedule III-V" sub="Also kept apart" href="/inventory/invoices?tab=schedule_3_5" tone="muted" />
        <Figure value={counts.none} label="No controlled lines" sub="Ordinary business records" href="/inventory/invoices?tab=none" tone="muted" />
        <Figure
          value={counts.review}
          label="Waiting on you"
          sub={counts.review ? "Held with the C2s until confirmed" : "Nothing unread"}
          href="/inventory/invoices?unconfirmed=1"
          tone={counts.review ? "warn" : "ok"}
        />
      </div>

      {review.length > 0 && !filtered && (
        <Card
          tone="warn"
          title="Read but not certain"
          count={review.length}
          subtitle="Each of these is held with the Schedule II records, because assuming the other way is the one mistake that breaks the rule. Say what it carries and it moves."
          className="mt-4 mb-6"
        >
          <ul className="rows">
            {review.slice(0, 8).map((i) => (
              <li key={i.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
                    {[i.supplier, i.invoiceNumber].filter(Boolean).join(" · ") || "Invoice"}
                  </a>
                  <span className="text-xs text-ink-3">{i.invoiceDate ? fmt(i.invoiceDate) : "no date read"}</span>
                </div>
                {i.basis && <p className="mt-1 text-xs text-ink-3">{i.basis}</p>}
                {i.controlledItems && <p className="mt-1 whitespace-pre-wrap text-xs text-ink-2">{i.controlledItems}</p>}
                {canManage && (
                  <form action={confirm} className="mt-2 flex flex-wrap items-center gap-1.5">
                    <input type="hidden" name="id" value={i.id} />
                    <select name="schedule" className="field w-auto py-1 text-xs" defaultValue="">
                      <option value="" disabled>What does it carry?</option>
                      <option value="schedule_2">A Schedule II line</option>
                      <option value="schedule_3_5">Schedule III-V only</option>
                      <option value="none">No controlled substances</option>
                    </select>
                    <button className="btn btn-sm btn-primary">File it</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {review.length > 8 && (
            <p className="mt-2 text-xs text-ink-3">
              <Link href="/inventory/invoices?unconfirmed=1" className="underline">and {review.length - 8} more</Link>
            </p>
          )}
        </Card>
      )}

      {/* ── Finding one ──────────────────────────────────────────────── */}
      <Card
        title="Find an invoice"
        subtitle="Search runs over the invoice number, the supplier, the date and every item line — so an invoice number, a drug name or an NDC all find the invoice they belong to. Part of a number is enough."
        className="mt-6"
      >
        <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="tab" value={active} />
          <label className="text-xs font-medium text-ink-2 lg:col-span-2">
            Anything on it
            <input
              name="q"
              defaultValue={sp.q}
              placeholder="7656147111, oxycodone, an NDC"
              className="field mt-1"
            />
          </label>
          <label className="text-xs font-medium text-ink-2">
            Month
            <select name="month" defaultValue={sp.month ?? ""} className="field mt-1">
              <option value="">Any month</option>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-2">
            Supplier
            <select name="supplier" defaultValue={sp.supplier ?? ""} className="field mt-1">
              <option value="">Any supplier</option>
              {suppliers.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-2">
            On this exact day
            <input type="date" name="on" defaultValue={sp.on} className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            From
            <input type="date" name="from" defaultValue={sp.from} className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            To
            <input type="date" name="to" defaultValue={sp.to} className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            Amount at least
            <input type="number" step="0.01" min="0" name="min" defaultValue={sp.min} placeholder="$" className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            Amount at most
            <input type="number" step="0.01" min="0" name="max" defaultValue={sp.max} placeholder="$" className="field mt-1" />
          </label>
          <div className="flex flex-wrap items-end gap-3 lg:col-span-2">
            <button className="btn btn-primary">Search</button>
            {filtered && <Link href={`/inventory/invoices?tab=${active}`} className="btn">Clear</Link>}
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" name="noamount" value="1" defaultChecked={onlyNoAmount} />
              Only ones with no amount read
            </label>
          </div>
          <p className="text-xs text-ink-3 lg:col-span-4">
            A day on its own answers &ldquo;what came in on the 4th&rdquo;. From and To answer a quarter. An exact day
            wins over a range if both are filled in, and a month over either.
          </p>
        </form>
      </Card>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/inventory/invoices?${new URLSearchParams({
              ...Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== "ok" && k !== "error" && k !== "tab") as [string, string][]),
              tab: String(t.key),
            }).toString()}`}
            className={`btn btn-sm ${active === t.key ? "btn-primary" : ""}`}
          >
            {t.label}
            {t.key !== "all" && <span className="ml-1.5 opacity-70">{counts[t.key as InvoiceSchedule]}</span>}
          </Link>
        ))}
      </div>

      {/*
        Selecting and sending, as one form around the table.

        The alternative was finding each PDF, then attaching them by hand in a mail client, which
        is how the accountant ends up with the wrong month and nobody can afterwards say what was
        sent. Every send is recorded — who, what, when, and whether Schedule II records were in it,
        because forwarding one of those is a disclosure.
      */}
      <form action={send}>
        <input type="hidden" name="back" value={here} />
        <Card
          title={onlyUndated ? "Invoices with no date" : TABS.find((t) => t.key === active)!.label}
          count={shown.length}
          subtitle={onlyUndated ? "In the archive, but not retrievable by date — which is what an inspector asks for." : TABS.find((t) => t.key === active)!.blurb}
          className="mt-3"
        >
          {shown.length === 0 ? (
            <Empty>
              {filtered
                ? "Nothing matches that. Clear the search to see everything."
                : "Nothing here yet. Ask the supplier to email invoices to the mailbox this site reads, and they file themselves."}
            </Empty>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      {canManage && <th className="w-8"></th>}
                      <th>Date</th><th>Supplier</th><th>Invoice</th><th className="text-right">Amount</th><th>Carries</th><th>Lines</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i) => (
                      <tr key={i.id}>
                        {canManage && (
                          <td className="align-top">
                            <input type="checkbox" name="pick" value={i.id} aria-label={`Select invoice ${i.invoiceNumber ?? ""}`} />
                          </td>
                        )}
                        <td className="whitespace-nowrap align-top text-xs">
                          {i.invoiceDate ? (
                            fmt(i.invoiceDate)
                          ) : canManage ? (
                            <span className="inline-flex flex-col gap-1">
                              <span className="badge badge-crit">no date</span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="align-top text-sm">{i.supplier ?? "—"}</td>
                        <td className="align-top font-mono text-xs">{i.invoiceNumber ?? "—"}</td>
                        <td className="whitespace-nowrap align-top text-right font-mono text-xs">
                          {i.totalCents === null ? (
                            <Link href="/inventory/invoices?noamount=1" className="badge badge-muted">no amount</Link>
                          ) : (
                            money(i.totalCents)
                          )}
                        </td>
                        <td className="align-top">
                          <span className={`badge ${i.schedule === "schedule_2" ? "badge-crit" : i.schedule === "schedule_3_5" ? "badge-warn" : "badge-muted"}`}>
                            {filingFor(i.schedule).label}
                          </span>
                          {i.needsReview && !i.reviewedAt && <span className="badge badge-warn ml-1">unconfirmed</span>}
                        </td>
                        <td className="max-w-[24rem] align-top whitespace-pre-wrap text-xs text-ink-2">
                          {i.controlledItems || <span className="text-ink-3">no controlled lines</span>}
                        </td>
                        <td className="whitespace-nowrap align-top">
                          <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="btn btn-sm">Open</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/*
                    What the shown invoices come to.
                    It follows the filter rather than the whole archive, so "August, McKesson" is
                    also the answer to "what did we spend with McKesson in August" — which is the
                    question actually asked of an invoice file between inspections.
                  */}
                  <tfoot>
                    <tr className="border-t border-line font-medium">
                      <td colSpan={canManage ? 4 : 3} className="pt-2 text-xs text-ink-2">
                        {shown.length} invoice{shown.length === 1 ? "" : "s"}
                        {filtered ? " matching this search" : ""}
                      </td>
                      <td className="pt-2 text-right font-mono text-sm">{money(totals.total)}</td>
                      <td colSpan={3} className="pt-2 pl-2 text-xs text-ink-3">
                        {totals.missing > 0 && (
                          <>
                            excludes{" "}
                            <Link href="/inventory/invoices?noamount=1" className="underline">
                              {totals.missing} with no amount read
                            </Link>
                          </>
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {canManage && (
                <div className="mt-4 border-t border-line pt-4">
                  <h3 className="text-sm font-semibold">Send the ones you have ticked</h3>
                  <p className="mt-0.5 text-xs text-ink-3">
                    They go as attachments, with a list of what is in the message. Every send is recorded against your
                    name, and a send containing Schedule II records says so.
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <label className="text-xs font-medium text-ink-2">
                      To
                      <input name="to" type="email" required placeholder="accountant@example.com" className="field mt-1" />
                    </label>
                    <label className="text-xs font-medium text-ink-2 sm:col-span-2">
                      Anything to say with it
                      <input name="note" placeholder="August invoices, as asked" className="field mt-1" />
                    </label>
                  </div>
                  <button className="btn btn-primary mt-2">Send by email</button>
                </div>
              )}
            </>
          )}

          <p className="mt-3 text-xs text-ink-3">
            Kept for five years, which is the Kansas retention period and longer than the two years 21 CFR 1304.04(a)
            requires. Every one is in the daily backup, and nothing here is deleted when a supplier account closes.
          </p>
        </Card>
      </form>

      {onlyUndated && canManage && shown.length > 0 && (
        <Card title="Put a date on each of these" className="mt-4" subtitle="Taken from the invoice itself — the billing date, not the day it arrived.">
          <ul className="rows">
            {shown.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                  {[i.supplier, i.invoiceNumber].filter(Boolean).join(" · ") || "Invoice"}
                </a>
                <form action={dateIt} className="flex items-center gap-1.5">
                  <input type="hidden" name="id" value={i.id} />
                  <input type="date" name="invoiceDate" required className="field w-auto py-1 text-xs" />
                  <button className="btn btn-sm">Save</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {onlyNoAmount && canManage && shown.length > 0 && (
        <Card
          title="Type in the amount for these"
          className="mt-4"
          subtitle="The figure the invoice is billed at. One wholesaler prints subtotals by schedule and no single invoice total, so there is nothing on the page safe to read — adding the parts up would be the site inventing a number that later gets reconciled against a payment."
        >
          <ul className="rows">
            {shown.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                  {[i.supplier, i.invoiceNumber, i.invoiceDate ? fmt(i.invoiceDate) : null].filter(Boolean).join(" · ") || "Invoice"}
                </a>
                <form action={amount} className="flex items-center gap-1.5">
                  <input type="hidden" name="id" value={i.id} />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="dollars"
                    required
                    placeholder="0.00"
                    className="field w-32 py-1 text-right text-xs"
                  />
                  <button className="btn btn-sm">Save</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        What the pharmacist knows about his own suppliers, used the safe way round.

        He orders Schedule IIs from two of his three wholesalers and never from the third. That is
        real knowledge and worth having here — but never as a reason to file something as
        uncontrolled, because used that way it would suppress the one event most worth catching.
        Used this way it does the opposite: a controlled substance arriving from somewhere it
        never arrives from is either an ordering mistake or something worse, and nothing else
        would notice.
      */}
      {canManage && suppliers.length > 0 && (
        <Card
          title="What each supplier normally sends"
          subtitle="Nothing is filed differently because of this. It is how the site tells you when a supplier ships something they never ship — which is what an ordering mistake, or a diversion problem, looks like from here."
          className="mt-6"
        >
          <form action={saveExpected}>
            <label className="block text-xs font-medium text-ink-2">
              One per line, as <code>Supplier = none</code>, <code>= 3-5</code> or <code>= 2</code>
              <textarea
                name="expected"
                rows={Math.max(3, suppliers.length + 1)}
                defaultValue={s.supplier_expected_schedule ?? ""}
                placeholder={suppliers.map((x) => `${x} = none`).join("\n")}
                className="field mt-1 font-mono text-xs"
              />
            </label>
            <p className="mt-1 text-xs text-ink-3">
              Suppliers that have sent something so far: {suppliers.join(", ")}.
              {expectations.length > 0 && ` Currently set for ${expectations.length} of them.`}
            </p>
            <button className="btn mt-2">Save</button>
          </form>
        </Card>
      )}

      {canManage && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-accent">Add an invoice by hand</summary>
          <Card className="mt-2">
            <p className="card-sub">
              For one that arrived on paper and was scanned, or came to somebody else&rsquo;s inbox. It is read and
              filed by schedule the same way an emailed one is.
            </p>
            <form action={upload} className="mt-2 flex flex-wrap items-end gap-3" encType="multipart/form-data">
              <input type="file" name="file" accept="application/pdf,.pdf" className="field" />
              <button className="btn">Read it and file it</button>
            </form>
          </Card>
        </details>
      )}

      {/*
        The compliance posture, checked rather than claimed.

        The ask was to make sure invoice storage is compliant, and a paragraph asserting that it
        is would be worth nothing to the person it is written for. This is the list of what each
        rule requires, what this system does about it, and — for the two that depend on how the
        pharmacy has things set up rather than on the code — whether it is actually satisfied
        right now. An inspector can be shown this page; so can an auditor asking where the
        Schedule II records are kept.
      */}
      <Card
        id="compliance"
        title="How this meets the rules"
        subtitle="Each requirement, what it asks for, and what this system does about it. Two of these depend on how the pharmacy is set up rather than on the software, so they are checked rather than asserted."
        tone={unmet.length ? "warn" : undefined}
        count={unmet.length ? `${unmet.length} to settle` : "all met"}
        className="mt-6 scroll-mt-4"
      >
        <ul className="rows">
          {compliance.map((c) => (
            <li key={c.key} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className={`badge ${c.state === "ok" ? "badge-ok" : "badge-warn"}`}>
                    {c.state === "ok" ? "met" : "settle this"}
                  </span>
                  <span className="font-mono text-xs text-ink-3">{c.citation}</span>
                </span>
                {c.href && c.state !== "ok" && (
                  <Link href={c.href} className="btn btn-sm shrink-0">Fix it</Link>
                )}
              </div>
              <p className="mt-1 text-sm">{c.requires}</p>
              <p className="mt-1 text-xs text-ink-2">{c.how}</p>
              {c.fix && <p className="mt-1 text-xs text-warn">{c.fix}</p>}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-3">
          Kept for {RETENTION_YEARS} years, which is the Kansas retention period and longer than the two years
          21 CFR 1304.04(a) requires of these records.
        </p>
      </Card>

      {sent.length > 0 && (
        <Card title="Recently sent on" count={sent.length} className="mt-6" subtitle="What has left the building, and to whom.">
          <ul className="rows">
            {sent.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span>
                  {f.count} invoice{f.count === 1 ? "" : "s"} to <b>{f.toAddress}</b>
                  {f.includedScheduleTwo && <span className="badge badge-crit ml-2">included Schedule II</span>}
                  {f.error && <span className="badge badge-warn ml-2">failed</span>}
                </span>
                <span className="text-xs text-ink-3">{fmt(f.sentAt.slice(0, 10))} · {f.sentBy}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
