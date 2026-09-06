import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings, setSetting } from "@/lib/settings";
import { PageHeader, Notice, BackLink, Card } from "@/components/ui";

export const metadata = { title: "Extra sections" };
export const dynamic = "force-dynamic";

export default async function FeaturesPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  await requireManager();
  const { ok } = await searchParams;
  const s = await getSettings();
  const on = s.feature_reimbursement === "yes";

  async function toggle() {
    "use server";
    const u = await requireManager();
    const s = await getSettings();
    const next = s.feature_reimbursement === "yes" ? "no" : "yes";
    await setSetting("feature_reimbursement", next);
    await audit({ action: "features.toggle", userId: u.id, userName: u.name, details: `reimbursement=${next}` });
    revalidatePath("/", "layout");
    redirect("/settings/features?ok=" + encodeURIComponent(next === "yes" ? "Switched on." : "Switched off."));
  }

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader title="Extra sections" subtitle="Parts of the site that are built but not in daily use yet." />
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Card className="mt-4 max-w-2xl">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Reimbursement and purchasing</h2>
          <span className={`rounded px-2 py-0.5 text-xs ${on ? "bg-emerald-100 text-emerald-800" : "bg-ground text-ink-3"}`}>
            {on ? "on" : "off"}
          </span>
        </div>
        <p className="mt-2 text-sm text-ink-2">
          Payers, claims, plan classification, NADAC, purchasing, report checking and Medicare MFP refunds. All built
          and tested, and all waiting on something from outside — a PioneerRx column that currently comes through
          blank, the NADAC weekly files, the Express Scripts contract.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          Switched off they are simply not there: no menu, no pages, no MTF key on the connections screen. Nothing is
          deleted and nothing is lost — switch it back on the day the data lands and it picks up where it was.
        </p>
        <form action={toggle} className="mt-3">
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">
            {on ? "Switch it off" : "Switch it on"}
          </button>
        </form>
      </Card>
    </>
  );
}
