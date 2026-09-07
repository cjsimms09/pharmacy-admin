import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { searchDrugs, drugFileHealth, settlePackSize, clearPackSize, marginOf } from "@/lib/drug-catalog";
import { correctItem } from "@/lib/catalogue";
import { formatCents } from "@/lib/money";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Notice, Empty, Figure, Field } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "The drug file" };

/**
 * Every drug the site holds anything about, under its NDC.
 *
 * Each file used to be readable only through the screen built for it — the wholesalers' catalogues
 * on the purchasing page, the count on the shelf page, the claims on the claims page, NADAC nowhere
 * at all. The questions that only make sense across files could not be asked: what does this
 * actually reimburse, do two wholesalers agree about what a package holds, is a cheaper source
 * carrying the same bottle.
 *
 * Three things this page is for.
 *
 * Looking a drug up — by name or by NDC, filtered to one wholesaler where that is the question.
 *
 * What it reimburses. Averaged from the fills rather than the claims, because a fill billed to a
 * primary plan and then a secondary is two rows for one bottle; counted as claims the quantity
 * doubles and the rate halves. It is the only figure here nobody can look up anywhere else, and
 * beside the cheapest cost it says whether a drug earns its shelf space at all.
 *
 * And settling what a package holds. An NDC names one package, so two wholesalers describing it
 * differently is one error rather than two products — and the pharmacy is the only party that can
 * settle it, because the pharmacy has the bottle. The answer is kept against the NDC, so it applies
 * to every supplier including ones the pharmacy has never bought from, and next week's files do not
 * undo it.
 */
