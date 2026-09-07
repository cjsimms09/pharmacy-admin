import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { searchCatalogue, catalogueHealth, correctItem, clearCorrection } from "@/lib/catalogue";
import { formatCents } from "@/lib/money";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Notice, Empty, Figure, Field } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "The supplier catalogue" };

/**
 * What the suppliers say they sell, and what is wrong with it.
 *
 * Forty-five thousand items arrive every week, and until now not one of them could be looked at.
 * Everything that decides money — what to buy, from whom, whether a plan pays enough — rests on
 * these rows, and the only evidence any of it was right was that nothing had obviously broken.
 * The pharmacy had already spotted pack sizes and prices that were plainly wrong and had no way to
 * say so.
 *
 * Three checks lead, because they are the ones that quietly produce a wrong answer somewhere else:
 * a pack size that gives no number of units drops the item out of every comparison; a pack cost
 * that disagrees with its own unit cost means one of them was read from the wrong column; and a
 * price a factor away from NADAC is almost always a pack price sitting in a unit column. A dear
 * drug is not a problem, and is not treated as one.
 *
 * A correction is kept in a table of its own and applied over every import, so next Monday's file
 * does not undo it — and it is applied where the catalogue is read rather than here, so the buy
 * list spends money on the corrected figure and not on the one the screen showed.
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; supplier?: string; problems?: string; fixed?: string; ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const canManage = user.role !== "staff";
  const sp = await searchParams;
  const problemsOnly = sp.problems === "1";
  const fixedOnly = sp.fixed === "1";

  const [health, found] = await Promise.all([
    catalogueHealth(),
    searchCatalogue({ text: sp.q, supplier: sp.supplier, problemsOnly, fixedOnly, limit: 200 }),
  ]);

  /*
   * Where to go back to once a row has been corrected.
   *
   * A person gets here by searching for one drug. Sending them back to the whole forty-five
   * thousand after every correction means finding it again to check the correction took, which is
   * how a second one never gets made. The search travels with the form.
   */
  const backTo = (extra: Record<string, string>, from?: string) =>
    `/purchasing/catalog?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(from ?? "")), ...extra }).toString()}`;

  async function correct(fd: FormData) {
    "use server";
    const u = await requireManager();
    const back = String(fd.get("back") ?? "");
    const where = (extra: Record<string, string>) =>
      `/purchasing/catalog?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(back)), ...extra }).toString()}`;
    const dollars = String(fd.get("unitCost") ?? "").trim();
    const n = dollars ? Number(dollars) : NaN;
    if (dollars && (!Number.isFinite(n) || n <= 0)) {
      redirect(where({ error: "The unit cost has to be an amount in dollars, per dispensing unit." }));
    }
    const message = await correctItem(
      {
        supplier: String(fd.get("supplier") ?? ""),
        ndc11: String(fd.get("ndc11") ?? ""),
        packSize: String(fd.get("packSize") ?? ""),
        unitCostMicros: dollars ? Math.round(n * 1_000_000) : null,
        note: String(fd.get("note") ?? ""),
      },
      u,
    );
    revalidatePath("/purchasing/catalog");
    revalidatePath("/purchasing");
    redirect(where({ ok: message }));
  }

  async function undo(fd: FormData) {
    "use server";
    const u = await requireManager();
    const back = String(fd.get("back") ?? "");
    const message = await clearCorrection(String(fd.get("supplier") ?? ""), String(fd.get("ndc11") ?? ""), u);
    revalidatePath("/purchasing/catalog");
    revalidatePath("/purchasing");
    redirect(`/purchasing/catalog?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(back)), ok: message }).toString()}`);
  }

  const perUnit = (micros: number | null) => (micros === null ? "—" : `$${(micros / 1_000_000).toFixed(4)}`);
  const search = new URLSearchParams({
    ...(sp.q ? { q: sp.q } : {}),
    ...(sp.supplier ? { supplier: sp.supplier } : {}),
    ...(problemsOnly ? { problems: "1" } : {}),
    ...(fixedOnly ? { fixed: "1" } : {}),
  }).toString();
  const keep = (extra: Record<string, string>) => backTo(extra, search);

  return (
    <>
      <PageHeader
        title="The supplier catalogue"
        subtitle="What each wholesaler says it sells, at what pack size and what price — and what does not add up. Correcting a row here changes what the buy list spends, and survives next week's file."
        actions={<Link href="/purchasing" className="btn btn-sm">What to buy</Link>}
      />
      {sp.ok && <Notice kind="ok">{sp.ok}</Notice>}
      {sp.error && <Notice kind="crit">{sp.error}</Notice>}

      {health.total === 0 ? (
        <Empty>
          No catalogue has been imported. They arrive by email from PioneerRx, or can be uploaded on the{" "}
          <Link href="/purchasing" className="text-accent underline">purchasing page</Link>.
        </Empty>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Figure value={health.total.toLocaleString()} label="items held" sub={`across ${health.suppliers.length} supplier${health.suppliers.length === 1 ? "" : "s"}`} tone="muted" />
            <Figure
              value={health.wrong.toLocaleString()}
              label="rows that do not add up"
              sub="A pack size or a price that contradicts itself"
              href={keep({ problems: "1" })}
              tone={health.wrong > 0 ? "crit" : "ok"}
            />
            <Figure
              value={health.worthChecking.toLocaleString()}
              label="worth a look"
              sub="Far from NADAC, or a list price under cost"
              href={keep({ problems: "1" })}
              tone={health.worthChecking > 0 ? "warn" : "ok"}
            />
            <Figure
              value={health.fixed.toLocaleString()}
              label="corrected by you"
              sub="Applied over every import from now on"
              href={keep({ fixed: "1" })}
              tone="muted"
            />
          </div>

          <Card className="mb-4" title="Find an item" subtitle="By NDC, or by any part of the name the supplier gives it.">
            <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
              <Field label="NDC or name">
                <input name="q" defaultValue={sp.q ?? ""} className="field" placeholder="acamprosate, or 68462" />
              </Field>
              <Field label="Supplier">
                <select name="supplier" defaultValue={sp.supplier ?? ""} className="field">
                  <option value="">Any supplier</option>
                  {health.suppliers.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <label className="flex items-end gap-2 pb-2 text-xs text-ink-2">
                <input type="checkbox" name="problems" value="1" defaultChecked={problemsOnly} /> Only ones with a problem
              </label>
              <div className="flex items-end">
                <button className="btn btn-primary">Search</button>
              </div>
            </form>
            {health.bySupplier.length > 1 && (
              <p className="mt-3 text-xs text-ink-3">
                {health.bySupplier.map((s) => `${s.supplier}: ${s.items.toLocaleString()} items, ${s.wrong.toLocaleString()} not adding up`).join(" · ")}
              </p>
            )}
          </Card>

          <Card
            title={problemsOnly ? "Rows with something wrong" : "Items"}
            count={found.matched}
            subtitle={
              found.matched > found.rows.length
                ? `Showing the first ${found.rows.length}. Narrow the search to see the rest.`
                : "Worst first, then by what being wrong about it costs — not by what the pack costs."
            }
          >
            {found.rows.length === 0 ? (
              <Empty>Nothing matches. {problemsOnly ? "Which, on this filter, is the answer you want." : ""}</Empty>
            ) : (
              <ul className="rows">
                {found.rows.map((r) => (
                  <li key={`${r.supplier}|${r.ndc11}`} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="min-w-0">
                        <b className="text-sm">{r.description ?? "(no name)"}</b>
                        <span className="ml-2 font-mono text-xs text-ink-3">{r.ndc11}</span>
                        <span className="ml-2 text-xs text-ink-3">{r.supplier}</span>
                        {r.contractFlag && <span className="badge badge-ok ml-2">{r.contractFlag}</span>}
                        {r.fix && <span className="badge badge-muted ml-2">corrected</span>}
                      </span>
                      <span className="shrink-0 text-xs text-ink-3">{r.pricedOn ? `priced ${fmt(r.pricedOn)}` : "no price date"}</span>
                    </div>

                    <div className="mt-1 grid gap-2 text-xs text-ink-2 sm:grid-cols-4">
                      <span>
                        Pack <b>{r.packSize ?? "—"}</b>
                        {r.packUnits !== null && <span className="text-ink-3"> ({r.packUnits} units)</span>}
                      </span>
                      <span>Unit <b>{perUnit(r.unitCostMicros)}</b></span>
                      <span>Pack cost <b>{r.packCostCents === null ? "—" : formatCents(r.packCostCents)}</b></span>
                      <span>
                        NADAC <b>{perUnit(r.nadacUnitMicros)}</b>
                        {r.awpCents !== null && <span className="text-ink-3"> · AWP {formatCents(r.awpCents)}</span>}
                      </span>
                    </div>

                    {r.asImported && (
                      <p className="mt-1 text-[11px] text-ink-3">
                        The file said {r.asImported.packSize ?? "—"} at {perUnit(r.asImported.unitCostMicros)} a unit.
                        {r.fix?.note ? ` Corrected: ${r.fix.note}` : ""} {r.fix ? `— ${r.fix.correctedBy}` : ""}
                      </p>
                    )}

                    {r.problems.map((p) => (
                      <p key={p.kind} className={`mt-1 text-xs ${p.level === "wrong" ? "text-crit" : "text-warn"}`}>
                        <b>{p.says}</b> <span className="text-ink-2">{p.todo}</span>
                      </p>
                    ))}

                    {canManage && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-accent">
                          {r.fix ? "Change or remove the correction" : "Correct this row"}
                        </summary>
                        <form action={correct} className="mt-2 flex flex-wrap items-end gap-2">
                          <input type="hidden" name="back" value={search} />
                          <input type="hidden" name="supplier" value={r.supplier} />
                          <input type="hidden" name="ndc11" value={r.ndc11} />
                          <label className="text-[11px] text-ink-2">
                            Pack size
                            <input
                              name="packSize"
                              defaultValue={r.fix?.packSize ?? ""}
                              placeholder={r.packSize ?? "180 EA"}
                              className="field mt-0.5 w-32 py-1 text-xs"
                            />
                          </label>
                          <label className="text-[11px] text-ink-2">
                            Cost per unit
                            <input
                              name="unitCost"
                              defaultValue={r.fix?.unitCostMicros ? (r.fix.unitCostMicros / 1_000_000).toFixed(4) : ""}
                              placeholder={r.unitCostMicros ? (r.unitCostMicros / 1_000_000).toFixed(4) : "0.6200"}
                              className="field mt-0.5 w-28 py-1 text-xs"
                            />
                          </label>
                          <label className="min-w-[12rem] flex-1 text-[11px] text-ink-2">
                            What you checked it against
                            <input name="note" defaultValue={r.fix?.note ?? ""} placeholder="the bottle on the shelf" className="field mt-0.5 py-1 text-xs" />
                          </label>
                          <button className="btn btn-sm btn-primary text-xs">Save the correction</button>
                        </form>
                        <p className="mt-1 text-[11px] text-ink-3">
                          Leave a box empty to keep the supplier&rsquo;s own figure. The pack cost follows from the two,
                          so it never has to be typed. This is what the buy list will spend on from now on.
                        </p>
                        {r.fix && (
                          <form action={undo} className="mt-2">
                            <input type="hidden" name="back" value={search} />
                            <input type="hidden" name="supplier" value={r.supplier} />
                            <input type="hidden" name="ndc11" value={r.ndc11} />
                            <button className="btn btn-sm text-xs">Put the supplier&rsquo;s figures back</button>
                          </form>
                        )}
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}
