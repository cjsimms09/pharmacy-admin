import { familyTabs } from "@/lib/families";
import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importSupplierCatalog, importPioneerCatalog, supplierSummary, catalogSchedule } from "@/lib/suppliers";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { FILE_NAME_CODES, looksLikePioneerCatalog } from "@/lib/pioneer-catalog";
import { formatCents } from "@/lib/money";
import { countAge } from "@/lib/count-age";
import { fmt, todayIso } from "@/lib/dates";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Field, Card, Figure } from "@/components/ui";
import { Hub } from "@/components/hub";
import { minimumsNow } from "@/lib/minimum-store";

export const metadata = { title: "What to buy" };
export const dynamic = "force-dynamic";

const money = (cents: number) => formatCents(cents);
const perUnit = (micros: number | null) => (micros === null ? "—" : `$${(Math.abs(micros) / 1_000_000).toFixed(4)}`);

/**
 * What to order from each secondary this week, to reach its minimum.
 *
 * The owner's brief: "the whole goal of this page is to list things we could order from secondary
 * suppliers to meet our minimum order amount. McKesson shouldn't be on this list." So the page is
 * one section per secondary, and each section is one order: what the shelf needs that this
 * supplier is cheapest on, then what to add to reach their minimum — generics this supplier is
 * the best place to buy, in quantities the next two months will use — with the supplier's own
 * item number on every row so the order can be keyed straight in. The primary gets everything the
 * secondaries do not beat, as it always did; that is one line here and the whole of the shelf page.
 */
type Row = {
  kind: "short" | "next";
  itemNumber: string | null;
  ndc11: string;
  name: string | null;
  packs: number;
  packQty: number;
  units: number;
  unitMicros: number;
  costCents: number;
  savingCents: number;
  daysOnHand: number;
  perDayThousandths: number;
  daysAfter: number;
  /** For a next-best line: whole packs the horizon allows. */
  maxPacks: number | null;
  /** For a short line: why this quantity, and the ceiling it breaks, from the planner. */
  why: string | null;
  overCap: { days: number; cap: number; smallerPack: { supplier: string; packQty: number; days: number; costCents: number } | null } | null;
  alternative: { supplier: string; unitMicros: number } | null;
  runningCents: number;
  /** The line at which the running total first reaches the minimum. */
  reaches: boolean;
};

const days = (d: number) => (Number.isFinite(d) ? String(Math.round(d)) : "—");

