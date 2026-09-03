import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Tools" };

/**
 * The half-built half of the site, kept out of the daily path on purpose.
 *
 * Each of these works, and none of them is finished, because each is waiting on data that has to
 * come from outside — a PioneerRx column, a NADAC download, a contract. Saying which is more
 * useful than a menu item that opens an empty page.
 */
const TOOLS = [
  { href: "/payers", title: "Payers", state: "ready", what: "Every BIN we bill, its contracted rates, MAC appeal route and payment routing. Look up a BIN from a claim." },
  { href: "/claims", title: "Claims", state: "waiting", what: "Loads a PioneerRx export and matches each claim to its payer. Waiting on dispensed quantity, which comes through blank." },
  { href: "/plans", title: "Plans", state: "needs work", what: "Which plans the Kansas floor can reach. 64 groups still to be determined from Form 5500 filings." },
  { href: "/nadac", title: "NADAC", state: "waiting", what: "The federal benchmark price. Nothing loaded yet — the weekly files have to be downloaded from data.medicaid.gov." },
  { href: "/purchasing", title: "Purchasing", state: "waiting", what: "Compares what we paid against the same product elsewhere. Waiting on acquisition cost and a supplier price file." },
  { href: "/reports", title: "Report check", state: "ready", what: "Drop a candidate report in and see exactly what it can and cannot support." },
  { href: "/remits/mtf", title: "Medicare MFP refunds", state: "waiting", what: "Pulls 835 files from the Medicare Transaction Facilitator. Waiting on the portal setting that gates the CLI." },
];

export default async function ToolsPage() {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Tools"
        subtitle="The reimbursement side. Real, and not finished — each one says what it is waiting for rather than opening an empty page."
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {TOOLS.map((t) => (
          <Link key={t.href} href={t.href} className="rounded-lg border border-line bg-surface p-4 hover:border-ink-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-semibold">{t.title}</h2>
              <span className={`rounded px-1.5 py-0.5 text-xs ${
                t.state === "ready" ? "bg-emerald-100 text-emerald-800" : t.state === "needs work" ? "bg-amber-100 text-amber-900" : "bg-ground text-ink-3"
              }`}>{t.state}</span>
            </div>
            <p className="mt-1 text-sm text-ink-2">{t.what}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
