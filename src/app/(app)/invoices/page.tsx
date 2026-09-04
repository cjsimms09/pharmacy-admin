import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { invoiceCounts, invoiceIssues } from "@/lib/invoices";
import { allInvoices, monthLabel, money } from "@/lib/deliveries";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Figure, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invoices" };

/**
 * Both kinds of invoice, from one place.
 *
 * They live where they belong — supplier invoices under controlled substances, because the whole
 * point of them is the Schedule II separation; the driver's under records, because it is a
 * payment the pharmacy raises. Both of those are the right home and neither is where somebody
 * looking for "invoices" goes first.
 *
 * The question was asked twice, which is the answer: a menu organised by what things *are* fails
 * the person who knows what they *want*. So the word has its own entry, and it leads to both.
 */
export default async function InvoicesHubPage() {
  await requireUser();
  const [counts, issues, driver] = await Promise.all([invoiceCounts(), invoiceIssues(), allInvoices()]);
  const recent = driver.slice(0, 5);
  const blocking = issues.filter((i) => i.severity === "blocking");

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="What the pharmacy is billed, and what the pharmacy bills. Two different things that both get called invoices."
      />

      {blocking.length > 0 && (
        <Notice kind="crit">
          <b>{blocking[0].title}</b> {blocking[0].detail}{" "}
          <Link href={blocking[0].href ?? "/inventory/invoices"} className="underline">
            {blocking[0].action ?? "Look at it"}
          </Link>
        </Notice>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Supplier invoices"
          subtitle="What the wholesalers send. Filed by schedule on arrival, with the Schedule IIs kept apart from every other record — which is what 21 CFR 1304.04(h)(1) actually asks for."
          actions={<Link href="/inventory/invoices" className="btn btn-primary">Open</Link>}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Figure value={counts.schedule_2} label="Schedule II" sub="Kept apart" href="/inventory/invoices?tab=schedule_2" tone={counts.schedule_2 ? "ok" : "muted"} />
            <Figure value={counts.schedule_3_5} label="Schedule III-V" sub="Also apart" href="/inventory/invoices?tab=schedule_3_5" tone="muted" />
            <Figure
              value={counts.review}
              label="Waiting on you"
              sub={counts.review ? "Held with the C2s" : "Nothing unread"}
              href="/inventory/invoices?unconfirmed=1"
              tone={counts.review ? "warn" : "ok"}
            />
          </div>
          <p className="mt-3 text-xs text-ink-3">
            Search them by invoice number, drug name, NDC, supplier or month — and select any of them to email on.
          </p>
        </Card>

        <Card
          title="Driver invoices"
          subtitle="What the pharmacy raises on the delivery driver's behalf, one a month. Enter the day's count and the invoice sends itself when the month is finished."
          actions={<Link href="/deliveries" className="btn btn-primary">Open</Link>}
        >
          {recent.length === 0 ? (
            <p className="card-sub">Nothing invoiced yet. Finish a month and the first one raises itself.</p>
          ) : (
            <ul className="rows">
              {recent.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <Link href={`/deliveries?month=${i.month}`} className="text-sm font-medium text-accent hover:underline">
                      {monthLabel(i.month)}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-ink-3">{i.invoiceNumber}</span>
                    <span className="mt-0.5 block text-xs text-ink-3">
                      {money(i.totalCents)} · {i.sentAt ? `sent ${fmt(i.sentAt.slice(0, 10))}` : "not sent"}
                    </span>
                  </span>
                  <a
                    href={i.documentId ? `/files/${i.documentId}` : `/deliveries/${i.month}/preview`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm shrink-0"
                  >
                    View
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