export default async function DrugFilePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string; supplier?: string; mismatch?: string; problems?: string; dispensed?: string; fixed?: string; ok?: string; error?: string;
  }>;
}) {
  const user = await requireUser();
  const canManage = user.role !== "staff";
  const sp = await searchParams;
  const flags = {
    mismatchOnly: sp.mismatch === "1",
    problemsOnly: sp.problems === "1",
    dispensedOnly: sp.dispensed === "1",
    fixedOnly: sp.fixed === "1",
  };

  const [health, found] = await Promise.all([
    drugFileHealth(),
    searchDrugs({ text: sp.q, supplier: sp.supplier, ...flags, limit: 150 }),
  ]);

  const search = new URLSearchParams({
    ...(sp.q ? { q: sp.q } : {}),
    ...(sp.supplier ? { supplier: sp.supplier } : {}),
    ...(flags.mismatchOnly ? { mismatch: "1" } : {}),
    ...(flags.problemsOnly ? { problems: "1" } : {}),
    ...(flags.dispensedOnly ? { dispensed: "1" } : {}),
    ...(flags.fixedOnly ? { fixed: "1" } : {}),
  }).toString();
  const keep = (extra: Record<string, string>) =>
    `/purchasing/catalog?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(search)), ...extra }).toString()}`;

  async function settle(fd: FormData) {
    "use server";
    const u = await requireManager();
    /*
     * Back to the search this came from.
     *
     * Built inside the action rather than by a shared helper: an action may close over values but
     * never over a function, and a helper defined in the component compiles to one being handed
     * across the boundary — which renders as a server error after the change has already been saved.
     */
    const back = (extra: Record<string, string>) =>
      `/purchasing/catalog?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(String(fd.get("back") ?? ""))), ...extra }).toString()}`;

    const message = await settlePackSize(
      { ndc11: String(fd.get("ndc11") ?? ""), packSize: String(fd.get("packSize") ?? ""), note: String(fd.get("note") ?? "") },
      u,
    );
    revalidatePath("/purchasing/catalog");
    revalidatePath("/purchasing");
    redirect(back({ ok: message }));
  }

  async function unsettle(fd: FormData) {
    "use server";
    const u = await requireManager();
    /*
     * Back to the search this came from.
     *
     * Built inside the action rather than by a shared helper: an action may close over values but
     * never over a function, and a helper defined in the component compiles to one being handed
     * across the boundary — which renders as a server error after the change has already been saved.
     */
    const back = (extra: Record<string, string>) =>
      `/purchasing/catalog?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(String(fd.get("back") ?? ""))), ...extra }).toString()}`;

    const message = await clearPackSize(String(fd.get("ndc11") ?? ""), u);
    revalidatePath("/purchasing/catalog");
    revalidatePath("/purchasing");
    redirect(back({ ok: message }));
  }

  async function correctPrice(fd: FormData) {
    "use server";
    const u = await requireManager();
    /*
     * Back to the search this came from.
     *
     * Built inside the action rather than by a shared helper: an action may close over values but
     * never over a function, and a helper defined in the component compiles to one being handed
     * across the boundary — which renders as a server error after the change has already been saved.
     */
    const back = (extra: Record<string, string>) =>
      `/purchasing/catalog?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(String(fd.get("back") ?? ""))), ...extra }).toString()}`;

    const dollars = String(fd.get("unitCost") ?? "").trim();
    const n = dollars ? Number(dollars) : NaN;
    if (dollars && (!Number.isFinite(n) || n <= 0)) {
      redirect(back({ error: "The unit cost has to be an amount in dollars, per dispensing unit." }));
    }
    const message = await correctItem(
      {
        supplier: String(fd.get("supplier") ?? ""),
        ndc11: String(fd.get("ndc11") ?? ""),
        unitCostMicros: dollars ? Math.round(n * 1_000_000) : null,
        note: String(fd.get("note") ?? ""),
      },
      u,
    );
    const { forgetDrugFile } = await import("@/lib/drug-catalog");
    forgetDrugFile();
    revalidatePath("/purchasing/catalog");
    revalidatePath("/purchasing");
    redirect(back({ ok: message }));
  }

  const perUnit = (micros: number | null) => (micros === null ? "—" : `$${(micros / 1_000_000).toFixed(4)}`);
  const centsPerUnit = (cents: number | null) => (cents === null ? "—" : `$${(cents / 100).toFixed(4)}`);

  return (
    <>
      <PageHeader
        title="The drug file"
        subtitle="Every drug any file mentions, under its NDC: who sells it and at what package, what the shelf holds, what it reimburses, and where two sources disagree about the bottle."
        actions={<Link href="/purchasing" className="btn btn-sm">Buying</Link>}
      />
      {sp.ok && <Notice kind="ok">{sp.ok}</Notice>}
      {sp.error && <Notice kind="crit">{sp.error}</Notice>}

      {health.total === 0 ? (
        <Empty>
          Nothing has been imported yet. Supplier catalogues arrive by email from PioneerRx, or can be uploaded on the{" "}
          <Link href="/purchasing" className="text-accent underline">purchasing page</Link>.
        </Empty>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Figure
              value={health.total.toLocaleString()}
              label="drugs on file"
              sub={`from ${health.suppliers.length} supplier${health.suppliers.length === 1 ? "" : "s"}`}
              tone="muted"
            />
            <Figure
              value={health.mismatches.toLocaleString()}
              label="packages in dispute"
              sub="Two sources disagree about what the bottle holds"
              href={keep({ mismatch: "1" })}
              tone={health.mismatches > 0 ? "crit" : "ok"}
            />
            <Figure
              value={health.dispensed.toLocaleString()}
              label="we actually dispense"
              sub={`${formatCents(health.reimbursedCents)} reimbursed on them`}
              href={keep({ dispensed: "1" })}
              tone="muted"
            />
            <Figure
              value={health.settled.toLocaleString()}
              label="packages you have settled"
              sub="Applied to every supplier, and to every file from now on"
              href={keep({ fixed: "1" })}
              tone="muted"
            />
          </div>

          <Card className="mb-4" title="Find a drug" subtitle="By NDC, or by any part of the name.">
            <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <Field label="NDC or name">
                <input name="q" defaultValue={sp.q ?? ""} className="field" placeholder="albuterol, or 68180" />
              </Field>
              <Field label="Supplier">
                <select name="supplier" defaultValue={sp.supplier ?? ""} className="field">
                  <option value="">Any supplier</option>
                  {health.suppliers.map((s) => (
                    <option key={s.supplier} value={s.supplier}>{s.supplier} ({s.items.toLocaleString()})</option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end">
                <button className="btn btn-primary">Search</button>
              </div>
            </form>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {[
                { on: flags.mismatchOnly, to: keep({ mismatch: flags.mismatchOnly ? "" : "1" }), label: "Packages in dispute" },
                { on: flags.dispensedOnly, to: keep({ dispensed: flags.dispensedOnly ? "" : "1" }), label: "Only what we dispense" },
                { on: flags.problemsOnly, to: keep({ problems: flags.problemsOnly ? "" : "1" }), label: "Anything wrong" },
                { on: flags.fixedOnly, to: keep({ fixed: flags.fixedOnly ? "" : "1" }), label: "Settled by you" },
              ].map((f) => (
                <Link key={f.label} href={f.to} className={`badge ${f.on ? "badge-ok" : "badge-muted"}`}>{f.label}</Link>
              ))}
            </div>
          </Card>

          <Card
            title={flags.mismatchOnly ? "Packages two sources disagree about" : "Drugs"}
            count={found.matched}
            subtitle={
              found.matched > found.rows.length
                ? `Showing the first ${found.rows.length}. Narrow the search to see the rest.`
                : "Worst first, then by what being wrong costs, then by what the drug earns."
            }
          >
            {found.rows.length === 0 ? (
              <Empty>Nothing matches. {flags.mismatchOnly ? "Which, on this filter, is the answer you want." : ""}</Empty>
            ) : (
              <ul className="rows">
                {found.rows.map((r) => {
                  const m = marginOf(r);
                  return (
                    <li key={r.ndc11} className="py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="min-w-0">
                          <b className="text-sm">{r.name ?? "(no name)"}</b>
                          <span className="ml-2 font-mono text-xs text-ink-3">{r.ndc11}</span>
                          {r.packFix && <span className="badge badge-ok ml-2">package settled</span>}
                          {r.shelf && <span className="badge badge-muted ml-2">on the shelf</span>}
                        </span>
                        <span className="shrink-0 text-xs text-ink-3">
                          {r.offers.length} supplier{r.offers.length === 1 ? "" : "s"}
                          {r.reimbursement ? ` · ${r.reimbursement.fills} fill${r.reimbursement.fills === 1 ? "" : "s"}` : ""}
                        </span>
                      </div>

                      <div className="mt-1 grid gap-2 text-xs text-ink-2 sm:grid-cols-4">
                        <span>
                          Package <b>{r.packFix?.packSize ?? r.offers[0]?.packSize ?? "—"}</b>
                        </span>
                        <span>Cheapest pack <b>{r.bestPackCostCents === null ? "—" : formatCents(r.bestPackCostCents)}</b></span>
                        <span>
                          Reimburses{" "}
                          <b>{r.reimbursement?.perUnitCents ? centsPerUnit(r.reimbursement.perUnitCents) : "—"}</b>
                          {r.reimbursement?.perUnitCents ? <span className="text-ink-3"> a unit</span> : null}
                        </span>
                        <span>
                          Margin{" "}
                          <b className={m ? (m.perUnitCents < 0 ? "text-crit" : "text-ok") : ""}>
                            {m ? centsPerUnit(m.perUnitCents) : "—"}
                          </b>
                          {m?.percent !== null && m !== null ? <span className="text-ink-3"> ({Math.round(m.percent * 100)}%)</span> : null}
                        </span>
                      </div>

                      {r.packDisagreement && (
                        <p className={`mt-1 text-xs ${r.packFix ? "text-ink-3" : "text-crit"}`}>
                          <b>{r.packDisagreement.text}.</b>{" "}
                          {r.packFix ? (
                            <span className="text-ink-3">
                              Settled at {r.packFix.packSize}{r.packFix.note ? ` — ${r.packFix.note}` : ""} by {r.packFix.correctedBy}.
                            </span>
                          ) : (
                            <span className="text-ink-2">An NDC names one package, so one of these is wrong.</span>
                          )}
                        </p>
                      )}

                      {r.problems
                        .filter((p) => p.kind !== "pack_size_unreadable" || !r.packDisagreement)
                        .slice(0, 3)
                        .map((p, i) => (
                          <p key={`${p.kind}-${i}`} className={`mt-1 text-xs ${p.level === "wrong" ? "text-crit" : "text-warn"}`}>
                            <b>{p.says}</b> <span className="text-ink-2">{p.todo}</span>
                          </p>
                        ))}

                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-accent">
                          Who sells it, what the shelf says, and how to fix it
                        </summary>

                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="text-ink-3">
                              <tr>
                                <th className="pb-1 text-left font-medium">Supplier</th>
                                <th className="pb-1 text-left font-medium">Package</th>
                                <th className="pb-1 text-right font-medium">A unit</th>
                                <th className="pb-1 text-right font-medium">A pack</th>
                                <th className="pb-1 text-right font-medium">AWP</th>
                                <th className="pb-1 text-left font-medium">Priced</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.offers.map((o) => (
                                <tr key={o.supplier} className="border-t border-line">
                                  <td className="py-1">
                                    {o.supplier}
                                    {o.contractFlag === "rebated" && <span className="badge badge-ok ml-1">rebated</span>}
                                    {o.corrected && <span className="badge badge-muted ml-1">corrected</span>}
                                  </td>
                                  <td className="py-1">{o.packSize ?? "—"}</td>
                                  <td className="py-1 text-right tabular-nums">{perUnit(o.unitCostMicros)}</td>
                                  <td className="py-1 text-right tabular-nums">{o.packCostCents === null ? "—" : formatCents(o.packCostCents)}</td>
                                  <td className="py-1 text-right tabular-nums">{o.awpCents === null ? "—" : formatCents(o.awpCents)}</td>
                                  <td className="py-1">{o.pricedOn ? fmt(o.pricedOn) : "—"}</td>
                                </tr>
                              ))}
                              {r.shelf && (
                                <tr className="border-t border-line text-ink-2">
                                  <td className="py-1">The shelf count</td>
                                  <td className="py-1">{r.shelf.packQty ?? "—"}</td>
                                  <td className="py-1 text-right" colSpan={3}>
                                    {(r.shelf.onHandThousandths / 1000).toLocaleString()} on hand
                                    {r.shelf.valueCents !== null ? `, worth ${formatCents(r.shelf.valueCents)}` : ""}
                                  </td>
                                  <td />
                                </tr>
                              )}
                              {r.nadacUnitMicros !== null && (
                                <tr className="border-t border-line text-ink-2">
                                  <td className="py-1">NADAC</td>
                                  <td className="py-1">{r.nadacPricingUnit ? `per ${r.nadacPricingUnit}` : "—"}</td>
                                  <td className="py-1 text-right tabular-nums">{perUnit(r.nadacUnitMicros)}</td>
                                  <td className="py-1 text-right" colSpan={3}>the federal average</td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>

                        {r.reimbursement && (
                          <p className="mt-2 text-[11px] text-ink-3">
                            {r.reimbursement.fills} fill{r.reimbursement.fills === 1 ? "" : "s"} reimbursed{" "}
                            {formatCents(r.reimbursement.remitCents)} on {(r.reimbursement.unitsThousandths / 1000).toLocaleString()} units
                            {r.reimbursement.lastFilledOn ? `, last on ${fmt(r.reimbursement.lastFilledOn)}` : ""}.
                            {r.reimbursement.cashFills > 0
                              ? ` A further ${r.reimbursement.cashFills} cash fill${r.reimbursement.cashFills === 1 ? "" : "s"} took ${formatCents(r.reimbursement.cashRevenueCents)}, which is a price we set rather than a rate paid, so it is left out of the average.`
                              : ""}
                          </p>
                        )}

                        {canManage && (
                          <>
                            <form action={settle} className="mt-3 flex flex-wrap items-end gap-2">
                              <input type="hidden" name="back" value={search} />
                              <input type="hidden" name="ndc11" value={r.ndc11} />
                              <label className="text-[11px] text-ink-2">
                                What a package actually holds
                                <input
                                  name="packSize"
                                  defaultValue={r.packFix?.packSize ?? ""}
                                  placeholder={r.offers[0]?.packSize ?? "180 EA"}
                                  className="field mt-0.5 w-32 py-1 text-xs"
                                />
                              </label>
                              <label className="min-w-[12rem] flex-1 text-[11px] text-ink-2">
                                What you checked it against
                                <input name="note" defaultValue={r.packFix?.note ?? ""} placeholder="the bottle on the shelf" className="field mt-0.5 py-1 text-xs" />
                              </label>
                              <button className="btn btn-sm btn-primary text-xs">Settle the package</button>
                            </form>
                            <p className="mt-1 text-[11px] text-ink-3">
                              This applies to every supplier, including ones we have never bought from, and survives next
                              week&rsquo;s files. Write it as the bottle does — 180 EA, 473 ML, 30 GM.
                            </p>
                            {r.packFix && (
                              <form action={unsettle} className="mt-2">
                                <input type="hidden" name="back" value={search} />
                                <input type="hidden" name="ndc11" value={r.ndc11} />
                                <button className="btn btn-sm text-xs">Put the suppliers&rsquo; figures back</button>
                              </form>
                            )}

                            {r.offers.length > 0 && (
                              <details className="mt-3">
                                <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-accent">
                                  Correct one supplier&rsquo;s price
                                </summary>
                                {r.offers.map((o) => (
                                  <form key={o.supplier} action={correctPrice} className="mt-2 flex flex-wrap items-end gap-2">
                                    <input type="hidden" name="back" value={search} />
                                    <input type="hidden" name="ndc11" value={r.ndc11} />
                                    <input type="hidden" name="supplier" value={o.supplier} />
                                    <span className="w-32 text-[11px] text-ink-2">{o.supplier}</span>
                                    <label className="text-[11px] text-ink-2">
                                      Cost per unit
                                      <input
                                        name="unitCost"
                                        placeholder={o.unitCostMicros ? (o.unitCostMicros / 1_000_000).toFixed(4) : "0.6200"}
                                        className="field mt-0.5 w-28 py-1 text-xs"
                                      />
                                    </label>
                                    <label className="min-w-[10rem] flex-1 text-[11px] text-ink-2">
                                      What you checked it against
                                      <input name="note" placeholder="their invoice" className="field mt-0.5 py-1 text-xs" />
                                    </label>
                                    <button className="btn btn-sm text-xs">Save</button>
                                  </form>
                                ))}
                              </details>
                            )}
                          </>
                        )}
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}
