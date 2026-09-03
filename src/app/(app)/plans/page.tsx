import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { planRegister, registerProgress, syncPlanGroups, classifyPlan, CLASS_INFO } from "@/lib/plans";
import { PLAN_CLASSES, type PlanClass } from "@/db/schema";
import { formatCents } from "@/lib/money";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty } from "@/components/ui";

export const metadata = { title: "Plans" };
export const dynamic = "force-dynamic";

export default async function PlansPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; show?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error, show } = await searchParams;
  const [rows, progress] = await Promise.all([planRegister(), registerProgress()]);
  const shown = show === "all" ? rows : rows.filter((r) => r.classification === "unknown");

  async function sync() {
    "use server";
    const u = await requireManager();
    const r = await syncPlanGroups();
    await audit({ action: "plans.sync", userId: u.id, userName: u.name, details: `${r.added} new of ${r.total}` });
    revalidatePath("/plans");
    redirect("/plans?ok=" + encodeURIComponent(`${r.added} new plan${r.added === 1 ? "" : "s"} added. ${r.total} in the register.`));
  }

  async function classify(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await classifyPlan(
        id,
        {
          classification: String(fd.get("classification") ?? "unknown") as PlanClass,
          sponsorName: String(fd.get("sponsorName") ?? ""),
          basis: String(fd.get("basis") ?? ""),
          sourceUrl: String(fd.get("sourceUrl") ?? ""),
        },
        u,
      );
      await audit({ action: "plans.classify", userId: u.id, userName: u.name, details: `${id} → ${fd.get("classification")}` });
      revalidatePath("/plans");
      redirect("/plans?ok=" + encodeURIComponent("Recorded."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/plans?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
    }
  }

  return (
    <>
      <PageHeader
        title="Plans"
        subtitle="Which benefit plans the Kansas floor can reach. This one determination decides what is filable — the contract, the rate schedule and the MAC list are not needed for it."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {rows.length === 0 ? (
        <>
          <Empty>No plans in the register yet.</Empty>
          <form action={sync} className="mt-3">
            <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Build it from the claims</button>
          </form>
        </>
      ) : (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Plans" value={String(progress.plans)} />
            <Stat label="Determined" value={`${progress.decided} of ${progress.plans}`} tone={progress.unknown ? "warn" : "ok"} />
            <Stat label="In scope for the floor" value={String(progress.inScopePlans)} sub={`${progress.inScopeClaims} claims`} tone="ok" />
            <Stat label="Claims still unclassified" value={String(progress.claimsUnknown)} tone={progress.claimsUnknown ? "warn" : undefined} />
          </div>

          {progress.inScopeUnderFee > 0 && (
            <Notice kind="ok">
              {progress.inScopeUnderFee} claim{progress.inScopeUnderFee === 1 ? "" : "s"} on plans established as in
              scope received less than the $10.50 dispensing fee alone. Those are the ones a filing is built from.
            </Notice>
          )}

          <section className="my-4 rounded-lg border border-line bg-surface p-4 text-sm">
            <h2 className="text-sm font-semibold">How to establish one</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
              <li>
                <b>Self-funded or fully insured</b> is answered by the sponsor&rsquo;s <b>Form 5500</b>, filed annually
                with the Department of Labor and public at <code>efast.dol.gov</code>. Search the employer name. A
                Schedule A means an insurance contract — fully insured, and in scope. No Schedule A on a health benefit
                means self-funded, and out.
              </li>
              <li>
                <b>City, county, school district and state plans are not ERISA plans at all</b>, so they stay in scope
                even when self-funded. The sponsor name usually gives this away.
              </li>
              <li>
                <b>Plans with fewer than 100 participants</b> may not file a full 5500. Ask the plan, or read the
                summary plan description.
              </li>
              <li>
                <b>A discount card is not insurance.</b> There is no plan to regulate and no payer to owe a floor.
              </li>
            </ul>
          </section>

          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{show === "all" ? "Every plan" : "Not yet determined"}</h2>
            <a href={show === "all" ? "/plans" : "/plans?show=all"} className="text-xs underline">
              {show === "all" ? "Show only undetermined" : "Show all"}
            </a>
          </div>

          {shown.length === 0 ? (
            <Empty>Every plan has been determined.</Empty>
          ) : (
            <div className="space-y-3">
              {shown.map((r) => (
                <form key={r.id} action={classify} className="rounded-lg border border-line bg-surface p-4">
                  <input type="hidden" name="id" value={r.id} />
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-mono text-sm font-semibold">{r.groupNumber || "(no group number)"}</span>
                      <span className="ml-2 text-sm text-ink-2">{r.payerLabel ?? r.pbmName ?? "—"}</span>
                      <div className="mt-0.5 text-xs text-ink-3">
                        BIN {r.bin ?? "—"}
                        {r.planTypes.length > 0 && ` · PioneerRx calls it ${r.planTypes.join(", ")}`}
                        {r.decidedOn && ` · determined ${r.decidedOn}`}
                      </div>
                    </div>
                    <div className="text-right text-xs">
                      <div className="text-base font-semibold tabular-nums">{r.claims}</div>
                      <div className="text-ink-3">claims · {formatCents(r.receivedCents)}</div>
                      {r.underFeeClaims > 0 && <div className="text-amber-800">{r.underFeeClaims} under $10.50</div>}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-xs text-ink-3">
                      Classification
                      <select name="classification" defaultValue={r.classification} className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink">
                        {PLAN_CLASSES.map((c) => (
                          <option key={c} value={c}>
                            {CLASS_INFO[c].label}{CLASS_INFO[c].inScope ? " — floor applies" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-ink-3">
                      Plan sponsor / employer
                      <input name="sponsorName" defaultValue={r.sponsorName ?? ""} placeholder="What you would search on efast.dol.gov" className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" />
                    </label>
                    <label className="text-xs text-ink-3 sm:col-span-2">
                      How this was established
                      <input name="basis" defaultValue={r.basis ?? ""} placeholder="e.g. Form 5500 for plan year 2025 shows a Schedule A for the health benefit — fully insured" className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" />
                    </label>
                    <label className="text-xs text-ink-3 sm:col-span-2">
                      Source link
                      <input name="sourceUrl" defaultValue={r.sourceUrl ?? ""} placeholder="Link to the filing or document" className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-sm text-ink" />
                    </label>
                  </div>

                  <button className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-ground">Record</button>
                </form>
              ))}
            </div>
          )}

          <form action={sync} className="mt-6">
            <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">
              Pick up plans from newly loaded claims
            </button>
          </form>
        </>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "ok" }) {
  const border = tone === "warn" ? "border-amber-300 bg-amber-50" : tone === "ok" ? "border-emerald-300 bg-emerald-50" : "border-line bg-surface";
  return (
    <div className={`rounded-lg border p-3 ${border}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}
