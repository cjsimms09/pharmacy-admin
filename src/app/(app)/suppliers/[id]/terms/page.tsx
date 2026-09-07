import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fmt, todayIso } from "@/lib/dates";
import {
  parseTierLines,
  parseCreditLines,
  parseList,
  describeReturns,
  readRebateTerms,
  readReturnTerms,
  type ReturnTermsT,
} from "@/lib/supplier-terms";
import {
  rebateProgramsFor,
  returnPoliciesFor,
  saveRebateProgram,
  saveReturnPolicy,
  rebateProgramsInForce,
  deleteRebateProgram,
  deleteReturnPolicy,
  duplicateRebatePrograms,
} from "@/lib/supplier-terms-store";
import { rebateStatementFor } from "@/lib/rebate-report-store";
import { rebateView, type ProgrammeView } from "@/lib/rebate-view";
import { ratesFor } from "@/lib/rebate-rates";
import { ratioForSupplier } from "@/lib/purchase-ratio";
import { PageHeader, Card, Notice, Field } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { getSettings, setSetting } from "@/lib/settings";
import { parseCents, formatCents } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supplier terms" };

/**
 * What this supplier's rebates and returns are actually worth.
 *
 * The screen this replaces asked the reader to do the work. A supplier running three rebate
 * programmes had one of them picked at random, headed "Rebate schedule" and shown as a run of
 * arrows — and the one picked was the ladder paying nothing, with the ladder paying thirty percent
 * filed under "Earlier schedules", which it was not. Nothing said which band the pharmacy was in.
 * Nothing said what any of it was worth. Underneath sat a worked example about a ratio the
 * pharmacy does not have.
 *
 * So this page answers three questions in order, and the order is the design:
 *
 *   **What comes off a price today** — one figure per kind of item, adding every ladder that pays
 *   on that kind, because a supplier paying two rebates on one contract generic discounts it by
 *   both and no single programme holds the answer.
 *
 *   **Why that figure** — each ladder in full, with the band the pharmacy is in marked, the money
 *   it paid last period beside it, and how far the next band is in points and in dollars.
 *
 *   **How anybody knows it is right** — the arithmetic the supplier's own report was checked
 *   against, with the report itself one click away.
 *
 * Editing comes last on purpose. Almost none of this should ever be typed: the ladders are read
 * off the supplier's report and the return terms off the policy PDF. The forms are there for the
 * supplier who sends neither.
 */