export default async function WhatToBuyPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const { buyListNow, SHELF_POLICY, nextTierNow } = await import("@/lib/shelf");
  const [buyList, minimums, nextTier, summary, schedule, s, mailReady] = await Promise.all([
    buyListNow(),
    minimumsNow(),
    nextTierNow(),
    supplierSummary(),
    catalogSchedule(),
    getSettings(),
    hasMailPassword(),
  ]);
  const autoImport = (s.mail_auto_import ?? "").toLowerCase() === "yes";
  const mailOn = s.mail_enabled === "yes";
  const countAge_ = buyList.snapshot ? countAge(buyList.snapshot.countedOn, todayIso()) : null;

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const supplier = String(fd.get("supplier") ?? "").trim();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) redirect("/purchasing?error=" + encodeURIComponent("Choose a file."));
    const buf = Buffer.from(await file.arrayBuffer());
    try {
      /*
       * PioneerRx's own export names its suppliers inside the file, so it needs no supplier typed
       * and may carry several at once. Detected from the content, not the name somebody gave it.
       */
      if (looksLikePioneerCatalog(buf.subarray(0, 8192).toString("utf8"))) {
        const r = await importPioneerCatalog(buf, file.name, u.id);
        await audit({ action: "supplier.import", userId: u.id, userName: u.name, details: `${file.name}: ${r.suppliers.map((x) => `${x.supplier} ${x.itemsAdded}+${x.itemsUpdated}`).join(", ")}` });
        revalidatePath("/purchasing");
        if (r.suppliers.length === 0) redirect("/purchasing?error=" + encodeURIComponent(r.problems.join(" ") || "Nothing could be loaded from that file."));
        const bits = r.suppliers.map((x) => `${x.supplier}: ${x.itemsAdded} new, ${x.itemsUpdated} repriced${x.shortDated ? `, ${x.shortDated} short-dated lots noted` : ""}${x.rebated !== null ? `, ${x.rebated} rebated` : ", no rebate column"}`);
        if (r.pricedOn) bits.push(`prices as of ${r.pricedOn}`);
        if (r.skipped) bits.push(`${r.skipped.toLocaleString()} rows skipped (${Object.entries(r.skipReasons).map(([k, v]) => `${v} ${k}`).join(", ")})`);
        redirect("/purchasing?ok=" + encodeURIComponent(bits.join(". ") + "."));
      }
      if (!supplier) redirect("/purchasing?error=" + encodeURIComponent("Name the supplier this file came from."));
      const r = await importSupplierCatalog(buf, file.name, supplier, u.id);
      await audit({ action: "supplier.import", userId: u.id, userName: u.name, details: `${supplier}: ${r.itemsAdded} added, ${r.itemsUpdated} updated, ${r.skipped} skipped` });
      revalidatePath("/purchasing");
      const bits = [`${r.itemsAdded} new and ${r.itemsUpdated} updated for ${supplier}`];
      if (r.skipped) bits.push(`${r.skipped} skipped (${Object.entries(r.skipReasons).map(([k, v]) => `${v} ${k}`).join(", ")})`);
      if (r.unkeyable) bits.push(`${r.unkeyable} could not be matched to a product by description`);
      if (r.unmappedColumns.length) bits.push(`columns not recognised: ${r.unmappedColumns.slice(0, 6).join(", ")}`);
      redirect("/purchasing?ok=" + encodeURIComponent(bits.join(". ") + "."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/purchasing?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read that file."));
    }
  }


  const primary = buyList.suppliers.find((x) => x.primary) ?? null;
  const primaryBasket = primary ? buyList.plan.baskets.find((b) => b.supplier === primary.supplier) ?? null : null;
  /*
   * One order per secondary: the basket the planner built (needs it is cheapest on, and the
   * top-ups it chose) plus the minimum filler's picks, in one table. The two were on two pages
   * and read as two orders to the same wholesaler.
   */
  /*
   * One card per secondary: everything worth ordering there today, ranked. First what the shelf
   * is short of and this wholesaler is cheapest on, sized to the need; then every generic that
   * qualifies to add, soonest needed first, one pack each. A running total runs down the whole
   * list so the line at which the minimum is reached is visible without arithmetic. The site
   * cannot see what is in the cart at the wholesaler's website and does not pretend to: it ranks,
   * the pharmacist orders.
   */
  const sections = buyList.suppliers
    .filter((x) => !x.primary)
    .map((sup) => {
      const basket = buyList.plan.baskets.find((b) => b.supplier === sup.supplier) ?? null;
      const fill = minimums.fills.find((f) => f.supplier === sup.supplier) ?? null;
      const minimumCents = sup.minimumCents ?? null;
      let run = 0;
      const reach = (before: number, after: number) => minimumCents !== null && before < minimumCents && after >= minimumCents;
      const rows: Row[] = [];
      for (const l of (basket?.lines ?? []).filter((l) => l.reason === "need")) {
        const shelf = minimums.shelf.get(l.ndc11);
        const before = run;
        run += l.costCents;
        rows.push({
          kind: "short",
          itemNumber: l.itemNumber ?? null,
          ndc11: l.ndc11,
          name: l.name,
          packs: l.packs,
          packQty: l.packQty,
          units: Math.round(l.unitsThousandths / 1000),
          unitMicros: l.effectiveUnitMicros,
          costCents: l.costCents,
          savingCents: l.savingCents,
          daysOnHand: shelf && shelf.perDayThousandths > 0 ? shelf.onHandThousandths / shelf.perDayThousandths : Infinity,
          perDayThousandths: shelf?.perDayThousandths ?? 0,
          daysAfter: l.daysOfStockAfter,
          maxPacks: null,
          why: l.why,
          overCap: l.overCap,
          alternative: null,
          runningCents: run,
          reaches: reach(before, run),
        });
      }
      const shortCount = rows.length;
      const needCents = run;
      const needSavingCents = rows.reduce((n, r) => n + r.savingCents, 0);
      for (const c of fill?.candidates ?? []) {
        const before = run;
        run += c.packCostCents;
        rows.push({
          kind: "next",
          itemNumber: c.itemNumber,
          ndc11: c.ndc11,
          name: c.name,
          packs: 1,
          packQty: c.packQty,
          units: c.packQty,
          unitMicros: c.unitMicros,
          costCents: c.packCostCents,
          savingCents: c.savingPerPackCents,
          daysOnHand: c.daysOnHand,
          perDayThousandths: c.perDayThousandths,
          daysAfter: c.daysAfterOnePack,
          maxPacks: c.maxPacks,
          why: null,
          overCap: null,
          alternative: c.alternative,
          runningCents: run,
          reaches: reach(before, run),
        });
      }
      const crossAt = rows.findIndex((r) => r.reaches);
      // Every short line, then the next-best ones up to the crossing and a few past it.
      const shown = crossAt >= 0 ? rows.slice(0, Math.max(shortCount, crossAt + 7)) : rows.slice(0, shortCount + 25);
      const nextCount = rows.length - shortCount;
      const allAddCents = (fill?.candidates ?? []).reduce((n, c) => n + c.packCostCents * c.maxPacks, 0);
      const toAddCents = minimumCents === null ? 0 : Math.max(0, minimumCents - needCents);
      const state: "nothing" | "no_minimum" | "meets" | "reachable" | "deeper" | "short" =
        minimumCents === null
          ? "no_minimum"
          : rows.length === 0
            ? "nothing"
            : needCents >= minimumCents
              ? "meets"
              : crossAt >= 0
                ? "reachable"
                : needCents + allAddCents >= minimumCents
                  ? "deeper"
                  : "short";
      return { sup, basket, fill, rows, shown, shortCount, nextCount, needCents, needSavingCents, minimumCents, crossAt, toAddCents, allAddCents, state };
    })
    .sort((a, b) => Number(b.shortCount > 0) - Number(a.shortCount > 0) || b.needCents - a.needCents || (b.minimumCents ?? 0) - (a.minimumCents ?? 0));
  const withMinimum = sections.filter((x) => x.minimumCents !== null);
  const active = withMinimum.filter((x) => x.state !== "nothing");
  const meeting = active.filter((x) => x.state === "meets");
  const reachable = active.filter((x) => x.state === "reachable" || x.state === "deeper");
  const shortOnes = active.filter((x) => x.state === "short");
  const toAddAll = active.reduce((n, x) => n + x.toAddCents, 0);
  const missing = [...new Set([...buyList.missing, ...minimums.missing])];

  return (
    <>
      <PageHeader
        tabs={familyTabs("order", "/purchasing")}
        title="What to buy"
        subtitle={`One order per secondary wholesaler: what the shelf needs that they are cheapest on, and what to add to reach their minimum. ${primary ? `${primary.supplier} gets everything else as usual.` : ""}`}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {countAge_ && countAge_.warns && (
        <Notice kind="warn">
          <b>The shelf was {countAge_.says}</b> — {fmt(buyList.snapshot!.countedOn)}. {countAge_.warns}{" "}
          <Link href="/purchasing/shelf" className="underline">Upload it here</Link>.
        </Notice>
      )}
      {missing.map((m) => <Notice key={m} kind="warn">{m}</Notice>)}
      {sections.filter((x) => x.rows.length > 0 && x.rows.every((r) => !r.itemNumber)).map((x) => (
        <Notice key={x.sup.supplier} kind="warn">
          <b>{x.sup.supplier}&rsquo;s price file carried no item numbers</b>, so its lines below cannot be keyed by number. The PioneerRx catalogue export has a &ldquo;Supplier Item Number&rdquo; column; a file from the wholesaler&rsquo;s own site needs one headed item number, item #, or SKU.
        </Notice>
      ))}
      {withMinimum.length === 0 && sections.length > 0 && (
        <Notice kind="warn">
          <b>No secondary has an order minimum on file.</b> Put each wholesaler&rsquo;s minimum on its terms page and this page fills each order to it.{" "}
          <Link href="/suppliers" className="underline">Suppliers</Link>.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure size="sm" value={sections.filter((x) => x.shortCount > 0).length} label="Secondaries with lines to order" sub={`${withMinimum.length} of ${sections.length} with a minimum on file`} tone="muted" />
        <Figure size="sm" value={money(sections.reduce((n, x) => n + x.needCents, 0))} label="Short and cheapest at a secondary" sub={`${sections.reduce((n, x) => n + x.shortCount, 0)} lines, before anything is added`} tone="muted" />
        <Figure size="sm" value={money(sections.reduce((n, x) => n + x.needSavingCents, 0))} label="Saved against the primary" sub="after every rebate, on those lines" tone={sections.some((x) => x.needSavingCents > 0) ? "ok" : "muted"} />
        <Figure
          size="sm"
          value={active.length === 0 ? "—" : toAddAll === 0 ? "met" : money(toAddAll)}
          label="To add to reach the minimums"
          sub={
            active.length === 0
              ? "no order at a secondary today"
              : toAddAll === 0
                ? `${meeting.length} order${meeting.length === 1 ? "" : "s"} at or over the minimum`
                : `${reachable.length} reachable from the list${reachable.length === 1 ? "" : "s"} below${shortOnes.length ? ` · ${shortOnes.length} not: ${shortOnes.map((x) => x.sup.supplier).join(", ")}` : ""}`
          }
          tone={active.length === 0 ? "muted" : shortOnes.length ? "warn" : "ok"}
        />
      </div>

      {nextTier && nextTier.worthCents > 0 && nextTier.breakEvenPremiumPercent !== null && (
        <Notice kind={nextTier.daysLeft <= 7 ? "warn" : undefined}>
          <b>Before moving generics away from {nextTier.supplier}:</b> the {nextTier.nextRatePercent}% band there is worth {money(nextTier.worthCents)} more this month{nextTier.daysLeft > 0 ? `, with ${nextTier.daysLeft} day${nextTier.daysLeft === 1 ? "" : "s"} to earn it` : ""}. {nextTier.says} A line below that saves less than {nextTier.breakEvenPremiumPercent.toFixed(2)}% is cheaper bought at {nextTier.supplier} this month.
        </Notice>
      )}

      {sections.length === 0 ? (
        <Card className="mt-4" title="No secondary wholesaler on the register">
          <p className="text-sm text-ink-2">Add the secondaries under <Link href="/suppliers" className="text-accent underline">Suppliers</Link>, load their price files below, and each gets an order here.</p>
        </Card>
      ) : (
        sections.map(({ sup, basket, fill, rows, shown, shortCount, nextCount, needCents, needSavingCents, minimumCents, crossAt, toAddCents, allAddCents, state }) => {
          const shortSays = shortCount ? `The ${shortCount} line${shortCount === 1 ? "" : "s"} the shelf is short of come${shortCount === 1 ? "s" : ""} to ${money(needCents)}` : "Nothing is short here today";
          const subtitle =
            state === "no_minimum"
              ? "No order minimum on file for this wholesaler. Put it on the terms page and this card ranks to it."
              : state === "nothing"
                ? `Minimum ${money(minimumCents!)}. Nothing the shelf is short of is cheapest here today, and nothing qualifies to add.`
                : state === "meets"
                  ? `Minimum ${money(minimumCents!)}. ${shortSays}, which meets it${needCents > minimumCents! ? `, ${money(needCents - minimumCents!)} over` : ""}.`
                  : state === "reachable"
                    ? `Minimum ${money(minimumCents!)}. ${shortSays}; the ranked list reaches it at line ${crossAt + 1}.`
                    : state === "deeper"
                      ? `Minimum ${money(minimumCents!)}. ${shortSays}; ${money(toAddCents)} more is needed. One pack of each line below does not get there; taking more packs where the "up to" figure allows adds up to ${money(allAddCents)}, which does.`
                      : `Minimum ${money(minimumCents!)}. ${shortSays}; ${money(toAddCents)} more is needed, and everything that qualifies here adds only ${money(allAddCents)} even at every pack the shelf will use. Buy the short lines at the primary today, or wait for more need.`;
          return (
            <Card
              key={sup.supplier}
              className="mt-4"
              tone={state === "meets" || state === "reachable" || state === "deeper" ? "ok" : state === "short" ? "warn" : undefined}
              title={sup.supplier}
              count={shortCount ? `${shortCount} short · ${money(needCents)}` : "nothing short today"}
              subtitle={subtitle}
              actions={<Link href={sup.supplierId ? `/suppliers/${sup.supplierId}/terms` : "/suppliers"} className="btn btn-sm">Terms</Link>}
            >
              {rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table text-sm">
                    <thead>
                      <tr>
                        <th>Item #</th>
                        <th>Product</th>
                        <th className="num">Order</th>
                        <th className="num">Line</th>
                        <th className="num">Saves</th>
                        <th className="num">Days on hand</th>
                        <th className="num">A day</th>
                        <th className="num">Days after</th>
                        <th className="num">Running total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r, i) => (
                        <React.Fragment key={`${r.kind}-${r.ndc11}`}>
                          {i === 0 && r.kind === "short" && (
                            <tr>
                              <td colSpan={9} className="bg-ground/60 text-xs font-semibold uppercase tracking-wide text-ink-2">Short now — the shelf needs these, and this is the cheapest place after every rebate</td>
                            </tr>
                          )}
                          {i === shortCount && r.kind === "next" && (
                            <tr>
                              <td colSpan={9} className="bg-ground/60 text-xs font-semibold uppercase tracking-wide text-ink-2">
                                Next best to add — ranked by how soon it runs out and how much cheaper it is here; only generics this wholesaler is the cheapest place to buy, that a pack of fits inside {minimums.horizonDays} days of use, one pack each
                              </td>
                            </tr>
                          )}
                          <tr className={crossAt >= 0 && i > crossAt ? "text-ink-3" : ""}>
                            <td className="font-mono text-xs">{r.itemNumber ?? <span className="text-ink-3" title="The price file carried no item number for this line">—</span>}</td>
                            <td>
                              <span className="block">{r.name ?? r.ndc11}</span>
                              <span className="block font-mono text-[11px] text-ink-3">
                                {r.ndc11} · {perUnit(r.unitMicros)}{r.alternative ? ` here, ${perUnit(r.alternative.unitMicros)} at ${r.alternative.supplier}` : ""}
                              </span>
                            </td>
                            <td className="num whitespace-nowrap">
                              {r.packs} × {r.packQty.toLocaleString()} <span className="text-xs text-ink-3">= {r.units.toLocaleString()}</span>
                              {r.maxPacks !== null && r.maxPacks > 1 && <span className="block text-[11px] text-ink-3" title={`Whole packs that fit inside ${minimums.horizonDays} days of use after what is on hand and on order`}>up to {r.maxPacks} packs</span>}
                              {/* Why this quantity, not why the drug is listed: the pack decides it, and the pack is what a person needs to see. */}
                              {r.why && <span className="block max-w-[16rem] whitespace-normal text-left text-[11px] text-ink-3">{r.why}</span>}
                              {r.overCap && (
                                <span className="block max-w-[16rem] whitespace-normal text-left text-[11px] text-warn">
                                  {Math.round(r.overCap.days)} days of stock, past the {r.overCap.cap}-day shelf.
                                  {r.overCap.smallerPack
                                    ? ` ${r.overCap.smallerPack.supplier} ships packs of ${r.overCap.smallerPack.packQty} — ${Math.round(r.overCap.smallerPack.days)} days for ${money(r.overCap.smallerPack.costCents)}.`
                                    : " No supplier ships it smaller."}
                                </span>
                              )}
                            </td>
                            <td className="num font-medium">{money(r.costCents)}</td>
                            <td className={`num ${r.savingCents > 0 ? "text-accent" : "text-ink-3"}`}>{r.savingCents > 0 ? money(r.savingCents) : "—"}</td>
                            <td className="num">{days(r.daysOnHand)}</td>
                            <td className="num text-xs">{r.perDayThousandths > 0 ? (r.perDayThousandths / 1000).toFixed(1) : "—"}</td>
                            <td className="num">{days(r.daysAfter)}</td>
                            <td className={`num whitespace-nowrap ${r.reaches ? "font-semibold text-accent" : ""}`}>
                              {money(r.runningCents)}
                              {r.reaches && <span className="badge badge-ok ml-2">minimum</span>}
                            </td>
                          </tr>
                        </React.Fragment>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-semibold">
                        <td colSpan={3}>{minimumCents !== null ? `Short lines against a ${money(minimumCents)} minimum` : "Short lines"}</td>
                        <td className="num">{money(needCents)}</td>
                        <td className="num text-accent">{needSavingCents > 0 ? money(needSavingCents) : "—"}</td>
                        <td colSpan={4} className="text-xs font-normal text-ink-3">
                          {minimumCents !== null && needCents < minimumCents ? `${money(minimumCents - needCents)} short before anything is added` : minimumCents !== null ? "met on the short lines alone" : ""}
                          {basket?.freightCents ? ` · plus ${money(basket.freightCents)} freight` : ""}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              {rows.length > shown.length && (
                <p className="mt-1 text-xs text-ink-3">{rows.length - shown.length} more qualify below these, further from needing a reorder.</p>
              )}
              {nextCount === 0 && shortCount > 0 && minimumCents !== null && needCents < minimumCents && (
                <p className="mt-2 text-xs text-ink-3">Nothing else qualifies to add here: no generic this wholesaler is cheapest on moves steadily enough to buy {minimums.horizonDays} days of.</p>
              )}

              {basket && basket.bandDeltaCents !== null && basket.bandDeltaCents !== 0 && (
                <p className="mt-3 text-xs">
                  <b className={basket.bandDeltaCents < 0 ? "text-crit" : "text-accent"}>{basket.bandDeltaCents < 0 ? "−" : "+"}{money(Math.abs(basket.bandDeltaCents))}</b> through {primary?.supplier ?? "the primary"}&rsquo;s rebate band if these generics leave it, against {money(basket.savingCents)} saved on the invoice.
                  {basket.verdict === "move_to_primary" ? " Buying them at the primary is the cheaper month." : ""}
                </p>
              )}
              {((basket?.refusals.length ?? 0) > 0 || (fill?.refused.length ?? 0) > 0) && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-ink-3">
                    {(basket?.refusals.length ?? 0) + (fill?.refused.length ?? 0)} considered and not listed
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
                    {[...(basket?.refusals ?? []), ...(fill?.refused ?? [])].slice(0, 30).map((r, i) => (
                      <li key={`${r.ndc11}-${i}`}><b className="text-ink-2">{r.name ?? r.ndc11}</b> — {r.why}</li>
                    ))}
                  </ul>
                </details>
              )}
              {fill && state !== "no_minimum" && (
                <p className="mt-2 text-xs text-ink-3">
                  Never listed: {fill.leftOut.notGeneric} brands, {fill.leftOut.controlled} controlled, {fill.leftOut.unknownClass} with no brand/generic flag on the NADAC file.
                </p>
              )}
            </Card>
          );
        })
      )}

      {primary && (
        <Card className="mt-4" title={`${primary.supplier} — the rest, as usual`} subtitle="Everything the shelf needs that no secondary beats after rebates. Not listed here on purpose; the shelf page has every line.">
          <p className="text-sm text-ink-2">
            {primaryBasket && primaryBasket.lines.length > 0
              ? `${primaryBasket.lines.length} line${primaryBasket.lines.length === 1 ? "" : "s"}, ${money(primaryBasket.subtotalCents)} today.`
              : `Nothing the shelf is short of today is cheapest at ${primary.supplier}.`}{" "}
            <Link href="/purchasing/shelf" className="text-accent underline">The shelf</Link>
            {buyList.plan.unfilled.length > 0 && ` · ${buyList.plan.unfilled.length} needed item${buyList.plan.unfilled.length === 1 ? " has" : "s have"} no supplier price with a known pack size, so nothing can be ordered for ${buyList.plan.unfilled.length === 1 ? "it" : "them"}.`}
          </p>
        </Card>
      )}

      <p className="mt-4 text-xs text-ink-3">
        {minimums.evidence.days > 0
          ? `Rates come from ${minimums.evidence.days} day${minimums.evidence.days === 1 ? "" : "s"} of claims (${minimums.evidence.from} to ${minimums.evidence.to}), so a suggested buy goes at most ${minimums.horizonDays} days deep${minimums.evidence.days < minimums.evidence.fullAt ? `; the window grows with every evening's report until it holds ${minimums.evidence.fullAt} days, and the buys deepen to 60 days with it` : ""}. `
          : "No claims are held yet, so there are no rates to buy against. "}
        A line is here only when this supplier&rsquo;s price after its rebate is the lowest of everyone who prices it. A line to order is sized to {SHELF_POLICY.targetDays} days plus the lead time, less what is on hand and on order. A line to add is a generic by CMS&rsquo;s flag, not controlled, dispensed at a steady rate rather than in one large fill, and shown a pack at a time up to what {minimums.horizonDays} days of use will take. The item number is the supplier&rsquo;s own, off their price file; a dash means the file carried none, and the next Monday catalogue fills it in.
      </p>

      <details className="mt-6">
        <summary className="cursor-pointer text-sm font-semibold">Price files: what each order is priced from</summary>
      <Card title="Load a supplier price file" className="my-4">        <p className="mt-1 text-xs text-ink-3">
          An order guide or price list from any wholesaler, as .xlsx or .csv. Column names differ between suppliers
          and are matched loosely — anything not recognised is reported back rather than ignored. Loading a file again
          replaces that supplier&rsquo;s prices for the NDCs it covers and leaves every other supplier alone.
        </p>
        <form action={upload} className="flex flex-wrap items-end gap-3">
          <Field label="Supplier" hint="Leave blank for a PioneerRx export, which names its own.">
            <input name="supplier" placeholder="McKesson" className="w-48" />
          </Field>
          <Field label="The file">
            <input type="file" name="file" accept=".xlsx,.csv,.txt" className="text-sm" />
          </Field>
          <button className="btn btn-primary">Load</button>
        </form>

        {summary.counts.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-3">
            {summary.counts.map((c) => (
              <li key={c.supplier}>
                <b className="text-ink-2">{c.supplier}</b> — {Number(c.items).toLocaleString()} items,{" "}
                {Number(c.keyed).toLocaleString()} matchable by description
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/*
        The Sunday files, and whether the door is open for them.

        Four scheduled PioneerRx exports, one per supplier, named Supplier + run date, emailed to
        the site's mailbox. Everything that has to be true for them to load on their own is listed
        here with its state, and each supplier has a row saying when its file last came — so on the
        Monday after the first Sunday, "did it work" is answered by one glance at this panel, and
        "what went wrong" by the Inbox line it points to.
      */}
      <Card title="Scheduled catalogues" className="my-4">        <p className="mt-1 text-xs text-ink-3">
          PioneerRx emails one file per supplier, named <span className="font-mono">Supplier</span> + run date
          &mdash; {FILE_NAME_CODES.map((c) => <span key={c} className="font-mono">{c}9_6_2026</span>).reduce<React.ReactNode[]>((acc, x, i) => (i ? [...acc, ", ", x] : [x]), [])}.
          The site reads the supplier from inside the file and checks it against the name; a file named for one supplier
          that carries another is refused, and the <Link href="/inbox" className="text-accent underline">Inbox</Link> line
          says so.
        </p>
        <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-3">
          <li className="flex items-center gap-2">
            <span className={`badge ${mailReady ? "badge-ok" : "badge-crit"}`}>{mailReady ? "ready" : "not set up"}</span>
            Mailbox connected {!mailReady && <Link href="/settings/email" className="text-accent underline">(set up)</Link>}
          </li>
          <li className="flex items-center gap-2">
            <span className={`badge ${mailOn ? "badge-ok" : "badge-crit"}`}>{mailOn ? "on" : "off"}</span>
            Checked automatically {!mailOn && <Link href="/settings/email" className="text-accent underline">(turn on)</Link>}
          </li>
          <li className="flex items-center gap-2">
            <span className={`badge ${autoImport ? "badge-ok" : "badge-crit"}`}>{autoImport ? "on" : "off"}</span>
            Loaded on arrival {!autoImport && <Link href="/settings/email" className="text-accent underline">(turn on)</Link>}
          </li>
        </ul>
        {s.mail_allowed_senders?.trim() && (
          <p className="mt-2 text-xs text-ink-3">
            Only listed senders are read. The address PioneerRx sends from must be on the list under Settings → Email, or
            the message is left unread and the Inbox says &ldquo;sender is not on the allowed list&rdquo;.
          </p>
        )}
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Supplier</th><th>Last file</th><th>Received</th><th className="text-right">Items read</th><th>Prices as of</th></tr>
            </thead>
            <tbody>
              {schedule.map((row) => {
                const age = row.lastAt ? (Date.now() - Date.parse(row.lastAt)) / 86_400_000 : null;
                const tone = age === null ? "badge-muted" : age > 9 ? "badge-warn" : "badge-ok";
                return (
                  <tr key={row.supplier}>
                    <td className="font-medium">{row.supplier}</td>
                    <td className="font-mono text-xs">{row.fileName ?? <span className="text-ink-3">never arrived</span>}</td>
                    <td className="whitespace-nowrap text-xs">
                      {row.lastAt ? <><span className={`badge ${tone}`}>{age! < 1 ? "today" : `${Math.floor(age!)}d ago`}</span> {row.lastAt.slice(0, 10)}</> : <span className="badge badge-muted">waiting</span>}
                    </td>
                    <td className="text-right tabular-nums">{row.rowsRead === null ? "—" : row.rowsRead.toLocaleString()}</td>
                    <td className="text-xs">{row.pricedOn ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      </details>

      <h2 className="mb-3 mt-8">Elsewhere in Ordering</h2>
      <Hub href="/purchasing" />
    </>
  );
}
