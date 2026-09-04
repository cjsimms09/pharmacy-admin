import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fmt, todayIso } from "@/lib/dates";
import { invoices, awaitingReview, invoiceCounts, setSchedule, filingFor } from "@/lib/invoices";
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
      "Kept separately from every other record the pharmacy holds, as 21 CFR 1304.04(h)(1) requires — a separate category, a separate folder on disk, and this list, which contains nothing else.",
  },
  {
    key: "schedule_3_5",
    label: "Schedule III-V",
    blurb:
      "21 CFR 1304.04(h)(2) allows these to be separate or merely readily retrievable. They are separate, which satisfies the stricter reading of the two.",
  },
  { key: "none", label: "No controlled substances", blurb: "Ordinary business records." },
  { key: "all", label: "Everything", blurb: "All supplier invoices, whatever they carry." },
];

/**
 * Every supplier invoice, filed by what it carries.
 *
 * The requirement people read as "keep paper" is really about separation. Schedule II records are
 * maintained separately from all other records of the registrant; Schedule III-V either
 * separately or readily retrievable from ordinary business records. Nothing in either says paper,
 * and an electronic system meets both — the test is whether somebody can produce every Schedule
 * II invoice for a period, on its own, without sorting through anything.
 *
 * That test is this page. Pick the schedule, pick the dates, and what comes back is that and only
 * that.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; from?: string; to?: string; ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { tab, from, to, ok, error } = await searchParams;
  const active = (TABS.find((t) => t.key === tab) ?? TABS[0]).key;
  const canManage = user.role !== "staff";

  const [rows, review, counts, s] = await Promise.all([
    invoices({ schedule: active === "all" ? undefined : active, from, to }),
    awaitingReview(),
    invoiceCounts(),
    getSettings(),
  ]);

  const rules = (s.mail_supplier_rules ?? "").trim();

  async function confirm(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const schedule = String(fd.get("schedule") ?? "") as InvoiceSchedule;
    if (!INVOICE_SCHEDULES.includes(schedule)) redirect("/inventory/invoices?error=" + encodeURIComponent("Pick a schedule."));
    try {
      await setSchedule(id, schedule, u);
      await audit({ action: "invoice.schedule", userId: u.id, userName: u.name, entity: "invoice", entityId: id, details: schedule });
      revalidatePath("/inventory/invoices");
      redirect(
        "/inventory/invoices?ok=" +
          encodeURIComponent(`Filed under ${filingFor(schedule).label}, and moved out of everything else.`),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/inventory/invoices?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not change that."));
    }
  }

  return (
    <>
      <PageHeader
        back={{ href: "/inventory", label: "Controlled substances" }}
        title="Supplier invoices"
        subtitle="Emailed in by the supplier, read, and filed by what each one carries. Schedule II invoices are kept apart from everything else, which is what the rule actually asks for."
        actions={<Link href="/settings/email" className="btn">Which senders are suppliers</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {!rules && (
        <Notice kind="warn">
          <b>No sender is named as a supplier yet, so nothing will be filed as an invoice.</b> Add a line under{" "}
          <Link href="/settings/email" className="underline">Settings → Email</Link> matching your wholesaler&rsquo;s
          address, then ask them to email invoices to this mailbox. From then on it happens with nobody doing
          anything.
        </Notice>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Figure value={counts.schedule_2} label="Schedule II" sub="Kept apart from everything" tone={counts.schedule_2 ? "ok" : "muted"} />
        <Figure value={counts.schedule_3_5} label="Schedule III-V" sub="Also kept apart" tone="muted" />
        <Figure value={counts.none} label="No controlled lines" sub="Ordinary business records" tone="muted" />
        <Figure
          value={counts.review}
          label="Waiting on you"
          sub={counts.review ? "Held with the C2s until confirmed" : "Nothing unread"}
          tone={counts.review ? "warn" : "ok"}
        />
      </div>

      {review.length > 0 && (
        <Card
          tone="warn"
          title="Read but not certain"
          count={review.length}
          subtitle="Each of these is held with the Schedule II records, because assuming the other way is the one mistake that breaks the rule. Say what it carries and it moves."
          className="mt-4 mb-6"
        >
          <ul className="rows">
            {review.map((i) => (
              <li key={i.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
                    {[i.supplier, i.invoiceNumber].filter(Boolean).join(" · ") || "Invoice"}
                  </a>
                  <span className="text-xs text-ink-3">{i.invoiceDate ? fmt(i.invoiceDate) : "no date read"}</span>
                </div>
                {i.basis && <p className="mt-1 text-xs text-ink-3">{i.basis}</p>}
                {i.controlledItems && (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-ink-2">{i.controlledItems}</p>
                )}
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
        </Card>
      )}

      <div className="mt-6 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/inventory/invoices?tab=${t.key}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`}
            className={`btn btn-sm ${active === t.key ? "btn-primary" : ""}`}
          >
            {t.label}
            {t.key !== "all" && <span className="ml-1.5 opacity-70">{counts[t.key as InvoiceSchedule]}</span>}
          </Link>
        ))}
      </div>

      <Card
        title={TABS.find((t) => t.key === active)!.label}
        count={rows.length}
        subtitle={TABS.find((t) => t.key === active)!.blurb}
        actions={
          /*
            The dates matter more here than anywhere else on the site.

            "Every Schedule II invoice from this date to that date" is the question an inspector
            asks, in those words. It should be two fields and a button, and the answer should
            contain nothing else — which is the whole of what separately maintained means in a
            system that is not made of paper.
          */
          <form className="flex flex-wrap items-center gap-1.5">
            <input type="hidden" name="tab" value={active} />
            <input type="date" name="from" defaultValue={from} className="field w-auto py-1 text-xs" aria-label="From" />
            <input type="date" name="to" defaultValue={to ?? todayIso()} className="field w-auto py-1 text-xs" aria-label="To" />
            <button className="btn btn-sm">Show these dates</button>
          </form>
        }
        className="mt-3"
      >
        {rows.length === 0 ? (
          <Empty>
            Nothing here yet. Ask the supplier to email invoices to the mailbox this site reads, and they file
            themselves.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Supplier</th><th>Invoice</th><th>Carries</th><th>Controlled lines</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="whitespace-nowrap text-xs">{i.invoiceDate ? fmt(i.invoiceDate) : "—"}</td>
                    <td className="text-sm">{i.supplier ?? "—"}</td>
                    <td className="font-mono text-xs">{i.invoiceNumber ?? "—"}</td>
                    <td>
                      <span className={`badge ${i.schedule === "schedule_2" ? "badge-crit" : i.schedule === "schedule_3_5" ? "badge-warn" : "badge-muted"}`}>
                        {filingFor(i.schedule).label}
                      </span>
                      {i.needsReview && !i.reviewedAt && <span className="badge badge-warn ml-1">unconfirmed</span>}
                    </td>
                    <td className="max-w-[22rem] whitespace-pre-wrap text-xs text-ink-2">{i.controlledItems || "—"}</td>
                    <td className="whitespace-nowrap">
                      <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="btn btn-sm">Open</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">
          Kept for five years, which is the Kansas retention period and longer than the two years 21 CFR 1304.04(a)
          requires. Every one of these is in the daily backup. Nothing here is deleted when a supplier account
          closes.
        </p>
      </Card>
    </>
  );
}
