import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { searchDrugs, drugFileHealth, settlePackSize, clearPackSize, marginOf } from "@/lib/drug-catalog";
import { correctItem } from "@/lib/catalogue";
import { formatCents } from "@/lib/money";
import { fmt } from "@/lib/dates";
import { directoryStatus, loadDrugDirectory } from "@/lib/drug-directory-store";
import { directoryJob, directoryJobRunning, startDirectoryFetch, runDirectoryFetch } from "@/lib/drug-directory-job";
import { familyTabs } from "@/lib/families";
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
/*
 * The FDA fetch, at module level rather than inside the component.
 *
 * An inline server action's closed-over variables are serialised into the form and a function
 * cannot be, so an action defined beside the others in the component renders as "Functions cannot
 * be passed directly to Client Components" in production. The NADAC page learned this the same way.
 */
async function fetchDirectory(): Promise<never> {
  "use server";
  const u = await requireManager();
  const r = await startDirectoryFetch(u);
  if (r.started) after(() => runDirectoryFetch(u, r.runId!));
  revalidatePath("/purchasing/catalog");
  redirect(`/purchasing/catalog?${r.started ? "ok" : "error"}=` + encodeURIComponent(r.message));
}

/** The same two zips, uploaded by hand, for a day the FDA cannot be reached from the pharmacy. */
async function uploadDirectory(fd: FormData): Promise<never> {
  "use server";
  const u = await requireManager();
  const read = async (name: string): Promise<Buffer | undefined> => {
    const f = fd.get(name);
    if (!(f instanceof File) || f.size === 0) return undefined;
    return Buffer.from(await f.arrayBuffer());
  };
  const ndcDirectoryZip = await read("ndcZip");
  const orangeBookZip = await read("orangeBookZip");
  if (!ndcDirectoryZip && !orangeBookZip) {
    redirect("/purchasing/catalog?error=" + encodeURIComponent("No file was chosen, so nothing was loaded."));
  }
  const r = await loadDrugDirectory({ ndcDirectoryZip, orangeBookZip }, { userId: u.id, origin: "uploaded" });
  if (r.ok) (await import("@/lib/drug-catalog")).forgetDrugFile();
  revalidatePath("/purchasing/catalog");
  redirect(
    `/purchasing/catalog?${r.ok ? "ok" : "error"}=` +
      encodeURIComponent(
        r.ok
          ? `Loaded ${r.rows.toLocaleString()} packages, ${r.rated.toLocaleString()} of them with an Orange Book rating.`
          : r.why,
      ),
  );
}

