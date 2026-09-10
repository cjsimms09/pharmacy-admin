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
import { PageHeader, Notice, Field, Card } from "@/components/ui";
import { minimumsNow } from "@/lib/minimum-store";
import { drugProfitNow } from "@/lib/drug-profit-store";
import { overNadacNow } from "@/lib/over-nadac-store";

export const metadata = { title: "Add to a secondary" };
export const dynamic = "force-dynamic";

const money = (cents: number) => formatCents(cents);
const perUnit = (micros: number | null) => (micros === null ? "—" : `$${(Math.abs(micros) / 1_000_000).toFixed(4)}`);

/**
 * What to add to a secondary's order to reach its minimum, and what the primary's order would
 * get wrong.
 *
 * The owner's brief, the third time: "I don't use this site to build my daily order; I use
 * McKesson. What I need is to identify drugs I could add on to secondary supplier orders if I'm
 * trying to hit their minimums and my current order from them is not enough, and alerts to
 * things my current order wouldn't do — this drug is more expensive but reimburses more."
 *
 * So the page is two things. First, one card per secondary: the owner types what is already in
 * that wholesaler's cart, the card says how much more the minimum needs, and lists the best things
 * to add — what the shelf is short of and this supplier is cheapest on, then every generic this
 * supplier is the cheapest place for, soonest to run out first, one pack at a time — with a
 * running total from the typed amount, so the line at which the minimum is reached is visible.
 * Second, above the cards, the alerts: the handful of things the primary's order would do wrong
 * today, each one sentence with a number and where it came from. Nothing here is the order; the
 * order is built at the wholesaler.
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
  /** The NDC the pharmacy dispenses that this offer would replace, where it is an equivalent. */
  insteadOfNdc11?: string | null;
};

/** A supplier's name as an anchor. */
const slug = (supplier: string) => supplier.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const days = (d: number) => (Number.isFinite(d) ? String(Math.round(d)) : "—");

