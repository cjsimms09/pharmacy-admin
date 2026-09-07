import { familyTabs } from "@/lib/families";
import type React from "react";
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
  itemNumber: string | null;
  ndc11: string;
  name: string | null;
  packs: number;
  packQty: number;
  units: number;
  unitMicros: number;
  costCents: number;
  savingCents: number;
  daysAfter: number;
};

/** The query key holding what is in the cart at one wholesaler, so a recount keeps the others. */
const cartKey = (supplier: string) => `cart-${supplier.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const parseDollars = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const days = (d: number) => (Number.isFinite(d) ? String(Math.round(d)) : "—");

export default async function WhatToBuyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireReimbursement();
  await requireUser();
  const params = await searchParams;
  const { ok, error } = params;
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
   * One card per secondary, in two parts. First what the shelf is short of and this wholesaler
   * is cheapest on — that goes in the cart whatever happens. Then the ranked list to add from to
   * reach their minimum, with a running total. The total starts from what the cart actually holds
   * where the pharmacist has typed it, and from the first part where they have not, because the
   * site has no way of seeing the cart at the wholesaler's website and pretending otherwise was
   * the fault the old minimums page had.
   */
  const sections = buyList.suppliers
    .filter((x) => !x.primary)
    .map((sup) => {
      const basket = buyList.plan.baskets.find((b) => b.supplier === sup.supplier) ?? null;
      const fill = minimums.fills.find((f) => f.supplier === sup.supplier) ?? null;
      const needs: Row[] = (basket?.lines ?? [])
        .filter((l) => l.reason === "need")
        .map((l) => ({
          itemNumber: l.itemNumber ?? null,
          ndc11: l.ndc11,
          name: l.name,
          packs: l.packs,
          packQty: l.packQty,
          units: Math.round(l.unitsThousandths / 1000),
          unitMicros: l.effectiveUnitMicros,
          costCents: l.costCents,
          savingCents: l.savingCents,
          daysAfter: l.daysOfStockAfter,
        }));
      const needCents = needs.reduce((n, r) => n + r.costCents, 0);
      const needSavingCents = needs.reduce((n, r) => n + r.savingCents, 0);
      const minimumCents = sup.minimumCents ?? null;
      const typed = parseDollars(params[cartKey(sup.supplier)]);
      const cartCents = typed ?? needCents;
      const candidates = fill?.candidates ?? [];
      let run = cartCents;
      const list = candidates.map((c) => {
        const before = run;
        run += c.packCostCents;
        return { ...c, runningCents: run, reaches: minimumCents !== null && before < minimumCents && run >= minimumCents };
      });
      const crossAt = list.findIndex((c) => c.reaches);
      const shown = crossAt >= 0 ? list.slice(0, Math.min(list.length, crossAt + 7)) : list.slice(0, 25);
      const toAddCents = minimumCents === null ? 0 : Math.max(0, minimumCents - cartCents);
      // One pack of each, and then every pack the shelf will use inside the horizon.
      const onePackCents = candidates.reduce((n, c) => n + c.packCostCents, 0);
      const allAddCents = candidates.reduce((n, c) => n + c.packCostCents * c.maxPacks, 0);
      const state: "nothing" | "no_minimum" | "meets" | "reachable" | "deeper" | "short" =
        minimumCents === null
          ? "no_minimum"
          : needs.length === 0 && candidates.length === 0
            ? "nothing"
            : cartCents >= minimumCents
              ? "meets"
              : crossAt >= 0
                ? "reachable"
                : cartCents + allAddCents >= minimumCents
                  ? "deeper"
                  : "short";
      return { sup, basket, fill, needs, needCents, needSavingCents, minimumCents, typed, cartCents, list, shown, crossAt, toAddCents, onePackCents, allAddCents, state };
    })
    .sort((a, b) => Number(b.needs.length > 0) - Number(a.needs.length > 0) || b.needCents - a.needCents || (b.minimumCents ?? 0) - (a.minimumCents ?? 0));
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
      {withMinimum.length === 0 && sections.length > 0 && (
        <Notice kind="warn">
          <b>No secondary has an order minimum on file.</b> Put each wholesaler&rsquo;s minimum on its terms page and this page fills each order to it.{" "}
          <Link href="/suppliers" className="underline">Suppliers</Link>.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure size="sm" value={sections.filter((x) => x.needs.length > 0).length} label="Secondaries with lines to order" sub={`${withMinimum.length} of ${sections.length} with a minimum on file`} tone="muted" />
        <Figure size="sm" value={money(sections.reduce((n, x) => n + x.needCents, 0))} label="Short and cheapest at a secondary" sub={`${sections.reduce((n, x) => n + x.needs.length, 0)} lines, before anything is added`} tone="muted" />
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
        sections.map(({ sup, basket, fill, needs, needCents, needSavingCents, minimumCents, typed, cartCents, list, shown, crossAt, toAddCents, onePackCents, allAddCents, state }) => {
          const cartSays = typed !== null ? `The cart is at ${money(cartCents)}` : needs.length ? `The ${needs.length} line${needs.length === 1 ? "" : "s"} to order come${needs.length === 1 ? "s" : ""} to ${money(needCents)}` : "Nothing is short here today";
          const subtitle =
            state === "no_minimum"
              ? "No order minimum on file for this wholesaler. Put it on the terms page and this card fills to it."
              : state === "nothing"
                ? `Minimum ${money(minimumCents!)}. Nothing the shelf is short of is cheapest here today, and nothing qualifies to add.`
                : state === "meets"
                  ? `Minimum ${money(minimumCents!)}. ${cartSays}, which meets it${cartCents > minimumCents! ? `, ${money(cartCents - minimumCents!)} over` : ""}.`
                  : state === "reachable"
                    ? `Minimum ${money(minimumCents!)}. ${cartSays}; ${money(toAddCents)} more reaches it, and the first ${crossAt + 1} below do that.`
                    : state === "deeper"
                      ? `Minimum ${money(minimumCents!)}. ${cartSays}; ${money(toAddCents)} more is needed. One pack of each below adds ${money(onePackCents)}, and taking more packs where the "up to" column allows adds up to ${money(allAddCents)}, which reaches it.`
                      : `Minimum ${money(minimumCents!)}. ${cartSays}; ${money(toAddCents)} more is needed, and everything that qualifies here adds only ${money(allAddCents)} even at every pack the shelf will use. Buy the lines at the primary today, or wait for more need.`;
          const others = sections.filter((o) => o.sup.supplier !== sup.supplier && o.typed !== null);
          return (
            <Card
              key={sup.supplier}
              className="mt-4"
              tone={state === "meets" || state === "reachable" || state === "deeper" ? "ok" : state === "short" ? "warn" : undefined}
              title={sup.supplier}
              count={needs.length ? `${needs.length} line${needs.length === 1 ? "" : "s"} to order · ${money(needCents)}` : "nothing short today"}
              subtitle={subtitle}
              actions={<Link href={sup.supplierId ? `/suppliers/${sup.supplierId}/terms` : "/suppliers"} className="btn btn-sm">Terms</Link>}
            >
              {needs.length > 0 && (
                <>
                  <h3 className="text-sm font-semibold">Order these</h3>
                  <p className="mb-2 text-xs text-ink-3">The shelf is short of each, and after every rebate this is the cheapest place to buy it.</p>
                  <div className="overflow-x-auto">
                    <table className="table text-sm">
                      <thead>
                        <tr>
                          <th>Item #</th>
                          <th>Product</th>
                          <th className="num">Order</th>
                          <th className="num">Unit</th>
                          <th className="num">Line</th>
                          <th className="num">Saves</th>
                          <th className="num">Days of stock after</th>
                        </tr>
                      </thead>
                      <tbody>
                        {needs.map((r) => (
                          <tr key={r.ndc11}>
                            <td className="font-mono text-xs">{r.itemNumber ?? <span className="text-ink-3" title="The price file carried no item number for this line">—</span>}</td>
                            <td>
                              <span className="block">{r.name ?? r.ndc11}</span>
                              <span className="block font-mono text-[11px] text-ink-3">{r.ndc11}</span>
                            </td>
                            <td className="num whitespace-nowrap">{r.packs} × {r.packQty} <span className="text-xs text-ink-3">= {r.units.toLocaleString()}</span></td>
                            <td className="num text-xs">{perUnit(r.unitMicros)}</td>
                            <td className="num font-medium">{money(r.costCents)}</td>
                            <td className={`num ${r.savingCents > 0 ? "text-accent" : "text-ink-3"}`}>{r.savingCents > 0 ? money(r.savingCents) : "—"}</td>
                            <td className="num">{days(r.daysAfter)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="font-semibold">
                          <td colSpan={4}>{minimumCents !== null ? `Against a ${money(minimumCents)} minimum` : "Total"}</td>
                          <td className="num">{money(needCents)}</td>
                          <td className="num text-accent">{needSavingCents > 0 ? money(needSavingCents) : "—"}</td>
                          <td className="num text-xs font-normal text-ink-3">{minimumCents !== null && needCents < minimumCents ? `${money(minimumCents - needCents)} short` : minimumCents !== null ? "met" : ""}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}

              {minimumCents !== null && list.length > 0 && (
                <div className={needs.length ? "mt-5" : ""}>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Next best to add, soonest needed first</h3>
                      <p className="text-xs text-ink-3">
                        Generics this wholesaler is the cheapest place to buy, that the shelf will run through inside {minimums.horizonDays} days, one pack each. The running total starts from {typed !== null ? "what you typed as the cart" : "the lines above"}.
                      </p>
                    </div>
                    <form method="get" className="flex items-end gap-2">
                      {others.map((o) => <input key={o.sup.supplier} type="hidden" name={cartKey(o.sup.supplier)} value={(o.cartCents / 100).toFixed(2)} />)}
                      <Field label="In the cart now" hint={typed === null ? "Defaults to the lines above" : "As typed"}>
                        <input name={cartKey(sup.supplier)} inputMode="decimal" defaultValue={(cartCents / 100).toFixed(2)} className="w-28" />
                      </Field>
                      <button className="btn btn-sm">Recount</button>
                    </form>
                  </div>
                  <div className="mt-2 overflow-x-auto">
                    <table className="table text-sm">
                      <thead>
                        <tr>
                          <th>Item #</th>
                          <th>Product</th>
                          <th className="num">Pack</th>
                          <th className="num">Pack cost</th>
                          <th className="num">Saves a pack</th>
                          <th className="num">Days on hand</th>
                          <th className="num">A day</th>
                          <th className="num">Up to</th>
                          <th className="num">Running total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((c, i) => (
                          <tr key={c.ndc11} className={crossAt >= 0 && i > crossAt ? "text-ink-3" : ""}>
                            <td className="font-mono text-xs">{c.itemNumber ?? <span className="text-ink-3" title="The price file carried no item number for this line">—</span>}</td>
                            <td>
                              <span className="block">{c.name ?? c.ndc11}</span>
                              <span className="block font-mono text-[11px] text-ink-3">{c.ndc11}{c.alternative ? ` · ${perUnit(c.unitMicros)} here, ${perUnit(c.alternative.unitMicros)} at ${c.alternative.supplier}` : ""}</span>
                            </td>
                            <td className="num">{c.packQty.toLocaleString()}</td>
                            <td className="num font-medium">{money(c.packCostCents)}</td>
                            <td className={`num ${c.savingPerPackCents > 0 ? "text-accent" : "text-ink-3"}`}>{c.savingPerPackCents > 0 ? money(c.savingPerPackCents) : "—"}</td>
                            <td className="num">{days(c.daysOnHand)}</td>
                            <td className="num text-xs">{(c.perDayThousandths / 1000).toFixed(1)}</td>
                            <td className="num text-xs" title={`Whole packs that fit inside ${minimums.horizonDays} days of use after what is on hand and on order`}>{c.maxPacks} pack{c.maxPacks === 1 ? "" : "s"}</td>
                            <td className={`num whitespace-nowrap ${c.reaches ? "font-semibold text-accent" : ""}`}>
                              {money(c.runningCents)}
                              {c.reaches && <span className="badge badge-ok ml-2">minimum</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {list.length > shown.length && (
                    <p className="mt-1 text-xs text-ink-3">{list.length - shown.length} more qualify below these, further from needing a reorder.</p>
                  )}
                </div>
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
