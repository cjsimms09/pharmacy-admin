import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { categories, vendors, recentExpenses, unpaid, missingThisMonth, seedCategories, addCategory, saveVendor, saveExpense, setExpenseStatus, expenseById, voidExpense } from "@/lib/expenses";
import { formatCents } from "@/lib/money";
import { fmt, todayIso } from "@/lib/dates";
import { PageHeader, Notice, Empty, Card, Figure, Field } from "@/components/ui";
import { allStandingCosts, addStandingCost, endStandingCost, deleteStandingCost, standingLines } from "@/lib/standing-costs";
import { parseCents } from "@/lib/money";
import { ExportData } from "@/components/export-data";
import { SubmitButton } from "@/components/submit-button";
import { ConfirmButton } from "@/components/confirm-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Spending" };

const KIND_LABEL: Record<string, string> = {
  operating: "Overhead",
  cost_of_goods: "Cost of goods",
  revenue_offset: "Taken back out of revenue",
};

/**
 * What the pharmacy spends, and the rules that file it next time.
 *
 * Everything else on this site measures what dispensing earns. This is the other half: a pharmacy
 * can hold a healthy margin on every script and still lose money, because that margin pays wages,
 * rent, software, postage and a card processor before any of it is profit.
 *
 * The rule lives on the vendor rather than in a rules screen of its own, because the thing somebody
 * wants to say is "bills from Stamps.com are postage" — a fact about Stamps.com.
 */