export default async function DrugFilePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string; supplier?: string; mismatch?: string; problems?: string; dispensed?: string; fixed?: string; switchable?: string; ok?: string; error?: string;
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
    switchableOnly: sp.switchable === "1",
  };

  const [health, found, directory, job] = await Promise.all([
    drugFileHealth(),
    searchDrugs({ text: sp.q, supplier: sp.supplier, ...flags, limit: 150 }),
    directoryStatus(),
    directoryJob(),
  ]);
  const fetching = directoryJobRunning(job);

  const search = new URLSearchParams({
    ...(sp.q ? { q: sp.q } : {}),
    ...(sp.supplier ? { supplier: sp.supplier } : {}),
    ...(flags.mismatchOnly ? { mismatch: "1" } : {}),
    ...(flags.problemsOnly ? { problems: "1" } : {}),
    ...(flags.dispensedOnly ? { dispensed: "1" } : {}),
    ...(flags.fixedOnly ? { fixed: "1" } : {}),
    ...(flags.switchableOnly ? { switchable: "1" } : {}),
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
        tabs={familyTabs("order", "/purchasing/catalog")}
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
          <div className="mb-4 grid gap-3 sm:grid-cols-5">
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
            {/* The money on this page: the same drug, rated interchangeable by the FDA, from a labeller who charges less. */}
            <Figure
              value={health.switchable.toLocaleString()}
              label="a cheaper equivalent exists"
              sub={
                health.inDirectory === 0
                  ? "Load the FDA directory below to answer this"
                  : `${formatCents(health.switchableSavingsCents)} on the fills already on file`
              }
              href={health.inDirectory === 0 ? undefined : keep({ switchable: "1" })}
              tone={health.switchable > 0 ? "warn" : "muted"}
            />
          </div>

          {/*
            * What says two NDCs are the same drug.
            *
            * Without it the site groups on the words in a wholesaler's description — which carry the
            * labeller and the pack count, so every labeller lands in its own group and the one
            * question worth asking on this page, "is somebody else's version of this cheaper", cannot
            * be asked at all. The two files are free, public and weekly.
            */}
          {canManage && (
            <Card
              className="mb-4"
              title="What says two NDCs are the same drug"
              subtitle="The FDA's NDC Directory and the Orange Book. Free, public, and the only thing that can rate one labeller's tablet interchangeable with another's."
              tone={directory.rows === 0 ? "warn" : undefined}
            >
              {directory.rows === 0 ? (
                <p className="text-sm text-ink-2">
                  Neither file is loaded, so nothing on this page can say what else is the same drug. Until it is,
                  every labeller sits in a group of its own and a cheaper equivalent cannot be found.
                </p>
              ) : (
                <p className="text-sm text-ink-2">
                  <b>{directory.rows.toLocaleString()}</b> packages held, <b>{directory.rated.toLocaleString()}</b> of
                  them with a therapeutic equivalence rating.{" "}
                  {directory.lastLoad.length > 0 && (
                    <span className="text-ink-3">
                      Last loaded {directory.lastLoad.map((l) => `${l.source === "orange_book" ? "the Orange Book" : "the NDC Directory"} on ${fmt(l.loadedAt)} from ${l.origin}`).join("; ")}.
                    </span>
                  )}
                </p>
              )}

              {job && (
                <p className={`mt-2 text-xs ${job.state === "failed" ? "text-crit" : fetching ? "text-ink-2" : "text-ink-3"}`}>
                  <b>{fetching ? "Fetching" : job.state === "failed" ? "The last fetch failed" : "The last fetch finished"}:</b>{" "}
                  {job.step}
                  {fetching ? " Refresh this page to see where it has got to." : ""}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-end gap-4">
                <form action={fetchDirectory}>
                  <button className="btn btn-primary" disabled={fetching}>
                    {fetching ? "Fetching…" : directory.rows === 0 ? "Fetch both files from the FDA" : "Refresh from the FDA"}
                  </button>
                </form>
                <details className="text-xs text-ink-3">
                  <summary className="cursor-pointer hover:text-accent">Or load the zips by hand</summary>
                  <form action={uploadDirectory} className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="text-[11px] text-ink-2">
                      ndctext.zip
                      <input type="file" name="ndcZip" accept=".zip" className="field mt-0.5 py-1 text-xs" />
                    </label>
                    <label className="text-[11px] text-ink-2">
                      The Orange Book zip
                      <input type="file" name="orangeBookZip" accept=".zip" className="field mt-0.5 py-1 text-xs" />
                    </label>
                    <button className="btn btn-sm text-xs">Load</button>
                  </form>
                  <p className="mt-1 max-w-prose">
                    ndctext.zip is at accessdata.fda.gov/cder/ndctext.zip; the Orange Book is the
                    &ldquo;EOBZIP&rdquo; download on fda.gov. Either may be left blank to keep what is held for it.
                  </p>
                </details>
              </div>
            </Card>
          )}

          {/*
            * Item numbers arrive with the catalogue; they cannot be typed in one at a time.
            *
            * Said once here rather than as "not given" on every line of every drug, which reads as
            * twenty-four wholesalers withholding it rather than as one import that predates the
            * column. Monday's files fill it in without anybody doing anything.
            */}
          {health.total > 0 && health.withItemNumber === 0 && (
            <Notice kind="warn">
              No supplier line on file carries the wholesaler&rsquo;s own item number, so no order here can name a
              line yet. The catalogues held were imported before the site read that column. It fills in by itself
              with the next catalogue — they arrive weekly by email — or at once by re-uploading them on the{" "}
              <Link href="/purchasing" className="text-accent underline">purchasing page</Link>.
            </Notice>
          )}

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
                { on: flags.switchableOnly, to: keep({ switchable: flags.switchableOnly ? "" : "1" }), label: "A cheaper equivalent exists" },
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

                      {r.offers.filter((o) => o.withheld).map((o) => (
                        <p key={`withheld-${o.supplier}`} className="mt-1 text-xs text-crit">
                          <b>{o.withheld}</b>{" "}
                          <span className="text-ink-2">Settle the package below, or correct their price, and it counts again.</span>
                        </p>
                      ))}

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

                      {/*
                        * The same drug from another labeller, and what switching is worth.
                        *
                        * Rated by the Orange Book, not guessed from a name: the same ingredients,
                        * strength, form and route, and the same A-rating down to its subgroup. The
                        * saving is drawn from the net price so a rebate that makes a dearer printed
                        * price the cheaper buy is not lost, and it carries the supplier's own item
                        * number, because a switch nobody can order is not an answer.
                        */}
                      {r.equivalence?.cheaper && (
                        <p className="mt-1 text-xs text-warn">
                          <b>
                            {r.equivalence.cheaper.name ?? r.equivalence.cheaper.ndc11} is the same drug at{" "}
                            {perUnit(r.equivalence.cheaper.netUnitMicros)} a unit
                          </b>{" "}
                          <span className="text-ink-2">
                            — {perUnit(r.equivalence.savesPerUnitMicros)} a unit less
                            {r.equivalence.savesOnFilledCents
                              ? `, which is ${formatCents(r.equivalence.savesOnFilledCents)} across the fills already on file`
                              : ""}
                            . {r.equivalence.cheaper.supplier ?? "A supplier"}
                            {r.equivalence.cheaper.itemNumber ? ` item ${r.equivalence.cheaper.itemNumber}` : ""}
                            {r.equivalence.cheaper.labeler ? `, made by ${r.equivalence.cheaper.labeler}` : ""}
                            {r.equivalence.teCode ? `. Both are rated ${r.equivalence.teCode}` : ""}
                            {r.equivalence.cheaper.onShelf ? ", and it is already on the shelf" : ""}.
                          </span>
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
                                <th className="pb-1 text-left font-medium">Their number</th>
                                <th className="pb-1 text-left font-medium">Package</th>
                                <th className="pb-1 text-right font-medium">A unit</th>
                                <th className="pb-1 text-right font-medium">Net a unit</th>
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
                                    {/* Withheld, not missing: a price the arithmetic says is wrong decides nothing. */}
                                    {o.withheld && <span className="badge badge-crit ml-1" title={o.withheld}>price withheld</span>}
                                  </td>
                                  {/* An NDC says which drug; this is what an order has to carry. */}
                                  <td className="py-1 font-mono text-[11px]">{o.itemNumber ?? <span className="text-warn" title="Their price file did not carry an item number for this line, so an order cannot name it.">not given</span>}</td>
                                  <td className="py-1">{o.packSize ?? "—"}</td>
                                  <td className="py-1 text-right tabular-nums text-ink-3">{perUnit(o.unitCostMicros)}</td>
                                  {/* What it really costs: the printed price less the rebate this line earns. This is the column to compare on. */}
                                  <td className="py-1 text-right font-medium tabular-nums">
                                    {perUnit(o.netUnitMicros)}
                                    {o.rebateApplied && <span className="ml-1 text-[10px] text-ok">net</span>}
                                  </td>
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

                        {/*
                          * A contract item with no ladder on file: the net column is the printed price.
                          *
                          * Silence here would be the expensive kind. McKesson marks seven thousand lines as
                          * OneStop; until their ladder is recorded the site takes nothing off any of them, so
                          * every comparison against a wholesaler who pays no rebate is decided on the wrong
                          * figure — and it looks right, because the column is filled in.
                          */}
                        {r.offers.some((o) => o.contractFlag === "rebated" && !o.rebateApplied) && (
                          <p className="mt-2 text-[11px] text-warn">
                            {r.offers.filter((o) => o.contractFlag === "rebated" && !o.rebateApplied).map((o) => o.supplier).join(" and ")}{" "}
                            {r.offers.filter((o) => o.contractFlag === "rebated" && !o.rebateApplied).length === 1 ? "marks this" : "mark this"} a
                            contract item, but no rebate ladder is on file for{" "}
                            {r.offers.filter((o) => o.contractFlag === "rebated" && !o.rebateApplied).length === 1 ? "them" : "them"}, so the net
                            price above is the printed one and the comparison understates them.{" "}
                            <Link href="/suppliers" className="text-accent underline">Record the ladder</Link> and every
                            figure here follows.
                          </p>
                        )}

                        {/* Every interchangeable NDC, so the choice is visible rather than only its winner. */}
                        {r.equivalence && (r.equivalence.others.length > 0 || r.equivalence.why) && (
                          <div className="mt-3">
                            <p className="text-[11px] font-medium text-ink-2">
                              The same drug from other labellers
                              {r.equivalence.genericName ? (
                                <span className="font-normal text-ink-3">
                                  {" "}
                                  — {r.equivalence.genericName}
                                  {r.equivalence.strength ? ` ${r.equivalence.strength}` : ""}
                                  {r.equivalence.form ? `, ${r.equivalence.form.toLowerCase()}` : ""}
                                  {r.equivalence.teCode ? `, rated ${r.equivalence.teCode}` : ""}
                                </span>
                              ) : null}
                            </p>
                            {r.equivalence.others.length > 0 ? (
                              <table className="mt-1 w-full text-xs">
                                <thead className="text-ink-3">
                                  <tr>
                                    <th className="pb-1 text-left font-medium">NDC</th>
                                    <th className="pb-1 text-left font-medium">Made by</th>
                                    <th className="pb-1 text-left font-medium">Cheapest from</th>
                                    <th className="pb-1 text-left font-medium">Their number</th>
                                    <th className="pb-1 text-right font-medium">Net a unit</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.equivalence.others.slice(0, 12).map((o) => (
                                    <tr key={o.ndc11} className="border-t border-line">
                                      <td className="py-1 font-mono text-[11px]">
                                        <Link href={keep({ q: o.ndc11 })} className="hover:text-accent hover:underline">{o.ndc11}</Link>
                                        {o.onShelf && <span className="badge badge-muted ml-1">on the shelf</span>}
                                      </td>
                                      <td className="py-1">{o.labeler ?? "—"}</td>
                                      <td className="py-1">{o.supplier ?? <span className="text-ink-3">nobody prices it</span>}</td>
                                      <td className="py-1 font-mono text-[11px]">{o.itemNumber ?? "—"}</td>
                                      <td className="py-1 text-right tabular-nums">{perUnit(o.netUnitMicros)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : null}
                            {r.equivalence.why && <p className="mt-1 text-[11px] text-ink-3">{r.equivalence.why}</p>}
                          </div>
                        )}

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
