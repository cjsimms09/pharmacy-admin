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
  filingFor,
} from "@/lib/invoices";
import { setSetting } from "@/lib/settings";
import { getSettings } from "@/lib/settings";
import { PageHeader, Card, Figure, Notice, Empty } from "@/components/ui";
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

  const [rows, review, counts, issues, suppliers, months, sent, s] = await Promise.all([
    invoices({
      schedule: active === "all" ? undefined : active,
      text: sp.q,
      month: sp.month,
      supplier: sp.supplier,
      from: sp.from,
      to: sp.to,
      unconfirmed: onlyUnconfirmed || undefined,
    }),
    awaitingReview(),
    invoiceCounts(),
    invoiceIssues(),
    invoiceSuppliers(),
    invoiceMonths(),
    recentForwards(5),
    getSettings(),
  ]);

  const shown = onlyUndated ? rows.filter((r) => !r.invoiceDate) : rows;
  const rules = (s.mail_supplier_rules ?? "").trim();
  const filtered = Boolean(sp.q || sp.month || sp.supplier || sp.from || sp.to || onlyUnconfirmed || onlyUndated);
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

  const here = `/inventory/invoices?${new URLSearchParams(
    Object.entries(sp).filter(([k, v]) => v && k !== "ok" && k !== "error") as [string, string][],
  ).toString()}`;

  return (
    <>
      <PageHeader
        back={{ href: "/inventory", label: "Controlled substances" }}
        title="Supplier invoices"
        subtitle="Emailed in by the supplier, read on arrival, and filed by what each one carries. Schedule II invoices are kept apart from everything else, which is what the rule actually asks for."
        actions={<Link href="/settings/email" className="btn">Which senders are suppliers</Link>}
      />

      {sp.ok && <Notice kind="ok">{sp.ok}</Notice>}
      {sp.error && <Notice kind="crit">{sp.error}</Notice>}

      {!rules && (
        <Notice kind="warn">
          <b>No sender is named as a supplier yet, so nothing will be filed as an invoice.</b> Add a line under{" "}
          <Link href="/settings/email" className="underline">Settings → Email</Link> matching your wholesaler&rsquo;s
          address, then ask them to email invoices to this mailbox. From then on it happens with nobody doing
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
            From
            <input type="date" name="from" defaultValue={sp.from} className="field mt-1" />
          </label>
          <label className="text-xs font-medium text-ink-2">
            To
            <input type="date" name="to" defaultValue={sp.to} className="field mt-1" />
          </label>
          <div className="flex items-end gap-1.5 lg:col-span-2">
            <button className="btn btn-primary">Search</button>
            {filtered && <Link href={`/inventory/invoices?tab=${active}`} className="btn">Clear</Link>}
          </div>
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
                      <th>Date</th><th>Supplier</th><th>Invoice</th><th>Carries</th><th>Lines</th><th></th>
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