export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; edit?: string }> }) {
  await requireUser();
  const { ok, error, edit } = await searchParams;

  // Standard chart of accounts on first visit. An empty one gets filled badly.
  await seedCategories();

  const [cats, vend, recent, owed, missing, editing, standingAll] = await Promise.all([
    categories(),
    vendors(),
    recentExpenses(100),
    unpaid(),
    missingThisMonth(),
    edit ? expenseById(edit) : Promise.resolve(null),
    allStandingCosts(),
  ]);
  const month = todayIso().slice(0, 7);
  const standingNow = standingLines(standingAll, month, todayIso(), recent.filter((e) => e.status === "confirmed" && e.invoiceDate.startsWith(month)));

  /*
   * A cost the same every month, known before its bill: payroll, rent, the loan.
   *
   * Typed once, with the month it starts. The account carries the month's share of it by the day,
   * so the month-to-date figure is not flattered by the bills that have not come, and drops it the
   * moment the vendor's real bill for the month is entered.
   */
  async function addStanding(form: FormData) {
    "use server";
    const u = await requireManager();
    const name = String(form.get("name") ?? "").trim();
    const amountCents = parseCents(String(form.get("amount") ?? ""));
    const fromMonth = String(form.get("fromMonth") ?? "").trim();
    const toMonth = String(form.get("toMonth") ?? "").trim() || null;
    if (!name) redirect("/expenses?error=" + encodeURIComponent("Give the cost a name."));
    if (amountCents === null || amountCents <= 0) redirect("/expenses?error=" + encodeURIComponent("Put the month's figure in dollars."));
    if (!/^\d{4}-\d{2}$/.test(fromMonth)) redirect("/expenses?error=" + encodeURIComponent("Say which month it starts, as YYYY-MM."));
    if (toMonth && !/^\d{4}-\d{2}$/.test(toMonth)) redirect("/expenses?error=" + encodeURIComponent("The last month must be YYYY-MM, or blank while it runs."));
    const id = await addStandingCost(
      { name, amountCents, categoryId: String(form.get("categoryId") ?? "") || null, vendorId: String(form.get("vendorId") ?? "") || null, fromMonth, toMonth, notes: String(form.get("notes") ?? "").trim() || null },
      u,
    );
    await audit({ action: "standing_cost.add", userId: u.id, userName: u.name, entity: "standing_cost", entityId: id, details: `${name} ${formatCents(amountCents)} a month from ${fromMonth}` });
    revalidatePath("/expenses");
    revalidatePath("/money");
    revalidatePath("/money/monthly");
    redirect("/expenses?ok=" + encodeURIComponent(`${name} is on the account at ${formatCents(amountCents)} a month, by the day.`));
  }

  async function endStanding(form: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(form.get("id") ?? "");
    const lastMonth = String(form.get("lastMonth") ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(lastMonth)) redirect("/expenses?error=" + encodeURIComponent("Say the last month it applies to, as YYYY-MM."));
    await endStandingCost(id, lastMonth);
    await audit({ action: "standing_cost.end", userId: u.id, userName: u.name, entity: "standing_cost", entityId: id, details: `ends ${lastMonth}` });
    revalidatePath("/expenses");
    revalidatePath("/money");
    redirect("/expenses?ok=" + encodeURIComponent(`Ended after ${lastMonth}; earlier months keep it.`));
  }

  async function removeStanding(form: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(form.get("id") ?? "");
    await deleteStandingCost(id);
    await audit({ action: "standing_cost.delete", userId: u.id, userName: u.name, entity: "standing_cost", entityId: id });
    revalidatePath("/expenses");
    revalidatePath("/money");
    redirect("/expenses?ok=" + encodeURIComponent("Removed from every month."));
  }

  async function addBill(form: FormData) {
    "use server";
    const u = await requireManager();
    const amount = Number(String(form.get("amount") ?? "").replace(/[$,\s]/g, ""));
    // Editing keeps the bill's standing and where it came from; only the facts on it change.
    const id = String(form.get("id") ?? "") || null;
    const existing = id ? await expenseById(id) : null;
    if (id && !existing) redirect("/expenses?error=" + encodeURIComponent("That bill is no longer on file."));
    try {
      await saveExpense({
        id,
        status: existing?.status,
        source: existing?.source,
        documentId: existing?.documentId,
        notes: existing?.notes,
        vendorId: String(form.get("vendorId") ?? "") || null,
        categoryId: String(form.get("categoryId") ?? "") || null,
        invoiceNumber: String(form.get("invoiceNumber") ?? ""),
        invoiceDate: String(form.get("invoiceDate") ?? ""),
        paidOn: String(form.get("paidOn") ?? "") || null,
        amountCents: Math.round(amount * 100),
        description: String(form.get("description") ?? ""),
        createdBy: u.name,
      });
      await audit({ action: id ? "expense.edit" : "expense.add", userId: u.id, userName: u.name, details: `${id ?? "new"} ${amount}` });
    } catch (e) {
      redirect("/expenses?error=" + encodeURIComponent(e instanceof Error ? e.message : String(e)));
    }
    revalidatePath("/expenses");
    revalidatePath("/money/monthly");
    redirect("/expenses?ok=" + encodeURIComponent(id ? "Bill updated." : "Bill recorded."));
  }

  async function voidBill(form: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(form.get("id") ?? "");
    const existing = await expenseById(id);
    if (!existing) redirect("/expenses?error=" + encodeURIComponent("That bill is no longer on file."));
    await voidExpense(id);
    await audit({ action: "expense.void", userId: u.id, userName: u.name, details: `${id} ${existing.amountCents / 100} ${existing.description ?? ""}` });
    revalidatePath("/expenses");
    revalidatePath("/money/monthly");
    redirect("/expenses?ok=" + encodeURIComponent("Bill voided. It counts on no month now; the record is kept."));
  }

  async function addVendor(form: FormData) {
    "use server";
    const u = await requireManager();
    try {
      await saveVendor({
        id: String(form.get("id") ?? "") || null,
        name: String(form.get("name") ?? ""),
        senderEmails: String(form.get("senderEmails") ?? ""),
        categoryId: String(form.get("categoryId") ?? "") || null,
        cadence: (String(form.get("cadence") ?? "irregular") as "monthly" | "quarterly" | "annual" | "irregular"),
      });
      await audit({ action: "vendor.save", userId: u.id, userName: u.name, details: String(form.get("name") ?? "") });
    } catch (e) {
      redirect("/expenses?error=" + encodeURIComponent(e instanceof Error ? e.message : String(e)));
    }
    revalidatePath("/expenses");
    redirect("/expenses?ok=" + encodeURIComponent("Vendor saved. Bills from those addresses will file themselves here."));
  }

  async function newCategory(form: FormData) {
    "use server";
    const u = await requireManager();
    await addCategory({
      name: String(form.get("name") ?? ""),
      kind: String(form.get("kind") ?? "operating") as "operating" | "cost_of_goods" | "revenue_offset",
      notes: String(form.get("notes") ?? ""),
    });
    await audit({ action: "expense.category", userId: u.id, userName: u.name, details: String(form.get("name") ?? "") });
    revalidatePath("/expenses");
    redirect("/expenses?ok=" + encodeURIComponent("Category added."));
  }

  async function confirmDraft(form: FormData) {
    "use server";
    await requireManager();
    await setExpenseStatus(String(form.get("id") ?? ""), "confirmed");
    revalidatePath("/expenses");
    revalidatePath("/money/monthly");
    redirect("/expenses?ok=" + encodeURIComponent("Confirmed, and it now counts on the month."));
  }

  const byId = new Map(cats.map((c) => [c.id, c]));
  const vendorById = new Map(vend.map((v) => [v.id, v]));
  const drafts = recent.filter((r) => r.status === "draft");
  const owedCents = owed.reduce((n, e) => n + e.amountCents, 0);
  const thisMonth = recent.filter((e) => e.status === "confirmed" && e.invoiceDate.startsWith(todayIso().slice(0, 7)));

  return (
    <>
      <PageHeader
        title="Spending"
        subtitle="What the pharmacy pays out, filed against the month it belongs to."
        actions={<Link href="/money/monthly" className="btn btn-primary">Monthly profit and loss</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          value={formatCents(thisMonth.reduce((n, e) => n + e.amountCents, 0))}
          label="Billed this month"
          sub={`${thisMonth.length} ${thisMonth.length === 1 ? "bill" : "bills"}`}
          tone="muted"
        />
        <Figure
          value={formatCents(owedCents)}
          label="Owed and unpaid"
          sub={owed.length ? `${owed.length} ${owed.length === 1 ? "bill" : "bills"}` : "Nothing outstanding"}
          tone={owedCents ? "warn" : "ok"}
        />
        <Figure
          value={drafts.length}
          label="Waiting to be confirmed"
          sub={drafts.length ? "Read from an email, not yet agreed with" : "Nothing pending"}
          tone={drafts.length ? "warn" : "ok"}
        />
        <Figure
          value={missing.length}
          label="Expected, not arrived"
          sub={missing.length ? "Monthly bills that have not come" : "Every monthly bill is in"}
          tone={missing.length ? "warn" : "ok"}
        />
      </div>

      {/*
        A bill that was expected and did not come does not announce itself. The month simply looks
        cheaper than it was, and the profit figure is wrong in the flattering direction — which is
        the direction nobody questions.
      */}
      {missing.length > 0 && (
        <Notice kind="warn">
          <b>{missing.length} vendor{missing.length === 1 ? "" : "s"} bill every month and have not this month:</b>{" "}
          {missing.map((m) => `${m.vendor.name}${m.lastSeen ? ` (last ${fmt(m.lastSeen)})` : ""}`).join(", ")}. Until they
          are in, this month looks cheaper than it was.
        </Notice>
      )}

      {drafts.length > 0 && (
        <Notice kind="warn">
          <b>{drafts.length} bill{drafts.length === 1 ? "" : "s"} read from an email and not yet confirmed.</b> Reading an
          amount off a PDF is a guess with a number attached, so nothing counts on the month until somebody agrees with
          it.
        </Notice>
      )}

      {/* ── The bills ────────────────────────────────────────────────────── */}
      {/*
        The list first, and the forms below it.

        This page opened with three collapsed panels of machinery — record a bill, vendors, categories
        — and the thing somebody came to see was under all of it. What is spent is the page; the rules
        that file it are the settings for the page.
      */}
      <Card
        className="mt-4"
        title="Bills"
        count={recent.length}
        subtitle="Most recently invoiced first. A bill read from an email counts on the month only once somebody has agreed with the amount."
      >
        {recent.length === 0 ? (
          <Empty>
            Nothing recorded yet. Add a vendor below with the address its invoices come from, and they will start filing
            themselves.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Invoiced</th>
                  <th>Vendor</th>
                  <th>Category</th>
                  <th>For</th>
                  <th className="num">Amount</th>
                  <th>Paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-xs">{fmt(e.invoiceDate)}</td>
                    <td className="font-medium">{e.vendorId ? (vendorById.get(e.vendorId)?.name ?? "—") : "—"}</td>
                    <td className="text-xs">
                      {e.categoryId ? (byId.get(e.categoryId)?.name ?? "—") : <span className="badge badge-warn">uncategorised</span>}
                    </td>
                    <td className="text-xs text-ink-2">{e.description ?? "—"}</td>
                    <td className="num">{formatCents(e.amountCents)}</td>
                    <td className="text-xs">{e.paidOn ? fmt(e.paidOn) : <span className="badge badge-warn">owed</span>}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        {e.status === "draft" && (
                          <form action={confirmDraft}>
                            <input type="hidden" name="id" value={e.id} />
                            <SubmitButton className="btn btn-sm btn-primary" pendingLabel="…">Confirm</SubmitButton>
                          </form>
                        )}
                        <Link href={`/expenses?edit=${e.id}#bill`} className="btn btn-sm">Edit</Link>
                        <form action={voidBill}>
                          <input type="hidden" name="id" value={e.id} />
                          <ConfirmButton
                            className="btn btn-sm btn-danger"
                            message={`Void this bill of ${formatCents(e.amountCents)}? It will stop counting on the month. The record is kept, marked void.`}
                          >
                            Void
                          </ConfirmButton>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Record a bill ────────────────────────────────────────────────── */}
      <Card
        id="bill"
        className="mt-4"
        title={editing ? "Edit this bill" : "Record a bill"}
        subtitle="Two dates, because there are two honest answers to “when was this a cost”. The invoice date is when the pharmacy incurred it; the paid date is when the money left. A month’s profit differs between the two and both are true."
      >
        <form key={editing?.id ?? "new"} action={addBill} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <Field label="Vendor">
            <select name="vendorId" defaultValue={editing?.vendorId ?? ""} className="w-full">
              <option value="">—</option>
              {vend.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select name="categoryId" defaultValue={editing?.categoryId ?? ""} className="w-full">
              <option value="">—</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Amount">
            <input name="amount" inputMode="decimal" placeholder="129.00" defaultValue={editing ? (editing.amountCents / 100).toFixed(2) : ""} className="w-full" />
          </Field>
          <Field label="Invoiced on">
            <input type="date" name="invoiceDate" defaultValue={editing?.invoiceDate ?? todayIso()} className="w-full" />
          </Field>
          <Field label="Paid on" hint="Leave blank if it is still owed.">
            <input type="date" name="paidOn" defaultValue={editing?.paidOn ?? ""} className="w-full" />
          </Field>
          <Field label="Invoice number">
            <input name="invoiceNumber" defaultValue={editing?.invoiceNumber ?? ""} className="w-full" />
          </Field>
          <Field label="What it was for" className="sm:col-span-2">
            <input name="description" defaultValue={editing?.description ?? ""} className="w-full" />
          </Field>
          <div className="flex items-end gap-2">
            <SubmitButton className="btn btn-primary" pendingLabel="Saving…">{editing ? "Save changes" : "Record it"}</SubmitButton>
            {editing && <Link href="/expenses" className="btn">Cancel</Link>}
          </div>
        </form>
      </Card>

      {/* ── Standing costs ──────────────────────────────────────────────── */}
      <Card
        className="mt-4"
        title="Standing monthly costs"
        count={standingAll.length}
        subtitle={`Payroll, rent, the loan: the same every month and known before the bill. The account carries each month's share by the day — ${formatCents(3_000_000)} a month is ${formatCents(1_000_000)} by the 10th — and drops it when the vendor's real bill for the month is entered.`}
      >
        {standingNow.length > 0 && (
          <div className="mb-4 overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Cost</th><th>Category</th><th className="num">A month</th><th className="num">So far this month</th><th>Runs</th><th></th></tr>
              </thead>
              <tbody>
                {standingNow.map((l) => {
                  const c = standingAll.find((x) => x.id === l.id)!;
                  const cat = cats.find((x) => x.id === l.categoryId);
                  return (
                    <tr key={l.id}>
                      <td className="font-medium">{l.name}{l.replacedByBill && <span className="badge badge-muted ml-2">real bill in, not counted</span>}</td>
                      <td className="text-xs text-ink-2">{cat?.name ?? "—"}</td>
                      <td className="num">{formatCents(l.amountCents)}</td>
                      <td className="num">{l.replacedByBill ? "—" : formatCents(l.accruedCents)} <span className="text-xs text-ink-3">day {l.days} of {l.of}</span></td>
                      <td className="text-xs text-ink-2">{c.fromMonth} → {c.toMonth ?? "open"}</td>
                      <td className="whitespace-nowrap">
                        <form action={endStanding} className="inline-flex items-center gap-1">
                          <input type="hidden" name="id" value={c.id} />
                          <input type="month" name="lastMonth" defaultValue={month} aria-label="Last month" className="w-auto py-0.5 text-xs" />
                          <button className="btn btn-sm">End</button>
                        </form>
                        <form action={removeStanding} className="ml-1 inline">
                          <input type="hidden" name="id" value={c.id} />
                          <button className="btn btn-sm btn-danger">Delete</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {standingAll.length > standingNow.length && (
          <p className="mb-3 text-xs text-ink-3">{standingAll.length - standingNow.length} more not in force this month (ended, or starting later).</p>
        )}
        <form action={addStanding} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Cost" className="lg:col-span-2">
            <input name="name" placeholder="Payroll" required className="w-full" />
          </Field>
          <Field label="A month, in dollars">
            <input name="amount" inputMode="decimal" placeholder="30000.00" required className="w-full" />
          </Field>
          <Field label="Category">
            <select name="categoryId" className="w-full">
              <option value="">—</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Vendor" hint="Its real bill for a month replaces this.">
            <select name="vendorId" className="w-full">
              <option value="">—</option>
              {vend.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
          <Field label="From month">
            <input type="month" name="fromMonth" defaultValue={month} required className="w-full" />
          </Field>
          <Field label="Last month" hint="Blank while it runs." className="lg:col-span-2">
            <input type="month" name="toMonth" className="w-full" />
          </Field>
          <Field label="Notes" className="sm:col-span-2 lg:col-span-3">
            <input name="notes" className="w-full" />
          </Field>
          <div className="flex items-end"><button className="btn btn-primary">Add standing cost</button></div>
        </form>
      </Card>

      {/* ── Vendors and their rules ──────────────────────────────────────── */}
      <Card
        className="mt-4"
        title="Vendors, and the rules that file their bills"
        count={vend.length}
        subtitle="Give a vendor the addresses its invoices arrive from and the category they belong in, and the next one files itself. Say it bills monthly and a month it does not arrive becomes visible."
      >
        {vend.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Files as</th>
                  <th>Bills from</th>
                  <th>How often</th>
                </tr>
              </thead>
              <tbody>
                {vend.map((v) => (
                  <tr key={v.id}>
                    <td className="font-medium">{v.name}</td>
                    <td className="text-xs">
                      {v.categoryId ? (byId.get(v.categoryId)?.name ?? "—") : <span className="badge badge-warn">no rule</span>}
                    </td>
                    <td className="font-mono text-[11px] text-ink-3">{v.senderEmails || "—"}</td>
                    <td className="text-xs">{v.cadence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form action={addVendor} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name">
            <input name="name" placeholder="Stamps.com" className="w-full" />
          </Field>
          <Field label="Bills arrive from" hint="One address, or several separated by commas.">
            <input name="senderEmails" placeholder="billing@stamps.com" className="w-full" />
          </Field>
          <Field label="Files as">
            <select name="categoryId" className="w-full">
              <option value="">Category…</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="How often">
            <div className="flex gap-2">
              <select name="cadence" className="flex-1">
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="irregular">Irregular</option>
              </select>
              <SubmitButton className="btn" pendingLabel="…">Add</SubmitButton>
            </div>
          </Field>
        </form>
      </Card>

      {/* ── Categories ───────────────────────────────────────────────────── */}
      <Card
        className="mt-4"
        title="Categories"
        count={cats.length}
        subtitle="The kind matters more than the name: it decides where a figure lands on the account. A cost put on the wrong side of gross profit moves money between two totals without changing either, which reads like a rounding difference and is not."
      >
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {cats.map((c) => (
            <li key={c.id} className="flex items-baseline gap-2 text-sm">
              <span className="badge badge-muted shrink-0">{KIND_LABEL[c.kind]}</span>
              <span>{c.name}</span>
            </li>
          ))}
        </ul>
        <form action={newCategory} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name">
            <input name="name" placeholder="New category" className="w-full" />
          </Field>
          <Field label="Kind">
            <select name="kind" className="w-full">
              <option value="operating">Overhead</option>
              <option value="cost_of_goods">Cost of goods</option>
              <option value="revenue_offset">Taken back out of revenue</option>
            </select>
          </Field>
          <Field label="What belongs in it" className="lg:col-span-2">
            <div className="flex gap-2">
              <input name="notes" placeholder="Postage, shipping supplies" className="flex-1" />
              <SubmitButton className="btn" pendingLabel="…">Add</SubmitButton>
            </div>
          </Field>
        </form>
      </Card>

      <ExportData page="expenses" className="mt-6" />
    </>
  );
}