export default async function WhatToBuyPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const { buyListNow, SHELF_POLICY, nextTierNow } = await import("@/lib/shelf");
  const [buyList, minimums, nextTier, summary, schedule, s, mailReady, profit, over] = await Promise.all([
    buyListNow(),
    minimumsNow(),
    nextTierNow(),
    supplierSummary(),
    catalogSchedule(),
    getSettings(),
    hasMailPassword(),
    drugProfitNow(),
    overNadacNow(28),
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
  const primaryName = primary?.supplier ?? "the primary";

  /*
   * One card per secondary: everything worth adding to its order today, ranked. First what the
   * shelf is short of and this wholesaler is cheapest on, sized to the need; then every generic
   * that qualifies to add, soonest needed first, one pack each. The running total starts from
   * what the owner typed as already in the cart — the site cannot see the wholesaler's cart, so it
   * asks — and the line at which the minimum is reached is marked.
   */
  const sections = buyList.suppliers
    .filter((x) => !x.primary)
    .map((sup) => {
      const basket = buyList.plan.baskets.find((b) => b.supplier === sup.supplier) ?? null;
      const fill = minimums.fills.find((f) => f.supplier === sup.supplier) ?? null;
      const minimumCents = sup.minimumCents ?? null;
      const rows: Row[] = [];
      for (const l of (basket?.lines ?? []).filter((l) => l.reason === "need")) {
        const shelf = minimums.shelf.get(l.ndc11);
        rows.push({
          kind: "short", itemNumber: l.itemNumber ?? null, ndc11: l.ndc11, name: l.name, packs: l.packs, packQty: l.packQty,
          units: Math.round(l.unitsThousandths / 1000), unitMicros: l.effectiveUnitMicros, costCents: l.costCents, savingCents: l.savingCents,
          daysOnHand: shelf && shelf.perDayThousandths > 0 ? shelf.onHandThousandths / shelf.perDayThousandths : Infinity,
          perDayThousandths: shelf?.perDayThousandths ?? 0, daysAfter: l.daysOfStockAfter, maxPacks: null, why: l.why, overCap: l.overCap, alternative: null,
        });
      }
      const shortCount = rows.length;
      const needCents = rows.reduce((n, r) => n + r.costCents, 0);
      const needSavingCents = rows.reduce((n, r) => n + r.savingCents, 0);
      for (const c of fill?.candidates ?? []) {
        rows.push({
          kind: "next", itemNumber: c.itemNumber, ndc11: c.ndc11, name: c.name, packs: 1, packQty: c.packQty, units: c.packQty, unitMicros: c.unitMicros,
          costCents: c.packCostCents, savingCents: c.savingPerPackCents, daysOnHand: c.daysOnHand, perDayThousandths: c.perDayThousandths,
          daysAfter: c.daysAfterOnePack, maxPacks: c.maxPacks, why: null, overCap: null, alternative: c.alternative, insteadOfNdc11: c.insteadOfNdc11 ?? null,
        });
      }
      // Every short line, then the add-ons; enough of them to reach the minimum from nothing, and a few past.
      let run = 0;
      let crossAt = -1;
      rows.forEach((r, i) => {
        run += r.costCents;
        if (crossAt < 0 && minimumCents !== null && run >= minimumCents) crossAt = i;
      });
      const shown = crossAt >= 0 ? rows.slice(0, Math.max(shortCount, crossAt + 6)) : rows.slice(0, shortCount + 20);
      const allAddCents = (fill?.candidates ?? []).reduce((n, c) => n + c.packCostCents * c.maxPacks, 0);
      return { sup, basket, fill, rows, shown, shortCount, needCents, needSavingCents, minimumCents, allAddCents, listCents: run };
    })
    .sort((a, b) => Number(b.shortCount > 0) - Number(a.shortCount > 0) || b.needCents - a.needCents || (b.minimumCents ?? 0) - (a.minimumCents ?? 0));
  const withMinimum = sections.filter((x) => x.minimumCents !== null);
  const missing = [...new Set([...buyList.missing, ...minimums.missing])];

  /*
   * What the primary's order would get wrong today. Each alert is one sentence with a number and
   * the page it came from, ranked by dollars a month. Three kinds, and only three, because each is
   * something the site can prove: a different NDC of the same drug earns more on how this pharmacy
   * is paid (Which NDC pays); the shelf needs something a secondary is materially cheaper on
   * (the cards below); the primary has been charging over NADAC on something a secondary lists
   * under it (Bought over NADAC).
   */
  type Alert = { key: string; monthCents: number; text: React.ReactNode; href: string; from: string; confidence?: "settled" | "read" };
  const alerts: Alert[] = [];
  for (const r of profit.rows) {
    if ((r.gainPerMonthCents ?? 0) < 500 || !r.best || !r.current) continue;
    const sameNdc = r.best.ndc11 === r.current.ndc11;
    alerts.push({
      key: `ndc-${r.group}`,
      monthCents: r.gainPerMonthCents ?? 0,
      href: "/purchasing/products#bymodel",
      from: "Which NDC pays",
      confidence: r.confidence,
      text: sameNdc ? (
        <>
          <b>{r.name ?? r.best.ndc11}</b>: the same NDC is {perUnit(r.best.unitMicros)} a unit at {r.best.supplier}{r.best.itemNumber ? ` (#${r.best.itemNumber})` : ""}, {money(r.gainPerFillCents ?? 0)} more a fill than what it is bought for today.
        </>
      ) : (
        <>
          <b>{r.name ?? r.best.ndc11}</b>: buy <span className="font-mono">{r.best.ndc11}</span> from {r.best.supplier}{r.best.itemNumber ? ` (#${r.best.itemNumber})` : ""} instead of <span className="font-mono">{r.current.ndc11}</span>. It {r.best.costCents > (r.candidates.find((c) => c.ndc11 === r.current!.ndc11)?.costCents ?? 0) ? "costs more and" : ""} earns {money(r.gainPerFillCents ?? 0)} more a fill, because this drug is paid {r.modelSays}{r.mix.length > 1 ? ` on ${Math.round(r.modelShare * 100)}% of fills` : ""}.
        </>
      ),
    });
  }
  const primaryKey = primaryName.trim().toLowerCase();
  for (const r of over.rows) {
    if (r.supplier.trim().toLowerCase() !== primaryKey || !r.elsewhere?.underNadac) continue;
    alerts.push({
      key: `over-${r.ndc11}`,
      monthCents: Math.round((r.overCents * 30) / 28),
      href: "/purchasing/over-nadac?days=28",
      from: "Bought over NADAC",
      text: (
        <>
          <b>{r.name ?? r.ndc11}</b>: {primaryName} invoiced it at {perUnit(r.effectiveUnitMicros)} a unit, {r.overPercent.toFixed(0)}% over NADAC, in the last four weeks; {r.elsewhere.supplier} lists it under NADAC at {perUnit(r.elsewhere.effectiveUnitMicros)}{r.elsewhere.itemNumber ? ` (#${r.elsewhere.itemNumber})` : ""}.
        </>
      ),
    });
  }
  for (const x of sections) {
    if (x.shortCount === 0 || x.needSavingCents < 500) continue;
    alerts.push({
      key: `short-${x.sup.supplier}`,
      monthCents: x.needSavingCents,
      href: `#${slug(x.sup.supplier)}`,
      from: "the card below",
      text: (
        <>
          <b>{x.shortCount} line{x.shortCount === 1 ? "" : "s"} the shelf needs</b> {x.shortCount === 1 ? "is" : "are"} cheaper at {x.sup.supplier} than at {primaryName}: {money(x.needSavingCents)} saved after every rebate if they go on that order instead.
        </>
      ),
    });
  }
  alerts.sort((a, b) => b.monthCents - a.monthCents);
  const topAlerts = alerts.slice(0, 8);

  return (
    <>
      <PageHeader
        tabs={familyTabs("order", "/purchasing")}
        title="Add to a secondary"
        subtitle={`The order is built at ${primaryName}. This page ranks what to add to a secondary's order when it is not at the minimum, and says what ${primaryName}'s order would get wrong today.`}
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
          <b>No secondary has an order minimum on file.</b> Put each wholesaler&rsquo;s minimum on its terms page and each card here counts to it.{" "}
          <Link href="/suppliers" className="underline">Suppliers</Link>.
        </Notice>
      )}

      <Card
        title={`Before you send ${primaryName}'s order`}
        /*
          The worst eight of however many there are, and it said so as though it were all of them.
          `topAlerts` is `alerts.slice(0, 8)` after sorting by dollars a month, and around eighty-five
          clear the gate. "8 things it would get wrong" is a count of a whole; this is a shortlist.
        */
        count={
          alerts.length === 0
            ? undefined
            : alerts.length > topAlerts.length
              ? `the worst ${topAlerts.length} of ${alerts.length} it would get wrong`
              : `${alerts.length} thing${alerts.length === 1 ? "" : "s"} it would get wrong`
        }
        tone={topAlerts.length ? "warn" : undefined}
        className="mb-4"
      >
        {topAlerts.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing today. No drug has an NDC or source worth five dollars a month more than what is bought now, nothing the shelf needs is materially cheaper at a secondary, and {primaryName} has not been over NADAC on anything a secondary lists under it.</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {topAlerts.map((a) => (
              <li key={a.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="min-w-[5.5rem] font-semibold tabular-nums text-accent">{money(a.monthCents)} / mo</span>
                <span className="flex-1 min-w-[16rem]">{a.text}</span>
                <span className="text-xs text-ink-3">
                  {a.confidence === "read" ? <span className="badge badge-warn mr-2">read from the money</span> : null}
                  <Link href={a.href} className="underline">{a.from}</Link>
                </span>
              </li>
            ))}
          </ol>
        )}
        {nextTier && nextTier.worthCents > 0 && nextTier.breakEvenPremiumPercent !== null && (
          <p className="mt-3 text-xs text-ink-2">
            <b>Before moving generics away from {nextTier.supplier}:</b> the {nextTier.nextRatePercent}% band there is worth {money(nextTier.worthCents)} more this month{nextTier.daysLeft > 0 ? `, with ${nextTier.daysLeft} day${nextTier.daysLeft === 1 ? "" : "s"} to earn it` : ""}. A line that saves less than {nextTier.breakEvenPremiumPercent.toFixed(2)}% is cheaper bought at {nextTier.supplier} this month.
          </p>
        )}
      </Card>

      {sections.length === 0 ? (
        <Card title="No secondary wholesaler on the register">
          <p className="text-sm text-ink-2">Add the secondaries under <Link href="/suppliers" className="text-accent underline">Suppliers</Link>, load their price files below, and each gets a card here.</p>
        </Card>
      ) : (
        sections.map(({ sup, basket, fill, rows, shown, shortCount, needCents, needSavingCents, minimumCents, allAddCents, listCents }) => {
          const key = slug(sup.supplier);
          const says =
            minimumCents === null
              ? rows.length === 0
                ? `Nothing to add here today: nothing the shelf is short of is cheapest here, and nothing this wholesaler is cheapest on runs out inside ${minimums.horizonDays} days.`
                : "No minimum on file, so nothing is filled to a target. This is the next best to order here: what runs out first, then what this wholesaler is cheapest on. Days left are on each line."
              : rows.length === 0 ? `Nothing qualifies to add here today: nothing the shelf is short of is cheapest here, and no generic this wholesaler is cheapest on runs out inside ${minimums.horizonDays} days.`
                : `Add from the top until the ${sup.supplier} screen shows ${money(minimumCents)}. One pack of everything here comes to ${money(listCents)}${allAddCents > listCents - needCents ? `; ${money(needCents + allAddCents)} where a line says "up to"` : ""}.`;
          return (
            <Card
              key={sup.supplier}
              id={key}
              className="mb-4"
              tone={shortCount > 0 ? "ok" : undefined}
              title={sup.supplier}
              count={minimumCents !== null ? `minimum ${money(minimumCents)}` : "ranked by days left"}
              subtitle={says}
              actions={<Link href={sup.supplierId ? `/suppliers/${sup.supplierId}/terms` : "/suppliers"} className="btn btn-sm">Terms</Link>}
            >
              {rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table text-sm">
                    <thead>
                      <tr>
                        <th>Item #</th>
                        <th>Add</th>
                        <th className="num">Pack</th>
                        <th className="num">Price</th>
                        <th className="num">vs {primaryName}</th>
                        <th className="num">Days left</th>
                        <th className="num">After one pack</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={`${r.kind}-${r.ndc11}`}>
                          <td className="font-mono text-xs">{r.itemNumber ?? <span className="text-ink-3" title="The price file carried no item number for this line">—</span>}</td>
                          <td>
                            <span className="block">
                              {r.name ?? r.ndc11}
                              {r.kind === "short" && <span className="badge badge-warn ml-2" title={r.why ?? "The shelf is short of this and this is the cheapest place after every rebate"}>short</span>}
                              {r.overCap && <span className="badge badge-muted ml-1" title={`${Math.round(r.overCap.days)} days of stock, past the ${r.overCap.cap}-day shelf.${r.overCap.smallerPack ? ` ${r.overCap.smallerPack.supplier} ships packs of ${r.overCap.smallerPack.packQty}.` : " No supplier ships it smaller."}`}>big pack</span>}
                            </span>
                            <span className="block font-mono text-[11px] text-ink-3">{r.ndc11} · {perUnit(r.unitMicros)} a unit{r.alternative ? `, ${perUnit(r.alternative.unitMicros)} at ${r.alternative.supplier}` : ""}</span>
                            {r.insteadOfNdc11 && <span className="block text-[11px] text-ink-3">an AB-rated equivalent of the {r.insteadOfNdc11} you dispense — the plan pays the same on either where it pays by MAC or NADAC</span>}
                          </td>
                          <td className="num whitespace-nowrap">
                            {r.packs} × {r.packQty.toLocaleString()}
                            {r.maxPacks !== null && r.maxPacks > 1 && <span className="block text-[11px] text-ink-3" title={`Whole packs that fit inside ${minimums.horizonDays} days of use after what is on hand and on order`}>up to {r.maxPacks}</span>}
                          </td>
                          <td className="num font-medium">{money(r.costCents)}</td>
                          <td className={`num ${r.savingCents > 0 ? "text-accent" : "text-ink-3"}`}>{r.savingCents > 0 ? `−${money(r.savingCents)}` : "—"}</td>
                          <td className="num" title={r.perDayThousandths > 0 ? `${(r.perDayThousandths / 1000).toFixed(1)} a day` : undefined}>{days(r.daysOnHand)}d</td>
                          <td className="num">{days(r.daysAfter)}d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {rows.length > shown.length && (
                <p className="mt-1 text-xs text-ink-3">{rows.length - shown.length} more qualify below these, further from running out.</p>
              )}
              {shortCount > 0 && needSavingCents > 0 && (
                <p className="mt-2 text-xs text-ink-3">The {shortCount} short line{shortCount === 1 ? "" : "s"} save{shortCount === 1 ? "s" : ""} {money(needSavingCents)} here against {primaryName}{basket?.freightCents ? `; freight ${money(basket.freightCents)}` : ""}.
                {basket && basket.bandDeltaCents !== null && basket.bandDeltaCents < 0 ? ` Moving them costs ${money(Math.abs(basket.bandDeltaCents))} through ${primaryName}'s rebate band${basket.verdict === "move_to_primary" ? ", which makes the primary the cheaper month" : ""}.` : ""}</p>
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
              {rows.length > 0 && rows.every((r) => !r.itemNumber) && (
                <p className="mt-2 text-xs text-warn">This wholesaler&rsquo;s price file carried no item numbers, so these lines cannot be keyed by number; the PioneerRx catalogue export has a &ldquo;Supplier Item Number&rdquo; column.</p>
              )}
            </Card>
          );
        })
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-ink-3">How the lists are built</summary>
        <p className="mt-1 text-xs text-ink-3">
          A line is on a card only when that supplier&rsquo;s price after its rebate is the lowest of everyone who prices it. A short line is sized to {SHELF_POLICY.targetDays} days plus the lead time, less what is on hand and on order. A line to add is a generic by CMS&rsquo;s flag, not controlled, dispensed at a steady rate rather than in one large fill, and shown a pack at a time up to what {minimums.horizonDays} days of use will take; they are ordered by how soon each runs out and how much cheaper it is here.
          {minimums.evidence.days > 0
            ? ` Rates come from ${minimums.evidence.days} day${minimums.evidence.days === 1 ? "" : "s"} of claims (${minimums.evidence.from} to ${minimums.evidence.to})${minimums.evidence.days < minimums.evidence.fullAt ? `; the window grows with every evening's report until it holds ${minimums.evidence.fullAt} days, and the buys deepen to 60 days with it` : ""}.`
            : " No claims are held yet, so there are no rates to buy against."}
          {" "}The item number is the supplier&rsquo;s own, off their price file. {primaryName} is never on a card: everything no secondary beats goes there as usual, and <Link href="/purchasing/shelf" className="underline">the shelf</Link> has every line.
          {fill_leftOut(sections)}
        </p>
      </details>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">Price files: what each card is priced from</summary>
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
    </>
  );
}

/** One line naming what is never listed, from the first card that counted it. */
function fill_leftOut(sections: { fill: { leftOut: { notGeneric: number; controlled: number; unknownClass: number } } | null }[]): string {
  const f = sections.find((x) => x.fill)?.fill;
  return f ? ` Never listed: ${f.leftOut.notGeneric} brands, ${f.leftOut.controlled} controlled, ${f.leftOut.unknownClass} with no brand/generic flag on the NADAC file.` : "";
}
