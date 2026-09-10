import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { allSuppliers, addSupplier, updateSupplier, retireSupplier, useReceiptAsInvoice, importLegacyRules, addressesOf, normaliseAddresses } from "@/lib/suppliers-registry";
import { invoices, filingFor, money } from "@/lib/invoices";
import { termsSummaryBySupplier } from "@/lib/supplier-terms-store";
import { describeRebate, describeReturns } from "@/lib/supplier-terms";
import { catalogSummaryBySupplier } from "@/lib/suppliers";
import { fmt, todayIso, daysBetween } from "@/lib/dates";
import { PageHeader, Card, Notice, Empty, Field } from "@/components/ui";
import { ExportData } from "@/components/export-data";
import { ratesFor, earningSoFar } from "@/lib/rebate-rates";
import { ratioForSupplier } from "@/lib/purchase-ratio";
import { nextTierNow } from "@/lib/shelf";
import { INVOICE_SCHEDULES, type InvoiceSchedule } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Suppliers" };

/**
 * The wholesalers, as records rather than as routing rules.
 *
 * This lived as a line of free text under the email settings — a fragment, an equals sign, a name
 * — which was enough to route a file and nothing else. A supplier is not a routing rule. It is a
 * party the pharmacy has a DEA-registered relationship with, whose invoices are records it must
 * keep for years, and whose silence is itself worth reporting.
 *
 * The addresses they send from are the load-bearing field. An invoice files itself only if the
 * sender is recognised, so a wholesaler who quietly changes their billing address stops being
 * recorded — and the pharmacy goes on believing its archive is complete. That is why the page
 * shows, per supplier, when they last sent something.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { edit, ok, error } = await searchParams;
  const canManage = user.role !== "staff";

  const [suppliers, all, s, terms, catalogs] = await Promise.all([allSuppliers(true), invoices(), getSettings(), termsSummaryBySupplier(), catalogSummaryBySupplier()]);
  // The ones with nothing behind them, for the panel above the grid. Same test the action uses.
  const unused = suppliers.filter((x) => x.active && !catalogs.get(x.id) && !all.some((i) => (i.supplier ?? "").toLowerCase().includes(x.name.toLowerCase().slice(0, 8))));
  const unusedIds = unused.map((x) => x.id);
  const unusedNames = unused.map((x) => x.name);
  /*
   * Where the rebate stands, above the list rather than two clicks inside it.
   *
   * The question a pharmacist opens this page with is what the buying is earning, and until now the
   * answer was on a different screen per supplier and only in percentages. This is the position:
   * the ratio as it stands today, the band it puts the pharmacy in, and what this month's actual
   * invoices from that supplier are earning at those rates.
   */
  const positions = (
    await Promise.all(
      suppliers.filter((x) => x.active).map(async (x) => {
        const rates = await ratesFor(x.id);
        if (!rates || rates.view.programmes.length === 0) return null;
        return { rates, earning: await earningSoFar(x.id), ratio: await ratioForSupplier(x.id) };
      }),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);
  /*
   * What the next band is worth this month, and what it would take to reach it.
   *
   * Only the primary has one: the ratio is a property of where the buying goes, and the question
   * "should I buy this dearer here anyway" is only ever asked about the supplier the ladder belongs
   * to. It sits on that supplier's card rather than in a panel of its own, next to the ratio it is
   * about.
   */
  const nextTier = await nextTierNow();
  const legacy = (s.mail_supplier_rules ?? "").trim();
  const editing = edit ? suppliers.find((x) => x.id === edit) : undefined;
  const today = todayIso();

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const schedule = String(fd.get("expectedSchedule") ?? "");
    const input = {
      name: String(fd.get("name") ?? ""),
      senderEmails: String(fd.get("senderEmails") ?? ""),
      catalogName: String(fd.get("catalogName") ?? ""),
      aliases: String(fd.get("aliases") ?? ""),
      accountNumber: String(fd.get("accountNumber") ?? ""),
      deaNumber: String(fd.get("deaNumber") ?? ""),
      phone: String(fd.get("phone") ?? ""),
      website: String(fd.get("website") ?? ""),
      expectedSchedule: INVOICE_SCHEDULES.includes(schedule as InvoiceSchedule) ? (schedule as InvoiceSchedule) : null,
      notes: String(fd.get("notes") ?? ""),
    };
    try {
      if (id) await updateSupplier(id, input);
      else await addSupplier(input);
      await audit({ action: id ? "supplier.update" : "supplier.add", userId: u.id, userName: u.name, details: input.name });
      // Setting the address once is the whole job: anything this sender already sent that was
      // filed as an ordinary report is read again now and filed as their invoice.
      const { rereadFromSenders } = await import("@/lib/mailbox");
      const again = await rereadFromSenders(normaliseAddresses(input.senderEmails).split(/[\s,;]+/), { userId: u.id, userName: u.name });
      revalidatePath("/suppliers");
      revalidatePath("/inventory/invoices");
      revalidatePath("/inbox");
      redirect(
        "/suppliers?ok=" +
          encodeURIComponent(
            `${input.name} saved. Invoices from ${addressesFrom(input.senderEmails)} will be filed under their name from now on.` +
              (again.filed ? ` ${again.filed} already received ${again.filed === 1 ? "was" : "were"} filed under their name just now.` : again.read ? ` ${again.read} earlier message${again.read === 1 ? "" : "s"} from them ${again.read === 1 ? "was" : "were"} read again; none was an invoice.` : ""),
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/suppliers?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  /**
   * Retires every supplier with no record behind it on this site.
   *
   * The list is worked out again here rather than passed in from the form: a hidden field carrying
   * seventeen ids is a hidden field somebody can edit, and this is the one control on the page that
   * changes many rows at once. Anything that has sent an invoice or loaded a catalogue since the
   * page was drawn is left alone by that recount, which is the safe direction.
   */
  async function retireUnused() {
    "use server";
    const u = await requireManager();
    const [rows, filed, cats] = await Promise.all([allSuppliers(true), invoices(), catalogSummaryBySupplier()]);
    const unused = rows.filter(
      (x) => x.active && !cats.get(x.id) && !filed.some((i) => (i.supplier ?? "").toLowerCase().includes(x.name.toLowerCase().slice(0, 8))),
    );
    for (const x of unused) await retireSupplier(x.id, false);
    await audit({ action: "supplier.retire.unused", userId: u.id, userName: u.name, details: `${unused.length} retired: ${unused.map((x) => x.name).join(", ")}` });
    revalidatePath("/suppliers");
    redirect(
      "/suppliers?ok=" +
        encodeURIComponent(
          `${unused.length} supplier${unused.length === 1 ? "" : "s"} retired — the ones with no invoice and no catalogue here. Nothing is deleted: bring any of them back with one press when you buy from them again.`,
        ),
    );
  }

  async function retire(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const active = String(fd.get("active") ?? "") === "yes";
    await retireSupplier(id, active);
    await audit({ action: "supplier.retire", userId: u.id, userName: u.name, details: `${id} active=${active}` });
    revalidatePath("/suppliers");
    redirect(
      "/suppliers?ok=" +
        encodeURIComponent(
          active
            ? "Back in use. Their invoices will be recognised again."
            : "Retired. Every invoice already filed against them is kept — they are records the pharmacy has to produce for years after it stops buying.",
        ),
    );
  }

  /*
   * Whether their PioneerRx receipt counts as the invoice.
   *
   * The owner: "there are a couple suppliers where I'd rather just use the pioneers invoice as
   * the invoice (ie Xymogen supplier)."
   *
   * It changes nothing about the money — every PioneerRx purchase no invoice covers is already
   * counted — only whether the pharmacy goes and asks for a document it is not going to get.
   */
  async function receiptIsInvoice(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const name = String(fd.get("name") ?? "that supplier");
    const on = String(fd.get("on") ?? "") === "1";
    await useReceiptAsInvoice(id, on);
    await audit({ action: "supplier.receipt_is_invoice", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: `${name} on=${on}` });
    revalidatePath("/suppliers");
    redirect(
      "/suppliers?ok=" +
        encodeURIComponent(
          on
            ? `${name}: their PioneerRx receipt is the invoice. Their deliveries still count as purchases; nothing chases them for a document.`
            : `${name}: waiting for their invoice again. Any delivery of theirs without one is shown on Supplier invoices.`,
        ),
    );
  }

  async function importOld() {
    "use server";
    const u = await requireManager();
    const set = await getSettings();
    const n = await importLegacyRules(set.mail_supplier_rules ?? "");
    await audit({ action: "supplier.import", userId: u.id, userName: u.name, details: `${n}` });
    revalidatePath("/suppliers");
    redirect(
      "/suppliers?ok=" +
        encodeURIComponent(
          n > 0
            ? `${n} supplier${n === 1 ? "" : "s"} brought across from the old email rules. Check the addresses and add anything else you know about them.`
            : "Nothing new to bring across.",
        ),
    );
  }

  return (
    <>
      <PageHeader
        back={{ href: "/purchasing", label: "Ordering" }}
        title="Suppliers"
        subtitle="The wholesalers this pharmacy buys from, and the addresses they send invoices from. An invoice only files itself if the sender is recognised."
        actions={<Link href="/inventory/invoices" className="btn">Supplier invoices</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        No primary supplier is not a blank field, it is a silent switch.

        The buy list prices every move to a secondary against the primary's compliance ratio,
        because a generic bought elsewhere is a generic that did not go through the contract and
        can cost a whole band. With nobody marked primary that arithmetic has no supplier to ask
        and returns "not known" — so the site quietly stops warning about the one thing that can
        make a cheaper invoice the more expensive order.
      */}
      {suppliers.length > 0 && !suppliers.some((x) => x.primarySupplier) && (
        <Notice kind="warn">
          <b>No supplier is marked primary.</b> Until one is, the buy list cannot price what moving
          spend to a secondary does to the rebate band — it will say &ldquo;not known&rdquo; rather than warn you.
          Open the supplier that carries the contract and set it under <b>Ordering, rebate and return terms</b>.
        </Notice>
      )}
      {suppliers.length > 0 && suppliers.every((x) => x.minimumOrderCents === null) && (
        <Notice kind="warn">
          <b>No supplier has an order minimum on file.</b> The buy list will happily recommend a basket a
          wholesaler refuses to ship, and you would find out at their website rather than here.
        </Notice>
      )}

      {/*
        Invoice lines this month that belong to no supplier on the register.

        Shown once, above the cards, and not inside them — it is a property of the month rather
        than of any one supplier, so the same figure appears on every earning and repeating it per
        card would read as each supplier having its own problem.

        It is here at all because silence is what this whole area got wrong once already: the old
        name match dropped eight lines worth $78.50 without a word, and every rebate figure went on
        looking complete. Counting them was half the fix; a figure nobody displays is the same bug
        wearing a different coat.
      */}
      {(() => {
        const m = positions.find((p) => p.earning && p.earning.unplacedLines > 0)?.earning;
        if (!m) return null;
        return (
          <Notice kind="crit">
            <b>
              {m.unplacedLines} invoice line{m.unplacedLines === 1 ? "" : "s"} worth {money(m.unplacedCents)} in{" "}
              {m.month} belong to no supplier on the register.
            </b>{" "}
            Nothing below counts {m.unplacedLines === 1 ? "it" : "them"} — not the purchases, not the ratio, not the
            rebate. {m.unplacedLines === 1 ? "It was" : "They were"} printed as{" "}
            {m.unplacedNames.slice(0, 4).map((n, i) => (
              <span key={n}>
                {i > 0 ? ", " : ""}
                <span className="font-mono">{n}</span>
              </span>
            ))}
            {m.unplacedNames.length > 4 ? ` and ${m.unplacedNames.length - 4} more` : ""}. Add the printed name to
            that supplier under &ldquo;Other names they go by&rdquo; and the lines rejoin the figures.
          </Notice>
        );
      })()}

      {positions.map(({ rates, earning, ratio }) => (
        <Card
          key={rates.supplierId}
          className="mb-4"
          tone={rates.view.contractGenericPercent ? "ok" : "warn"}
          title={`${rates.supplierName} — where the rebate stands`}
          subtitle={
            rates.ratioSource === "daily report"
              ? `Compliance ratio from their own daily report${rates.ratioAsOf ? `, ${rates.ratioAsOf}` : ""}. The band it falls in sets every rate below.`
              : rates.ratioSource === "monthly statement"
                ? `From the ${rates.ratioAsOf ?? "last"} statement — the month that closed. Have the daily report emailed here and this follows it instead.`
                : "No ratio has been read, so no band applies and nothing is being discounted."
          }
          actions={
          <>
            <Link href={`/purchasing/catalog?supplier=${encodeURIComponent(rates.supplierName)}`} className="btn btn-sm">Their catalogue</Link>
            <Link href={`/suppliers/${rates.supplierId}/terms`} className="btn btn-sm">The ladders</Link>
          </>
        }
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat
              value={ratio?.gcrPercent != null ? `${ratio.gcrPercent}%` : "—"}
              label="Scrubbed compliance ratio"
              sub={ratio?.month ? `as at ${ratio.month}` : "not read yet"}
            />
            <Stat
              value={rates.view.contractGenericPercent != null ? `${rates.view.contractGenericPercent}%` : "—"}
              label="On contract generics"
              sub="Every ladder that pays on them, added"
            />
            <Stat
              value={rates.view.brandPercent != null ? `${rates.view.brandPercent}%` : "—"}
              label="On brand"
              sub="The brand factor for that band"
            />
            <Stat
              value={earning?.estimatedRebateCents != null ? money(earning.estimatedRebateCents) : "—"}
              label={`Earned so far in ${earning?.month ?? "the month"}`}
              sub="Estimated from this month's invoices"
              strong
            />
          </div>
          {earning && earning.totalPurchasedCents > 0 && (
            <p className="mt-3 text-xs text-ink-2">
              {money(earning.contractPurchasedCents)} of contract items
              {earning.contractRatePercent != null && earning.contractRebateCents != null
                ? ` at ${earning.contractRatePercent}% is ${money(earning.contractRebateCents)}`
                : " — no rate on file"}
              ; {money(earning.brandPurchasedCents)} of brand and off-contract
              {earning.brandRatePercent != null && earning.brandRebateCents != null
                ? ` at ${earning.brandRatePercent}% is ${money(earning.brandRebateCents)}`
                : " — no rate on file"}
              .
              {earning.unmarkedLines > 0 && (
                <>
                  {" "}
                  {earning.unmarkedLines} line{earning.unmarkedLines === 1 ? "" : "s"} worth{" "}
                  {money(earning.unmarkedPurchasedCents)} carried no contract marking, so nothing is claimed for them
                  rather than guessed either way.
                </>
              )}
            </p>
          )}
          {/*
            The band above, priced against what it would cost to reach — the owner's question:
            "if I am close to a higher tier and it's worth $500, I might want to order generics
            from McKesson even if more expensive." The break-even premium is the answer to it, so
            it is the sentence, not a footnote.
          */}
          {nextTier && nextTier.supplier === rates.supplierName && nextTier.worthCents > 0 && (
            <div className={`mt-3 rounded-lg border p-3 ${nextTier.daysLeft <= 7 ? "border-warn bg-warn-soft" : "border-line bg-ground"}`}>
              <p className="text-sm font-semibold">
                The {nextTier.nextRatePercent}% band is worth {money(nextTier.worthCents)} more this month
                {nextTier.daysLeft > 0 && (
                  <span className="font-normal text-ink-2">
                    {" "}· {nextTier.daysLeft} day{nextTier.daysLeft === 1 ? "" : "s"} left
                  </span>
                )}
              </p>
              <p className="mt-1 text-xs text-ink-2">{nextTier.says}</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <Stat value={money(nextTier.neededCents)} label="more contract generics needed" sub={`to pass ${nextTier.nextThresholdPercent}%`} />
                <Stat value={money(nextTier.worthCents)} label="what the band pays" sub="on the month's contract generics" strong />
                <Stat
                  value={nextTier.breakEvenPremiumPercent !== null ? `${nextTier.breakEvenPremiumPercent.toFixed(2)}%` : "—"}
                  label="break-even premium"
                  sub={`Worth buying here while ${nextTier.supplier} is under this much dearer`}
                />
              </div>
              <p className="mt-2 text-[11px] text-ink-3">
                A projection on the month so far, from the ratio as the {rates.ratioSource === "daily report" ? "daily report" : "last statement"} left
                it. It is not a promise — a fortnight of buying still moves it.
              </p>
            </div>
          )}
          {(!nextTier || nextTier.supplier !== rates.supplierName) &&
            rates.view.nextBandWorthCents !== null &&
            rates.view.nextBandWorthCents > 0 && (
              <p className="mt-2 text-xs text-warn">
                One more band would have paid {money(rates.view.nextBandWorthCents)} more on last period&rsquo;s buying.
              </p>
            )}
        </Card>
      ))}

      {legacy && suppliers.length === 0 && canManage && (
        <Notice kind="warn">
          <b>There are supplier rules in the old email settings that have not been brought across.</b> Typing them
          again is how half of them end up untyped — which here means invoices silently not being filed.
          <form action={importOld} className="mt-2">
            <button className="btn btn-sm btn-primary">Bring them across</button>
          </form>
        </Notice>
      )}

      {/*
        Clearing out the ones that were never going to be used.

        Seventeen wholesalers arrived from PioneerRx at once, and the owner's answer was immediate:
        "I need a way to inactivate some then no longer use a lot of them". Retiring them one at a
        time is twenty-two decisions to reach the four or five that matter, so the ones with nothing
        at all behind them on this site — no invoice ever filed, no catalogue ever loaded — are
        offered together. Everything with a record stays a deliberate choice, one card at a time,
        because retiring a supplier the pharmacy actually buys from stops its invoices being filed.
      */}
      {canManage && unusedIds.length > 0 && (
        <Notice kind="warn">
          {unusedIds.length} of these {suppliers.filter((x) => x.active).length} suppliers have never sent an invoice here and have no catalogue loaded:{" "}
          {unusedNames.slice(0, 6).join(", ")}
          {unusedNames.length > 6 ? ` and ${unusedNames.length - 6} more` : ""}.
          <form action={retireUnused} className="mt-2">
            <button className="btn btn-sm">Retire all {unusedIds.length}</button>
          </form>
        </Notice>
      )}

      {suppliers.length === 0 ? (
        <Empty>
          No supplier is recorded, so nothing arriving by email will be filed as an invoice. Add the wholesalers below.
        </Empty>
      ) : (
        <>
          {/*
            The owner: "when I retire a supplier they should be removed from the list. We can still
            have an inactive section below but they take up so much room.. I have to do too much
            scrolling on this site!!"

            Retired suppliers are the ones he has said he is done with, and they were rendering as
            full cards beside the ones he buys from every day — same size, same detail, same space.
            Nothing is deleted and everything comes back with one press; they are simply not what
            the page is for.
          */}
          <div className="grid gap-4 lg:grid-cols-2">
            {suppliers.filter((x) => x.active).map((sup) => {
            const theirs = all.filter((i) => (i.supplier ?? "").toLowerCase().includes(sup.name.toLowerCase().slice(0, 8)));
            const last = theirs.map((i) => i.invoiceDate).filter(Boolean).sort().at(-1) ?? null;
            const quiet = last ? daysBetween(last, today) : null;
            const spend = theirs.reduce((n, i) => n + (i.totalCents ?? 0), 0);

            return (
              <Card
                key={sup.id}
                title={sup.name}
                tone={!sup.active ? undefined : !sup.senderEmails.trim() ? "crit" : quiet !== null && quiet > 21 ? "warn" : undefined}
                className={sup.active ? "" : "opacity-60"}
                actions={
                  canManage && (
                    <span className="flex items-center gap-1">
                      <Link href={`/suppliers?edit=${sup.id}#edit`} className="btn btn-sm">Edit</Link>
                      {/*
                        Retiring one used to mean opening the edit form and finding a checkbox in it.
                        Tolerable with five wholesalers; not with twenty-two, most of which came out
                        of PioneerRx and will never be bought from again. One press, from the card.
                      */}
                      <form action={retire}>
                        <input type="hidden" name="id" value={sup.id} />
                        <input type="hidden" name="active" value={sup.active ? "no" : "yes"} />
                        <button className="btn btn-sm">{sup.active ? "Retire" : "Bring back"}</button>
                      </form>
                      {/*
                        And whether the pharmacy waits for a document from them at all. Xymogen
                        never sends one; the receipt PioneerRx already holds is the record.
                      */}
                      <form action={receiptIsInvoice}>
                        <input type="hidden" name="id" value={sup.id} />
                        <input type="hidden" name="name" value={sup.name} />
                        <input type="hidden" name="on" value={sup.invoiceFromPioneer ? "0" : "1"} />
                        <button
                          className="btn btn-sm"
                          title={
                            sup.invoiceFromPioneer
                              ? "Go back to expecting an invoice by email from them."
                              : "For a supplier who never emails an invoice: the PioneerRx receipt becomes the record and they are no longer chased for one."
                          }
                        >
                          {sup.invoiceFromPioneer ? "Expect an invoice" : "Receipt is the invoice"}
                        </button>
                      </form>
                    </span>
                  )
                }
              >
                {!sup.active && <p className="card-sub">Retired. Their invoices are kept; nothing new is expected.</p>}

                {/*
                  The address is the load-bearing field, so its absence is the loudest thing on the card.
                  A supplier with no address recorded is a supplier whose invoices are quietly not
                  being filed, and nothing else on this page would reveal that.
                */}
                {sup.invoiceFromPioneer ? (
                  /*
                   * Not a fault, so not in red. He has said their receipt is the record, and the
                   * crit line below would tell him their invoices are quietly not being filed —
                   * true, and no longer news. Xymogen had it, and it was the wrong news to give.
                   */
                  <p className="text-xs text-ink-2">
                    Their PioneerRx receipt is the invoice. Deliveries are counted from PioneerRx and nothing waits
                    on an email from them.
                  </p>
                ) : sup.senderEmails.trim() ? (
                  <p className="text-xs text-ink-2">
                    Sends from{" "}
                    {addressesOf(sup).map((a) => (
                      <code key={a} className="mr-1 rounded bg-ground px-1">{a}</code>
                    ))}
                  </p>
                ) : (
                  <p className="text-xs text-crit">
                    No sending address recorded, so their invoices will not be recognised or filed.
                  </p>
                )}

                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {sup.accountNumber && (
                    <>
                      <dt className="text-ink-3">Account</dt>
                      <dd className="font-mono">{sup.accountNumber}</dd>
                    </>
                  )}
                  {sup.deaNumber && (
                    <>
                      <dt className="text-ink-3">Their DEA</dt>
                      <dd className="font-mono">{sup.deaNumber}</dd>
                    </>
                  )}
                  {sup.phone && (
                    <>
                      <dt className="text-ink-3">Phone</dt>
                      <dd>{sup.phone}</dd>
                    </>
                  )}
                  <dt className="text-ink-3">Expected to send</dt>
                  <dd>{sup.expectedSchedule ? filingFor(sup.expectedSchedule).label : "not stated"}</dd>
                  <dt className="text-ink-3">Invoices held</dt>
                  <dd>
                    <Link href={`/inventory/invoices?q=${encodeURIComponent(sup.name)}`} className="text-accent hover:underline">
                      {theirs.length}
                    </Link>
                    {spend > 0 ? ` · ${money(spend)}` : ""}
                  </dd>
                  <dt className="text-ink-3">Last invoice</dt>
                  <dd className={quiet !== null && quiet > 21 ? "text-warn" : ""}>
                    {last ? `${fmt(last)}${quiet !== null && quiet > 21 ? ` — ${quiet} days ago` : ""}` : "none yet"}
                  </dd>
                  {/*
                    The catalogue, the rebate schedule and the return policy, on the same card as
                    the invoices — because they are facts about one supplier, and until they sat
                    together nothing could say "McKesson: 31,000 prices as of Monday, 2.5% tier,
                    returns to six months past expiry" in one place.
                  */}
                  <dt className="text-ink-3">Catalogue</dt>
                  <dd>
                    {(() => {
                      const c = catalogs.get(sup.id);
                      if (!c) return <span className="text-ink-3">none filed under this supplier{sup.catalogName ? "" : " — set the catalogue name to tie one"}</span>;
                      return `${c.items.toLocaleString()} prices, file of ${c.pricedOn ? fmt(c.pricedOn) : fmt(c.lastAt.slice(0, 10))}`;
                    })()}
                  </dd>
                  <dt className="text-ink-3">Rebate</dt>
                  {/* "Nobody has typed it in" and "there are none" are different answers; see suppliers.noRebates. */}
                  <dd>
                    {terms.get(sup.id)?.rebate ? (
                      describeRebate(terms.get(sup.id)!.rebate!.terms)
                    ) : sup.noRebates ? (
                      <span className="text-ink-2">none — they pay no rebates</span>
                    ) : (
                      <span className="text-ink-3">not recorded</span>
                    )}
                  </dd>
                  <dt className="text-ink-3">Returns</dt>
                  <dd>{terms.get(sup.id)?.returns ? describeReturns(terms.get(sup.id)!.returns!.terms) : <span className="text-ink-3">not recorded</span>}</dd>
                  {/*
                    How they will take an order, on the card rather than behind a link called
                    something else.

                    The minimum and the primary flag were reachable only through a link labelled
                    "Rebate and return terms", which is a fair description of what used to be
                    there and no help at all to somebody looking for an order minimum. Nothing on
                    this page said the settings existed, so as far as the pharmacy was concerned
                    they did not.
                  */}
                  <dt className="text-ink-3">Ordering</dt>
                  <dd>
                    {sup.minimumOrderCents === null ? (
                      <span className="text-warn">no minimum on file</span>
                    ) : (
                      <>
                        minimum {money(sup.minimumOrderCents)}
                        {sup.leadTimeDays !== null ? ` · ${sup.leadTimeDays} day${sup.leadTimeDays === 1 ? "" : "s"} to arrive` : ""}
                      </>
                    )}
                    {sup.primarySupplier && <span className="badge badge-ok ml-1.5">primary</span>}
                  </dd>
                </dl>
                <p className="mt-2 flex flex-wrap gap-2 text-xs">
                  <Link href={`/suppliers/${sup.id}/terms`} className="btn btn-sm">
                    Ordering, rebate and return terms
                  </Link>
                </p>

                {sup.notes && <p className="mt-2 text-xs text-ink-3">{sup.notes}</p>}

                {canManage && (
                  <form action={retire} className="mt-3">
                    <input type="hidden" name="id" value={sup.id} />
                    <input type="hidden" name="active" value={sup.active ? "no" : "yes"} />
                    <button className="text-xs text-ink-3 hover:text-crit hover:underline">
                      {sup.active ? "Retire this supplier" : "Put back in use"}
                    </button>
                  </form>
                )}
              </Card>
            );
            })}
          </div>

          {suppliers.some((x) => !x.active) && (
            <details className="mt-4 rounded-lg border border-line bg-surface">
              <summary className="cursor-pointer px-3 py-2 text-sm">
                Retired ({suppliers.filter((x) => !x.active).length}) — kept, not deleted
              </summary>
              <ul className="divide-y divide-line">
                {suppliers.filter((x) => !x.active).map((sup) => (
                  <li key={sup.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span>
                      <Link href={`/suppliers/${sup.id}/terms`} className="text-sm underline">{sup.name}</Link>
                      {sup.accountNumber ? <span className="ml-2 text-xs text-ink-2">acct {sup.accountNumber}</span> : null}
                    </span>
                    <form action={retire}>
                      <input type="hidden" name="id" value={sup.id} />
                      <input type="hidden" name="active" value="yes" />
                      <button className="btn btn-sm">Bring back</button>
                    </form>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {canManage && (
        <Card
          id="edit"
          title={editing ? `Edit ${editing.name}` : "Add a supplier"}
          subtitle="The addresses are what matter most: an invoice files itself only if the sender is recognised. A bare domain works as well as a full address, since invoices often come from a different mailbox at the same company each month."
          className="mt-6 scroll-mt-4"
        >
          <form action={save} className="grid gap-3 sm:grid-cols-2">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <Field label="Name">
              <input name="name" defaultValue={editing?.name ?? ""} required className="field" placeholder="McKesson" />
            </Field>
            <Field label="Our account number with them">
              <input name="accountNumber" defaultValue={editing?.accountNumber ?? ""} className="field" />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Addresses they send invoices from — one per line"
                hint="A whole address, or just the domain. Anything a message comes from that contains one of these is treated as an invoice from them."
              >
                <textarea
                  name="senderEmails"
                  rows={3}
                  defaultValue={editing?.senderEmails ?? ""}
                  className="field font-mono text-xs"
                  placeholder={"invoices@mckesson.com\nmckesson.com"}
                />
              </Field>
            </div>
            <Field
              label="Name on the catalogue export"
              hint='What the PioneerRx catalogue calls them inside the file — McKesson, IPD, IPC, ParMed. Ties Monday&apos;s prices to this supplier. Leave blank if it is the same as the name.'
            >
              <input name="catalogName" defaultValue={editing?.catalogName ?? ""} className="field" placeholder="McKesson" />
            </Field>
            <Field
              label="Other names they go by"
              hint="One per line. The name printed on their invoices, which is often the long legal one — the register says IPC and the invoice says Independent Pharmacy Cooperative. Without it those lines belong to no supplier and drop out of the rebate figures. Only names you have actually seen on their paperwork."
            >
              <textarea
                name="aliases"
                defaultValue={editing?.aliases ?? ""}
                rows={2}
                className="field font-mono text-xs"
                placeholder={"Independent Pharmacy Cooperative"}
              />
            </Field>
            <Field label="Their DEA registration">
              <input name="deaNumber" defaultValue={editing?.deaNumber ?? ""} className="field font-mono" />
            </Field>
            <Field label="Phone">
              <input name="phone" defaultValue={editing?.phone ?? ""} className="field" />
            </Field>
            <Field label="Website">
              <input name="website" defaultValue={editing?.website ?? ""} className="field" />
            </Field>
            <Field
              label="What they normally send"
              hint="Never used to file anything. Used the other way round — to tell you when they send something they never send."
            >
              <select name="expectedSchedule" defaultValue={editing?.expectedSchedule ?? ""} className="field">
                <option value="">Not stated</option>
                <option value="none">Nothing controlled</option>
                <option value="schedule_3_5">Schedule III-V at most</option>
                <option value="schedule_2">Schedule II and below</option>
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Anything worth remembering">
                <input name="notes" defaultValue={editing?.notes ?? ""} className="field" />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <button className="btn btn-primary">{editing ? "Save" : "Add supplier"}</button>
              {editing && <Link href="/suppliers" className="btn ml-1.5">Cancel</Link>}
            </div>
          </form>
        </Card>
      )}

      <ExportData page="suppliers" className="mt-6" />
    </>
  );
}

function addressesFrom(raw: string): string {
  const list = raw
    .split(/[\n,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return list.length === 0 ? "them" : list.join(", ");
}

/** A figure with its label, small enough that four fit across a card. */
function Stat({ value, label, sub, strong }: { value: string; label: string; sub?: string; strong?: boolean }) {
  const tone = value === "—" ? "" : strong ? "kpi-ok" : "";
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value text-xl ${value === "—" ? "text-ink-3" : strong ? "text-accent" : ""}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
