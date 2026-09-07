import { familyTabs } from "@/lib/families";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { planRegister, registerProgress, syncPlanGroups, classifyPlan, CLASS_INFO } from "@/lib/plans";
import { PLAN_CLASSES, type PlanClass } from "@/db/schema";
import { formatCents } from "@/lib/money";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty, Card, Figure, Field } from "@/components/ui";

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
        tabs={familyTabs("floor", "/plans")}
        title="Plans"
        subtitle="Which benefit plans the Kansas floor can reach. This one determination decides what is filable — the contract, the rate schedule and the MAC list are not needed for it."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {rows.length === 0 ? (
        <>
          <Empty>No plans in the register yet.</Empty>
          <form action={sync} className="mt-3">
            <button className="btn btn-primary">Build it from the claims</button>
          </form>
        </>
      ) : (
        <>
          <div className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure value={progress.plans} label="Plans" sub="Seen on the claims held" tone="muted" />
            <Figure
              value={`${progress.decided} of ${progress.plans}`}
              label="Determined"
              sub={progress.unknown ? `${progress.unknown} still to establish` : "Every one settled"}
              tone={progress.unknown ? "warn" : "ok"}
            />
            <Figure
              value={progress.inScopePlans}
              label="In scope for the floor"
              sub={`${progress.inScopeClaims} claims on them`}
              tone="ok"
            />
            <Figure
              value={progress.claimsUnknown}
              label="Claims still unclassified"
              sub={progress.claimsUnknown ? "Neither owed nor dismissed until the plan is known" : "Nothing left waiting"}
              tone={progress.claimsUnknown ? "warn" : "ok"}
            />
          </div>

          {progress.inScopeUnderFee > 0 && (
            <Notice kind="ok">
              {progress.inScopeUnderFee} claim{progress.inScopeUnderFee === 1 ? "" : "s"} on plans established as in
              scope received less than the $10.50 dispensing fee alone. Those are the ones a filing is built from.
            </Notice>
          )}

          <Card
            className="mt-4"
            title="How to establish one"
            subtitle="Four rules settle almost every plan. The first one settles most of them."
          >
            <ul className="list-disc space-y-2 pl-5 text-sm text-ink-2">
              <li>
                <b className="text-ink">Self-funded or fully insured</b> is answered by the sponsor&rsquo;s{" "}
                <b className="text-ink">Form 5500</b>, filed annually with the Department of Labor and public at{" "}
                <code>efast.dol.gov</code>. Search the employer name. A Schedule A means an insurance contract — fully
                insured, and in scope. No Schedule A on a health benefit means self-funded, and out.
              </li>
              <li>
                <b className="text-ink">City, county, school district and state plans are not ERISA plans at all</b>, so
                they stay in scope even when self-funded. The sponsor name usually gives this away.
              </li>
              <li>
                <b className="text-ink">Plans with fewer than 100 participants</b> may not file a full 5500. Ask the
                plan, or read the summary plan description.
              </li>
              <li>
                <b className="text-ink">A discount card is not insurance.</b> There is no plan to regulate and no payer
                to owe a floor.
              </li>
            </ul>
          </Card>

          <Card
            className="mt-4"
            title={show === "all" ? "Every plan" : "Not yet determined"}
            count={shown.length}
            subtitle="Each is one form. Record what established it as well as what it is — a classification nobody can check is one nobody can file on."
            actions={
              <a href={show === "all" ? "/plans" : "/plans?show=all"} className="btn btn-sm">
                {show === "all" ? "Show only undetermined" : "Show all"}
              </a>
            }
          >
            {shown.length === 0 ? (
              <Empty>Every plan has been determined.</Empty>
            ) : (
              <div className="space-y-3">
                {shown.map((r) => (
                  <form key={r.id} action={classify} className="rounded-lg border border-line p-4">
                    <input type="hidden" name="id" value={r.id} />
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <span className="font-mono text-sm font-semibold">{r.groupNumber || "(no group number)"}</span>
                        <span className="ml-2 text-sm text-ink-2">{r.payerLabel ?? r.pbmName ?? "—"}</span>
                        <div className="mt-0.5 text-xs text-ink-3">
                          BIN {r.bin ?? "—"}{r.pcn ? ` · PCN ${r.pcn}` : " · any PCN"}
                          {r.planTypes.length > 0 && ` · PioneerRx calls it ${r.planTypes.join(", ")}`}
                          {r.decidedOn && ` · determined ${r.decidedOn}`}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold tabular-nums">{r.claims}</div>
                        <div className="text-xs text-ink-3">claims · {formatCents(r.receivedCents)}</div>
                        {r.underFeeClaims > 0 && (
                          <div className="mt-1"><span className="badge badge-warn">{r.underFeeClaims} under $10.50</span></div>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <Field label="Classification">
                        <select name="classification" defaultValue={r.classification} className="w-full">
                          {PLAN_CLASSES.map((c) => (
                            <option key={c} value={c}>
                              {CLASS_INFO[c].label}{CLASS_INFO[c].inScope ? " — floor applies" : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Plan sponsor / employer">
                        <input name="sponsorName" defaultValue={r.sponsorName ?? ""} placeholder="What you would search on efast.dol.gov" className="w-full" />
                      </Field>
                      <Field label="How this was established" className="sm:col-span-2">
                        <input name="basis" defaultValue={r.basis ?? ""} placeholder="Form 5500 for plan year 2025 shows a Schedule A for the health benefit — fully insured" className="w-full" />
                      </Field>
                      <Field label="Source link" className="sm:col-span-2">
                        <input name="sourceUrl" defaultValue={r.sourceUrl ?? ""} placeholder="Link to the filing or document" className="w-full" />
                      </Field>
                    </div>

                    <button className="btn btn-sm mt-3">Record</button>
                  </form>
                ))}
              </div>
            )}
          </Card>

          <form action={sync} className="mt-4">
            <button className="btn">Pick up plans from newly loaded claims</button>
          </form>
        </>
      )}
    </>
  );
}