export default async function SupplierTermsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string; edit?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { ok, error, edit } = await searchParams;
  const supplier = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, id) });
  if (!supplier) notFound();
  const canManage = user.role !== "staff";
  const today = todayIso();

  const [allRebates, returns, inForce, settings] = await Promise.all([
    rebateProgramsFor(id),
    returnPoliciesFor(id),
    rebateProgramsInForce(id, today),
    getSettings(),
  ]);
  /*
   * The settlement belongs to the supplier it was read from.
   *
   * It used to be one global setting shown wherever the supplier's name matched /mckesson/i, so a
   * second supplier sending a rebate report would have placed this one's ladders in bands it has
   * never reached. It is now a column on the supplier.
   */
  const statement = await rebateStatementFor(id);

  /*
   * The bands are picked by the freshest ratio there is, not by the last statement.
   *
   * The daily drill down says where the compliance ratio has got to this month; the monthly
   * statement says where it closed. An order placed this morning is discounted at the band the
   * ratio is in now, so that is the one this page shows — and it says which it used.
   */
  const rates = await ratesFor(id);
  const view = rates?.view ?? rebateView([], null, supplier.noRebates ? { by: supplier.noRebatesBy, at: supplier.noRebatesAt } : null);
  const ratio = await ratioForSupplier(id);

  const superseded = allRebates.filter((r) => !inForce.some((p) => p.row.id === r.id));
  const currentReturn = returns.find((r) => r.effectiveFrom <= today && (r.effectiveTo === null || r.effectiveTo >= today)) ?? returns[0] ?? null;
  const storedReturnTerms = currentReturn ? readReturnTerms(currentReturn.termsJson) : null;
  const duplicates = await duplicateRebatePrograms(id);
  const editing = allRebates.find((r) => r.id === edit) ?? null;
  const editingTerms = editing ? readRebateTerms(editing.termsJson) : null;

  const draft = (() => {
    const raw = settings.returns_policy_draft;
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as import("@/lib/ai").ReadReturnPolicyT & { supplierId: string; fileName: string; readAt: string; documentId?: string | null };
      return d.supplierId === id ? d : null;
    } catch {
      return null;
    }
  })();

  /*
   * What the form shows: the draft where one has been read, the stored terms otherwise.
   *
   * The bug this fixes was the whole of "it read the policy and didn't update any of the return
   * settings". The draft was displayed above the form as a list of quotes and the form went on
   * showing the stored terms — which were empty — so reading a policy visibly did nothing and
   * saving would have written blanks over it. A proposal that does not reach the boxes you press
   * Save on is not a proposal.
   */
  const returnTerms: ReturnTermsT | null = draft
    ? {
        windowMonthsBeforeExpiry: draft.windowMonthsBeforeExpiry,
        windowMonthsAfterExpiry: draft.windowMonthsAfterExpiry,
        creditSteps: draft.creditSteps,
        creditStepsFromInvoice: draft.creditStepsFromInvoice ?? [],
        returnableWithinDaysOfInvoice: draft.returnableWithinDaysOfInvoice ?? null,
        restockingFeePercent: draft.restockingFeePercent,
        nonReturnable: draft.nonReturnable,
        reverseDistributor: draft.reverseDistributor,
        notes: draft.notes,
      }
    : storedReturnTerms;

  /**
   * Filing the whole rebate report from here, rather than typing any of it.
   *
   * The ladders, the achieved rate and the arithmetic that proves both come off one PDF. Uploading
   * it here does what the mailbox does when it arrives by email — and keeps the PDF, so the tier
   * table can be checked against the page it came from rather than taken on trust.
   */
  async function readRebateReport(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("report");
    if (!(file instanceof File) || file.size === 0) redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent("Choose the rebate report PDF first."));
    try {
      const buf = Buffer.from(await (file as File).arrayBuffer());
      const { pdfText } = await import("@/lib/pdf-text");
      const { fileRebateReport, looksLikeRebateReport } = await import("@/lib/rebate-report-store");
      const text = pdfText(buf);
      if (!looksLikeRebateReport(text)) {
        redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent("That does not read as a rebate breakdown — it carries no tier table and no settlement figures."));
      }
      // Kept first, so the ladder always has the page it was read from beside it.
      const { storeSupplierDocument } = await import("@/lib/supplier-documents");
      const doc = await storeSupplierDocument(buf, (file as File).name, {
        supplierId: id,
        supplierName: supplier!.name,
        kind: "rebate_report",
        user: u,
      });
      const r = await fileRebateReport(text, { documentId: doc.id, supplierId: id }, u);
      await audit({ action: "supplier.rebate.read", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: (file as File).name });
      revalidatePath(`/suppliers/${id}/terms`);
      redirect(`/suppliers/${id}/terms?${r.stored ? "ok" : "error"}=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not read that report."));
    }
  }

  /**
   * Removing a ladder or a policy.
   *
   * A versioned record is normally kept forever, because a rebate paid last quarter was earned
   * under last quarter's ladder. That argument covers records of things that happened; it does not
   * cover a duplicate created by a filing bug, and leaving one with no way out means this page
   * shows six ladders where there are three and none of the arithmetic on it can be trusted.
   */
  async function setRebatesNone(fd: FormData) {
    "use server";
    const u = await requireManager();
    const { setNoRebates } = await import("@/lib/supplier-terms-store");
    const message = await setNoRebates(id, String(fd.get("none") ?? "") === "1", u);
    revalidatePath(`/suppliers/${id}/terms`);
    revalidatePath("/suppliers");
    redirect(`/suppliers/${id}/terms?ok=` + encodeURIComponent(message));
  }

  async function removeProgram(fd: FormData) {
    "use server";
    const u = await requireManager();
    const which = String(fd.get("which") ?? "");
    try {
      const r = which.startsWith("policy:")
        ? await deleteReturnPolicy(which.slice(7))
        : await deleteRebateProgram(which);
      await audit({ action: "supplier.terms.delete", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: `${r.name} from ${r.effectiveFrom}` });
      revalidatePath(`/suppliers/${id}/terms`);
      revalidatePath("/suppliers");
      redirect(`/suppliers/${id}/terms?ok=` + encodeURIComponent(`Removed “${r.name}” taking effect ${r.effectiveFrom}.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not remove that."));
    }
  }

  /**
   * How this supplier will and will not take an order.
   *
   * Not a rebate and not a return policy, but it decides both of those in practice: a saving on a
   * secondary's price is only a saving if the order reaches their minimum, and an order that does
   * not is either abandoned or padded with stock nobody wanted. Recorded here so the buy list can
   * say "short by $320" before the buying is done rather than after.
   *
   * Blank means "not known", which is a different thing from zero. Zero is a supplier who will
   * ship a single bottle; blank is a supplier whose terms nobody has entered, and the buy list
   * treats those two very differently.
   */
  async function saveOrdering(fd: FormData) {
    "use server";
    const u = await requireManager();
    const cents = (name: string): number | null => {
      const raw = String(fd.get(name) ?? "").trim();
      if (!raw) return null;
      const n = parseCents(raw);
      return n === null || n < 0 ? null : n;
    };
    const whole = (name: string): number | null => {
      const raw = String(fd.get(name) ?? "").trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };
    const primary = fd.get("primarySupplier") === "yes";

    /*
     * Exactly one supplier is the primary. Setting a new one clears the old, rather than leaving
     * two: the rebate-band arithmetic asks "which relationship carries the ladder" and two answers
     * is worse than none — it would price the same order against whichever row came back first.
     */
    if (primary) await db.update(schema.suppliers).set({ primarySupplier: false });
    await db
      .update(schema.suppliers)
      .set({
        minimumOrderCents: cents("minimumOrderCents"),
        freeFreightCents: cents("freeFreightCents"),
        freightCents: cents("freightCents"),
        leadTimeDays: whole("leadTimeDays"),
        paymentTermsDays: whole("paymentTermsDays"),
        primarySupplier: primary,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.suppliers.id, id));

    await audit({ action: "supplier.ordering.save", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: "order minimum, freight and lead time" });
    revalidatePath(`/suppliers/${id}/terms`);
    revalidatePath("/suppliers");
    revalidatePath("/purchasing");
    redirect(`/suppliers/${id}/terms?ok=` + encodeURIComponent("Ordering terms saved. The buy list will hold an order to this supplier until the minimum is met."));
  }

  /** Clears every duplicate at once, keeping the first copy of each. */
  async function clearDuplicates() {
    "use server";
    const u = await requireManager();
    const dupes = await duplicateRebatePrograms(id);
    let removed = 0;
    for (const g of dupes) {
      for (const d of g.drop) {
        await deleteRebateProgram(d.id);
        removed++;
      }
    }
    await audit({ action: "supplier.terms.dedupe", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: `${removed} removed` });
    revalidatePath(`/suppliers/${id}/terms`);
    revalidatePath("/suppliers");
    redirect(`/suppliers/${id}/terms?ok=` + encodeURIComponent(`${removed} duplicate ${removed === 1 ? "ladder" : "ladders"} removed. One copy of each is kept.`));
  }

  /**
   * Saving one ladder, from a grid rather than a block of text.
   *
   * Tiers arrive as pairs of numbered fields — a row per band, the threshold beside what it pays.
   * A row with both boxes empty is not a band; a row with one filled is a mistake worth stopping
   * on, because a threshold with no rate silently drops a band and every price above it is then
   * discounted at the band below.
   */
  async function saveRebate(fd: FormData) {
    "use server";
    const u = await requireManager();
    const thresholds = fd.getAll("threshold").map((x) => String(x).trim());
    const rates = fd.getAll("rebate").map((x) => String(x).trim());
    const lines: string[] = [];
    const problems: string[] = [];
    for (let i = 0; i < Math.max(thresholds.length, rates.length); i++) {
      const t = thresholds[i] ?? "";
      const r = rates[i] ?? "";
      if (!t && !r) continue;
      if (!t || !r) {
        problems.push(`Row ${i + 1} has only one of the two figures. A band needs the rate it starts at and what it pays.`);
        continue;
      }
      lines.push(`${t} -> ${r}`);
    }
    const pasted = String(fd.get("pasted") ?? "").trim();
    const parsed = parseTierLines(pasted || lines.join("\n"));
    const all = [...problems, ...parsed.problems];
    if (all.length) redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(all.join(" ")));
    if (parsed.tiers.length === 0) redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent("No bands were given, so there is nothing to save."));

    const measure = String(fd.get("ratioMeasure") ?? "");
    const terms = {
      kind: parsed.tiers.length > 1 ? "tiered_ratio" : "flat_percent",
      period: String(fd.get("period") ?? "quarter"),
      eligibility: String(fd.get("eligibility") ?? "catalog_rebate_flag"),
      ratioMeasure: measure === "generic_compliance" || measure === "generic_purchase_ratio" ? measure : null,
      ratioDefinition: String(fd.get("ratioDefinition") ?? "").trim() || null,
      tiers: parsed.tiers,
      paidAs: String(fd.get("paidAs") ?? "").trim() || null,
      notes: String(fd.get("termNotes") ?? "").trim() || null,
    };
    try {
      await saveRebateProgram(
        id,
        { name: String(fd.get("name") ?? ""), effectiveFrom: String(fd.get("effectiveFrom") ?? ""), notes: String(fd.get("notes") ?? "") },
        terms,
        u,
      );
      await audit({ action: "supplier.rebate.save", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: String(fd.get("name") ?? "") });
      revalidatePath(`/suppliers/${id}/terms`);
      revalidatePath("/suppliers");
      redirect(`/suppliers/${id}/terms?ok=` + encodeURIComponent(`Saved. ${parsed.tiers.length} band${parsed.tiers.length === 1 ? "" : "s"} in force from ${String(fd.get("effectiveFrom"))}; any earlier version of this same programme is closed the day before.`));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  /**
   * Reads a returned-goods policy PDF and fills the form below from it.
   *
   * A rebate breakdown is a grid of figures that checks itself, so it is read by rule. A returns
   * policy is paragraphs of conditions, and two real ones — McKesson's and IPC's — yield almost no
   * readable text at all: twenty-seven characters of fragments from one of them. So the document
   * goes to the model as a document.
   *
   * The PDF is kept either way. A return window is a term of trade the pharmacy will be arguing
   * about with a supplier one day, and a figure with no page behind it is not worth having.
   */
  async function readPolicy(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("policy");
    if (!(file instanceof File) || file.size === 0) {
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent("Choose the policy PDF first."));
    }
    try {
      const buf = Buffer.from(await (file as File).arrayBuffer());
      const { storeSupplierDocument } = await import("@/lib/supplier-documents");
      const doc = await storeSupplierDocument(buf, (file as File).name, {
        supplierId: id,
        supplierName: supplier!.name,
        kind: "return_policy",
        user: u,
      });
      const { readReturnPolicy } = await import("@/lib/ai");
      const read = await readReturnPolicy(buf, supplier!.name, { userId: u.id, userName: u.name });
      await audit({ action: "supplier.returns.read", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: (file as File).name });
      await setSetting("returns_policy_draft", JSON.stringify({ ...read, supplierId: id, fileName: (file as File).name, readAt: new Date().toISOString(), documentId: doc.id }));
      revalidatePath(`/suppliers/${id}/terms`);
      redirect(
        `/suppliers/${id}/terms?ok=` +
          encodeURIComponent(
            `Read ${(file as File).name}, and the PDF is kept against ${supplier!.name}. Check each figure against the quote beside it, then save — nothing is stored until you do.` +
              (read.unclear.length ? ` ${read.unclear.length} thing${read.unclear.length === 1 ? " was" : "s were"} left unsettled.` : ""),
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not read that policy."));
    }
  }

  async function saveReturns(fd: FormData) {
    "use server";
    const u = await requireManager();
    const steps = parseCreditLines(String(fd.get("creditSteps") ?? ""));
    if (steps.problems.length) redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(steps.problems.join(" ")));
    const num = (k: string) => {
      const s = String(fd.get(k) ?? "").trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    };
    /*
     * The invoice-date steps, which are what most returns actually turn on.
     *
     * Entered as a grid of "within this many days, this much credit" — McKesson credits a saleable
     * return in full inside thirty days of the invoice and three quarters after. Expiry does not
     * enter into it: a bottle bought last week and not wanted goes back on the invoice's clock.
     */
    const withinDays = fd.getAll("withinDays").map((x) => String(x).trim());
    const creditAt = fd.getAll("creditAt").map((x) => String(x).trim());
    const invoiceSteps: { withinDays: number | null; creditPercent: number }[] = [];
    for (let i = 0; i < Math.max(withinDays.length, creditAt.length); i++) {
      const d = withinDays[i] ?? "";
      const c = creditAt[i] ?? "";
      if (!d && !c) continue;
      if (!c) {
        redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(`Row ${i + 1} of the invoice-date steps has no credit percentage.`));
      }
      invoiceSteps.push({ withinDays: d ? Number(d) : null, creditPercent: Number(c) });
    }
    invoiceSteps.sort((a, b) => (a.withinDays ?? Number.MAX_SAFE_INTEGER) - (b.withinDays ?? Number.MAX_SAFE_INTEGER));

    const terms = {
      windowMonthsBeforeExpiry: num("windowBefore"),
      windowMonthsAfterExpiry: num("windowAfter"),
      creditSteps: steps.steps,
      creditStepsFromInvoice: invoiceSteps,
      returnableWithinDaysOfInvoice: num("returnableWithin"),
      restockingFeePercent: num("restockingFee"),
      nonReturnable: parseList(String(fd.get("nonReturnable") ?? "")),
      reverseDistributor: String(fd.get("reverseDistributor") ?? "").trim() || null,
      notes: String(fd.get("termNotes") ?? "").trim() || null,
    };
    try {
      await saveReturnPolicy(
        id,
        {
          name: String(fd.get("name") ?? ""),
          effectiveFrom: String(fd.get("effectiveFrom") ?? ""),
          notes: String(fd.get("notes") ?? ""),
          documentId: String(fd.get("documentId") ?? "") || null,
        },
        terms,
        u,
      );
      await audit({ action: "supplier.returns.save", userId: u.id, userName: u.name, entity: "supplier", entityId: id });
      revalidatePath(`/suppliers/${id}/terms`);
      revalidatePath("/suppliers");
      revalidatePath("/inventory/returns");
      await setSetting("returns_policy_draft", "");
      redirect(`/suppliers/${id}/terms?ok=` + encodeURIComponent("Return policy saved. Anything bought from this supplier is now on a return clock the site can count down."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  return (
    <>
      <PageHeader
        back={{ href: "/suppliers", label: "Suppliers" }}
        title={`${supplier.name} — ordering, rebates and returns`}
        subtitle="How they will take an order, what comes off their prices, and how anybody knows it is right. Almost none of the rebate and return detail should be typed: send the report and the policy and both are read."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {duplicates.length > 0 && canManage && (
        <Notice kind="warn">
          <b>The same ladder is on file more than once.</b> {duplicates.reduce((n, g) => n + g.drop.length, 0)} extra{" "}
          {duplicates.reduce((n, g) => n + g.drop.length, 0) === 1 ? "copy" : "copies"} of{" "}
          {duplicates.length === 1 ? "one programme" : `${duplicates.length} programmes`} — identical terms, identical
          start date. Reading the same report twice under a differently spelled supplier name did this. Nothing below
          adds up correctly until they are gone.
          <form action={clearDuplicates} className="mt-2">
            <button className="btn btn-sm btn-primary">Keep one of each and remove the rest</button>
          </form>
        </Notice>
      )}

      {/* ── 0. How they will take an order ────────────────────────────── */}
      <Card
        className="mt-4"
        tone={supplier.minimumOrderCents === null ? "warn" : undefined}
        title="How they will take an order"
        subtitle="The minimum, the freight, and how long it takes to arrive. Without these the buy list will recommend a basket this supplier refuses."
      >
        <form action={saveOrdering} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Order minimum" hint="They will not ship under this. Leave blank if they have none; 0 means they will ship anything.">
            <input name="minimumOrderCents" defaultValue={supplier.minimumOrderCents === null ? "" : formatCents(supplier.minimumOrderCents)} placeholder="500.00" inputMode="decimal" />
          </Field>
          <Field label="Free freight above" hint="Where different from the minimum. Below it, the charge below is added to every comparison.">
            <input name="freeFreightCents" defaultValue={supplier.freeFreightCents === null ? "" : formatCents(supplier.freeFreightCents)} placeholder="250.00" inputMode="decimal" />
          </Field>
          <Field label="Freight charged below that">
            <input name="freightCents" defaultValue={supplier.freightCents === null ? "" : formatCents(supplier.freightCents)} placeholder="15.00" inputMode="decimal" />
          </Field>
          <Field label="Days from order to shelf" hint="Part of how much cover an order has to buy, not a footnote.">
            <input name="leadTimeDays" type="number" min={0} step={1} defaultValue={supplier.leadTimeDays ?? ""} placeholder="1" />
          </Field>
          <Field label="Paid how many days after the invoice" hint="From the supply agreement. The cash account counts an invoice with no recorded payment date on its date plus this.">
            <input name="paymentTermsDays" type="number" min={0} step={1} defaultValue={supplier.paymentTermsDays ?? ""} placeholder="7" />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="primarySupplier" value="yes" defaultChecked={supplier.primarySupplier === true} className="mt-1" />
              <span>
                <b>This is the primary wholesaler.</b> Exactly one supplier is, and it is the one whose compliance ratio
                moving spend away from costs a rebate band. It is taken from the contract rather than from whoever
                happened to be the largest this month — the buy list prices every switch against this supplier&rsquo;s
                ladder, and pointing it at the wrong one gets the arithmetic exactly backwards.
              </span>
            </label>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <SubmitButton pendingLabel="Saving…">Save ordering terms</SubmitButton>
          </div>
        </form>
        {supplier.minimumOrderCents !== null && (
          <p className="mt-3 text-sm text-ink-3">
            The buy list will hold an order to {supplier.name} until it reaches {formatCents(supplier.minimumOrderCents)},
            and will offer to fill the gap with the drugs this supplier is cheapest on that move fast enough to be worth
            buying deep. <Link href="/purchasing" className="underline">See what it would order today</Link>.
          </p>
        )}
      </Card>

      {/* ── 1. The answer ─────────────────────────────────────────────── */}
      <Card
        className="mt-4"
        tone={view.contractGenericPercent ? "ok" : undefined}
        title="What comes off this supplier's prices today"
        subtitle={
          rates?.ratioSource === "daily report"
            ? `From this supplier's own daily report${rates.ratioAsOf ? `, ${fmt(rates.ratioAsOf.length === 7 ? `${rates.ratioAsOf}-01` : rates.ratioAsOf)}` : ""}. Every ladder that pays on the same kind of item is added together, because that is what the supplier does.`
            : view.asOf
              ? `Worked from the ${fmt(view.asOf)} statement — the month that closed, not where the ratio stands today. Send the daily report and this follows it.`
              : "Nothing has said which band this pharmacy is in, so no price is being discounted."
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Headline value={view.contractGenericPercent} label="off contract items" sub="The ones the catalogue marks rebated" />
          <Headline value={view.allGenericsPercent} label="off every generic" sub="Contract or not" hideWhenNull />
          <Headline value={view.brandPercent} label="off brand" sub="Brand-name items only" />
        </div>
        {ratio && ratio.gcrPercent !== null && (
          <div className="mt-3 rounded-md border border-line bg-ground p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Where the ratio stands</p>
            <p className="mt-1 text-sm">
              <b>{ratio.gcrPercent}%</b> generic compliance{ratio.month ? ` for ${ratio.month}` : ""}
              {ratio.osRxPercent !== null ? `, OneStop ${ratio.osRxPercent}% of Rx` : ""}
              {ratio.generatedOn ? `, read off the report generated ${fmt(ratio.generatedOn)}` : ""}.
              {ratio.documentId && (
                <>
                  {" "}
                  <a href={`/files/${ratio.documentId}`} target="_blank" rel="noreferrer" className="text-accent underline">Open it</a>
                </>
              )}
            </p>
            {ratio.months.length > 1 && (
              <div className="mt-2 overflow-x-auto">
                <table className="table max-w-md">
                  <thead><tr><th>Month</th><th className="text-right">Compliance</th><th className="text-right">OneStop / Rx</th></tr></thead>
                  <tbody>
                    {ratio.months.slice(0, 6).map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td className="num">{m.gcrPercent === null ? "—" : `${m.gcrPercent}%`}</td>
                        <td className="num">{m.osRxPercent === null ? "—" : `${m.osRxPercent}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {view.nextBandWorthCents !== null && view.nextBandWorthCents > 0 && (
          <p className="mt-3 rounded-md border border-warn bg-ground p-3 text-sm">
            <b>${(view.nextBandWorthCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} left on the table.</b>{" "}
            That is what one more band on each ladder would have paid on last period&rsquo;s buying. The bands are below.
          </p>
        )}
      </Card>

      {/* ── 2. Each ladder, with the band you are in ──────────────────── */}
      {view.programmes.length === 0 ? (
        <Card
          className="mt-4"
          title="Rebate programmes"
          subtitle={
            supplier.noRebates
              ? "This supplier pays none, so their prices are compared as they stand."
              : "Nothing on file, so a comparison uses this supplier's gross prices."
          }
        >
          {supplier.noRebates ? (
            <>
              <p className="text-sm text-ink-2">
                Recorded as paying no rebates{supplier.noRebatesBy ? ` by ${supplier.noRebatesBy}` : ""}
                {supplier.noRebatesAt ? ` on ${fmt(supplier.noRebatesAt)}` : ""}. Nothing here is outstanding.
              </p>
              {canManage && (
                <form action={setRebatesNone} className="mt-3">
                  <input type="hidden" name="none" value="0" />
                  <button className="btn btn-sm">They do pay rebates after all</button>
                </form>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-ink-2">
                If they send a monthly rebate report, upload it below and every ladder on it is filed with the arithmetic
                that checks it. Otherwise enter the ladder by hand.
              </p>
              {canManage && (
                <>
                  <form action={setRebatesNone} className="mt-3">
                    <input type="hidden" name="none" value="1" />
                    <button className="btn btn-sm">They pay no rebates</button>
                  </form>
                  <p className="mt-1 text-xs text-ink-3">
                    Says so once and for all, rather than leaving it looking like something nobody has got to yet. It
                    changes no figure — a supplier with no ladder is already compared at their gross prices.
                  </p>
                </>
              )}
            </>
          )}
        </Card>
      ) : (
        <div className="mt-4 space-y-4">
          {view.programmes.map((p) => (
            <ProgrammeCard key={p.id} p={p} canManage={canManage} supplierId={id} editing={edit === p.id} onRemove={removeProgram} />
          ))}
        </div>
      )}

      {/* ── 3. The proof ──────────────────────────────────────────────── */}
      {statement && (
        <Card
          className="mt-4"
          title="How you know it read the report right"
          subtitle={
            statement.periodFrom
              ? `The ${fmt(statement.periodFrom)} breakdown${statement.filedAt ? `, filed ${fmt(statement.filedAt.slice(0, 10))}` : ""}. Every figure below was checked against another figure on the same page — nothing was typed.`
              : "Every figure below was checked against another on the same page."
          }
        >
          <ul className="space-y-1 text-sm">
            {(statement.checks ?? []).map((c) => (
              <li key={c.what} className="flex gap-2">
                <span className={`badge ${c.ok ? "badge-ok" : "badge-crit"}`}>{c.ok ? "agrees" : "does not agree"}</span>
                <span className="text-ink-2">{c.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-3">
            {statement.tierCount ? `${statement.tierCount} bands were read off it. ` : ""}
            {statement.documentId ? (
              <a href={`/files/${statement.documentId}`} target="_blank" rel="noreferrer" className="text-accent underline">
                Open the report itself
              </a>
            ) : (
              "The report was not kept as a document — it arrived before that was recorded. Upload it below and it will be."
            )}
          </p>
        </Card>
      )}

      {/* ── 4. Send the report, rather than typing any of it ──────────── */}
      {canManage && (
        <Card className="mt-4" title="File a rebate report" subtitle="Every ladder, the achieved rate and the checks, off one PDF. The report is kept so the tiers can be compared with the page they came from.">
          <form action={readRebateReport} className="flex flex-wrap items-center gap-2">
            <input type="file" name="report" accept=".pdf" className="text-xs" />
            <SubmitButton className="btn btn-sm btn-primary" pendingLabel="Reading…">Read it and file the ladders</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-ink-3">
            Emailing it to the mailbox does the same thing without anybody opening this page. Nothing is stored from a
            report whose own figures do not agree with its own tier table.
          </p>
        </Card>
      )}

      {/* ── 5. Returns ────────────────────────────────────────────────── */}
      <Card
        className="mt-4"
        title="Return policy"
        subtitle={
          draft
            ? `Read from ${draft.fileName} and waiting for you. Nothing below is stored until you press Save.`
            : storedReturnTerms
              ? `${currentReturn!.name}, in force from ${fmt(currentReturn!.effectiveFrom)}.`
              : "Nothing on file, so nothing can tell you when a bottle has to go back."
        }
        actions={
          <>
            {currentReturn?.documentId && (
              <a href={`/files/${currentReturn.documentId}`} target="_blank" rel="noreferrer" className="btn btn-sm">Open the policy</a>
            )}
            {canManage && currentReturn && (
              <form action={removeProgram}>
                <input type="hidden" name="which" value={`policy:${currentReturn.id}`} />
                <button className="btn btn-sm">Remove</button>
              </form>
            )}
          </>
        }
      >
        {canManage && (
          <form action={readPolicy} className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-ground p-3">
            <span className="text-xs text-ink-2">Have the policy as a PDF? It is read, and kept.</span>
            <input type="file" name="policy" accept=".pdf" className="text-xs" />
            <SubmitButton className="btn btn-sm" pendingLabel="Reading…">Read the policy</SubmitButton>
          </form>
        )}
        {draft && (
          <div className="mb-3 rounded-md border border-accent bg-accent-soft p-3 text-xs">
            <p className="font-semibold text-accent">
              Read from {draft.fileName} — check each figure against its quote, then save below.
              {draft.documentId && (
                <>
                  {" "}
                  <a href={`/files/${draft.documentId}`} target="_blank" rel="noreferrer" className="underline">Open the PDF</a>
                </>
              )}
            </p>
            <ul className="mt-1 space-y-1 text-ink-2">
              {draft.quotes.map((q) => (
                <li key={q.field + q.sentence}><b>{q.field}:</b> &ldquo;{q.sentence}&rdquo;</li>
              ))}
            </ul>
            {draft.unclear.length > 0 && (
              <p className="mt-2 text-warn">Not settled by the policy: {draft.unclear.join("; ")}. Those are left empty rather than guessed.</p>
            )}
          </div>
        )}
        {storedReturnTerms && !draft && (
          <>
            <p className="text-sm">{describeReturns(storedReturnTerms)}</p>
            {storedReturnTerms.creditStepsFromInvoice.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="table max-w-md">
                  <thead><tr><th>Raised within</th><th className="text-right">Credit</th></tr></thead>
                  <tbody>
                    {storedReturnTerms.creditStepsFromInvoice.map((s, i) => (
                      <tr key={i}>
                        <td>{s.withinDays === null ? "After that" : `${s.withinDays} days of the invoice`}</td>
                        <td className="num">{s.creditPercent}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-xs text-ink-3">
                  This is the clock the site counts down. Expiry does not enter into it — a bottle bought last week and
                  not wanted goes back on the invoice&rsquo;s clock.
                </p>
              </div>
            )}
            {storedReturnTerms.reverseDistributor && <p className="mt-1 text-xs text-ink-3">Outside the window: {storedReturnTerms.reverseDistributor}.</p>}
          </>
        )}
        {returns.length > 1 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-ink-3">Earlier policies ({returns.length - 1})</summary>
            <ul className="mt-1 space-y-1">
              {returns.filter((r) => r.id !== currentReturn?.id).map((r) => {
                const t = readReturnTerms(r.termsJson);
                return (
                  <li key={r.id}>
                    <b>{r.name}</b> · {fmt(r.effectiveFrom)} to {r.effectiveTo ? fmt(r.effectiveTo) : "open"} · {t ? describeReturns(t) : "terms no longer readable"}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
        {canManage && (
          <details className="mt-4" open={Boolean(draft)}>
            <summary className="cursor-pointer text-sm font-medium text-accent">
              {draft ? "Check what it read, then save" : storedReturnTerms ? "Change the return terms" : "Enter the return terms by hand"}
            </summary>
            <form action={saveReturns} className="mt-3 grid gap-3">
              <input type="hidden" name="documentId" value={draft?.documentId ?? currentReturn?.documentId ?? ""} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Policy name">
                  <input name="name" className="field" defaultValue={currentReturn?.name ?? (draft ? `${supplier.name} returned goods policy` : "Return policy")} />
                </Field>
                <Field label="Takes effect on">
                  <input name="effectiveFrom" type="date" required className="field" defaultValue={today} />
                </Field>
              </div>

              <fieldset className="rounded-md border border-line p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-3">The clock that starts at the invoice</legend>
                <p className="text-xs text-ink-2">
                  What the supplier credits when the return is raised within so many days of the invoice. Leave the days
                  blank on the last row to mean &ldquo;after every window above&rdquo;.
                </p>
                <div className="mt-2 space-y-1.5">
                  {rowsFor(returnTerms?.creditStepsFromInvoice ?? [], 3).map((s, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <input name="withinDays" type="number" min="0" className="field py-1.5 text-sm" placeholder="within days" defaultValue={s ? (s.withinDays ?? "") : ""} />
                      <span className="text-xs text-ink-3">credits</span>
                      <input name="creditAt" type="number" min="0" max="100" step="0.5" className="field py-1.5 text-sm" placeholder="%" defaultValue={s ? s.creditPercent : ""} />
                    </div>
                  ))}
                </div>
                <div className="mt-2">
                  <Field label="Nothing can be returned after this many days from the invoice" hint="Leave blank where the policy sets no final deadline.">
                    <input name="returnableWithin" type="number" min="0" className="field" defaultValue={returnTerms?.returnableWithinDaysOfInvoice ?? ""} placeholder="e.g. 180" />
                  </Field>
                </div>
              </fieldset>

              <details className="rounded-md border border-line p-3">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-ink-3">Expiry-dated returns, where the policy also has them</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Field label="Earliest: months before expiry" hint="Leave blank if the policy does not say.">
                    <input name="windowBefore" type="number" step="0.5" min="0" className="field" defaultValue={returnTerms?.windowMonthsBeforeExpiry ?? ""} placeholder="6" />
                  </Field>
                  <Field label="Latest: months after expiry" hint="0 means nothing after expiry.">
                    <input name="windowAfter" type="number" step="0.5" min="0" className="field" defaultValue={returnTerms?.windowMonthsAfterExpiry ?? ""} placeholder="6" />
                  </Field>
                </div>
                <Field
                  label="Credit steps by months to expiry"
                  hint='One per line: "6 -> 100%", "0 -> 50%". Negative months are after expiry.'
                >
                  <textarea
                    name="creditSteps"
                    rows={3}
                    className="field font-mono text-xs"
                    defaultValue={returnTerms ? returnTerms.creditSteps.map((s) => `${s.monthsToExpiryMin} -> ${s.creditPercent}%`).join("\n") : ""}
                  />
                </Field>
              </details>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Restocking fee, percent">
                  <input name="restockingFee" type="number" step="0.5" min="0" max="100" className="field" defaultValue={returnTerms?.restockingFeePercent ?? ""} />
                </Field>
                <Field label="Reverse distributor" hint="Who takes what the supplier will not.">
                  <input name="reverseDistributor" className="field" defaultValue={returnTerms?.reverseDistributor ?? ""} />
                </Field>
              </div>
              <Field label="Never returnable" hint="In the policy's words, one per line.">
                <textarea name="nonReturnable" rows={2} className="field text-xs" defaultValue={returnTerms?.nonReturnable.join("\n") ?? ""} placeholder={"refrigerated\ncontrolled Schedule II\npartial bottles"} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Anything else that changes what comes back">
                  <input name="termNotes" className="field" defaultValue={returnTerms?.notes ?? ""} />
                </Field>
                <Field label="Where this came from">
                  <input name="notes" className="field" defaultValue={currentReturn?.notes ?? ""} />
                </Field>
              </div>
              <div><button className="btn btn-primary">Save return policy</button></div>
            </form>
          </details>
        )}
      </Card>

      {/* ── 6. Adding or correcting a ladder by hand ──────────────────── */}
      {canManage && (
        <Card
          className="mt-4"
          id="edit"
          title={editing ? `Change “${editing.name}”` : "Add a rebate programme by hand"}
          subtitle={
            editing
              ? `In force from ${fmt(editing.effectiveFrom)}. Saving under the same name from a later date closes this one and starts a new version; the old one is kept, because a rebate paid last quarter was earned under last quarter's ladder.`
              : "For a supplier who sends no report. One row per band: the ratio it starts at, and what every eligible purchase then earns."
          }
          actions={editing ? <Link href={`/suppliers/${id}/terms`} className="btn btn-sm">New programme instead</Link> : undefined}
        >
          <form action={saveRebate} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Programme name" hint="As the supplier calls it. Two programmes with different names can both be in force.">
                <input name="name" required className="field" defaultValue={editing?.name ?? ""} placeholder="OneStop generics" />
              </Field>
              <Field label="Takes effect on">
                <input name="effectiveFrom" type="date" required className="field" defaultValue={editing?.effectiveFrom ?? today} />
              </Field>
              <Field label="What it pays on" hint="This decides which invoice lines get the discount.">
                <select name="eligibility" className="field" defaultValue={editingTerms?.eligibility ?? "catalog_rebate_flag"}>
                  <option value="catalog_rebate_flag">Contract items only — the ones the catalogue marks rebated</option>
                  <option value="all_generics">Every generic, contract or not</option>
                  <option value="brand_purchases">Brand-name items only</option>
                  <option value="all_purchases">Everything bought from this supplier</option>
                </select>
              </Field>
              <Field label="Which figure picks the band" hint="So the site can mark the band you are actually in.">
                <select name="ratioMeasure" className="field" defaultValue={editingTerms?.ratioMeasure ?? ""}>
                  <option value="">Not stated</option>
                  <option value="generic_compliance">The scrubbed generic compliance rate</option>
                  <option value="generic_purchase_ratio">The generic purchase ratio</option>
                </select>
              </Field>
              <Field label="Measured and paid">
                <select name="period" className="field" defaultValue={editingTerms?.period ?? "quarter"}>
                  <option value="month">Monthly</option>
                  <option value="quarter">Quarterly</option>
                  <option value="year">Annually</option>
                </select>
              </Field>
              <Field label="Paid as">
                <input name="paidAs" className="field" defaultValue={editingTerms?.paidAs ?? ""} placeholder="Credit memo the month after quarter end" />
              </Field>
            </div>

            {/*
              The bands, as a grid.

              They were a block of text with arrows in it, which is neither how anybody reads a
              ladder nor how anybody checks one. A row per band, the threshold beside what it pays,
              and a blank row means nothing — so removing a band is clearing two boxes.
            */}
            <fieldset className="rounded-md border border-line p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-3">The bands</legend>
              <p className="text-xs text-ink-2">
                Not cumulative: the measured ratio lands in one band and every eligible purchase earns that band&rsquo;s
                rate. A flat programme is one row starting at 0. Clear both boxes on a row to remove that band.
              </p>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {rowsFor(editingTerms?.tiers ?? [], 4).map((t, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <input name="threshold" type="number" step="0.01" min="0" max="100" className="field py-1.5 text-sm" placeholder="from %" defaultValue={t ? t.thresholdPercent : ""} />
                    <span className="text-xs text-ink-3">pays</span>
                    <input name="rebate" type="number" step="0.01" min="0" max="100" className="field py-1.5 text-sm" placeholder="%" defaultValue={t ? t.rebatePercent : ""} />
                  </div>
                ))}
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-ink-3">Or paste a whole ladder</summary>
                <textarea
                  name="pasted"
                  rows={4}
                  className="field mt-1 font-mono text-xs"
                  placeholder={"0% -> 15%\n9% -> 20%\n13% -> 24%"}
                />
                <p className="mt-1 text-xs text-ink-3">Anything pasted here is used instead of the rows above.</p>
              </details>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="How the supplier defines the ratio" hint="Their words: what is in it, what is excluded.">
                <input name="ratioDefinition" className="field" defaultValue={editingTerms?.ratioDefinition ?? ""} />
              </Field>
              <Field label="Anything else that changes the money">
                <input name="termNotes" className="field" defaultValue={editingTerms?.notes ?? ""} placeholder="Minimum commitments, promotional windows, exclusions" />
              </Field>
            </div>
            <Field label="Where these numbers came from" hint="The document name, or who confirmed them.">
              <input name="notes" className="field" defaultValue={editing?.notes ?? ""} />
            </Field>
            <div><button className="btn btn-primary">{editing ? "Save this version" : "Add the programme"}</button></div>
          </form>
        </Card>
      )}

      {superseded.length > 0 && (
        <Card className="mt-4" title="Superseded schedules" count={superseded.length} subtitle="Kept, because a rebate paid last quarter was earned under last quarter's ladder.">
          <ul className="rows text-sm">
            {superseded.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <b>{r.name}</b> <span className="text-ink-3">· {fmt(r.effectiveFrom)} to {r.effectiveTo ? fmt(r.effectiveTo) : "open"}</span>
                </span>
                {canManage && (
                  <form action={removeProgram}>
                    <input type="hidden" name="which" value={r.id} />
                    <button className="btn btn-sm">Remove</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="mt-4 text-xs text-ink-3">
        Prices, invoices and these terms all hang off this supplier. If a catalogue arrives under a different spelling,{" "}
        <Link href={`/suppliers?edit=${supplier.id}#edit`} className="text-accent hover:underline">record that spelling as the catalogue name</Link>{" "}
        so it is filed here too.
      </p>
    </>
  );
}

/** Existing values plus a few blanks, so a form can add rows without any script. */
function rowsFor<T>(existing: T[], spare: number): (T | null)[] {
  return [...existing, ...Array.from({ length: spare }, () => null)];
}

function Headline({ value, label, sub, hideWhenNull }: { value: number | null; label: string; sub: string; hideWhenNull?: boolean }) {
  if (value === null && hideWhenNull) return null;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className={`text-3xl font-bold leading-none tabular-nums ${value ? "text-accent" : "text-ink-3"}`}>
        {value === null ? "—" : `${value}%`}
      </div>
      <div className="mt-2 text-sm font-semibold">{label}</div>
      <div className="mt-0.5 text-xs text-ink-3">{value === null ? "Nothing on file says what this earns" : sub}</div>
    </div>
  );
}

/**
 * One ladder, with the band the pharmacy is in marked.
 *
 * Eleven rows of percentages with nothing marked is a table nobody reads twice. The row that
 * applies is the answer; everything above it is what the money would be worth, and everything
 * below is what it used to be.
 */
function ProgrammeCard({
  p,
  canManage,
  supplierId,
  editing,
  onRemove,
}: {
  p: ProgrammeView;
  canManage: boolean;
  supplierId: string;
  editing: boolean;
  onRemove: (fd: FormData) => Promise<void>;
}) {
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <Card
      id={p.id}
      tone={p.rateNow ? "ok" : p.rateNow === 0 ? "warn" : undefined}
      title={p.name}
      subtitle={p.headline}
      actions={
        canManage ? (
          <>
            {!editing && (
              <Link href={`/suppliers/${supplierId}/terms?edit=${p.id}#edit`} className="btn btn-sm">Change it</Link>
            )}
            <form action={onRemove}>
              <input type="hidden" name="which" value={p.id} />
              <button className="btn btn-sm" title="Removes this ladder outright. Use it for a duplicate or something filed by mistake.">
                Remove
              </button>
            </form>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="badge badge-muted">Pays on {p.paysOnShort.toLowerCase()}</span>
        {p.measuredBy && (
          <span className="badge badge-muted">
            Band set by {p.measuredBy}
            {p.achievedPercent !== null ? `: ${p.achievedPercent}%` : " — not read yet"}
          </span>
        )}
        <span className="text-ink-3">In force from {fmt(p.effectiveFrom)}</span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="table max-w-lg">
          <thead>
            <tr>
              <th>Band</th>
              <th className="text-right">Pays</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {p.bands.map((b) => (
              <tr key={b.fromPercent} className={b.current ? "font-semibold" : undefined}>
                <td>{b.toPercent === null ? `${b.fromPercent}% and above` : `${b.fromPercent}% – ${b.toPercent}%`}</td>
                <td className="num">{b.rebatePercent}%</td>
                <td className="w-24">{b.current && <span className="badge badge-ok">you are here</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 space-y-1 text-xs text-ink-2">
        {p.basisCents !== null && p.earnedCents !== null && (
          <p>
            Paid {money(p.earnedCents)} last period, on {money(p.basisCents)} of {p.paysOn}.
          </p>
        )}
        {p.next && (
          <p>
            {p.next.rebatePercent > (p.rateNow ?? 0)
              ? `The next band starts at ${p.next.fromPercent}% — ${p.next.shortByPercent} points away — and pays ${p.next.rebatePercent}%${p.next.worthCents ? `, worth ${money(p.next.worthCents)} more on last period's buying` : ""}.`
              : `The next band starts at ${p.next.fromPercent}% and pays the same ${p.next.rebatePercent}%, so moving up earns nothing here.`}
          </p>
        )}
        {p.terms.ratioDefinition && <p className="text-ink-3">Ratio: {p.terms.ratioDefinition}</p>}
        {p.terms.notes && <p className="text-ink-3">{p.terms.notes}</p>}
      </div>
    </Card>
  );
}

export type { ReturnTermsT };
