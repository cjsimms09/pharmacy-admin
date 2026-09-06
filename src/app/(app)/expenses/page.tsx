import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { categories, vendors, recentExpenses, unpaid, missingThisMonth, seedCategories, addCategory, saveVendor, saveExpense, setExpenseStatus, expenseById, voidExpense } from "@/lib/expenses";
import { formatCents } from "@/lib/money";
import { fmt, todayIso } from "@/lib/dates";
import { PageHeader, Notice, Empty } from "@/components/ui";
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

  const [cats, vend, recent, owed, missing, editing] = await Promise.all([
    categories(),
    vendors(),
    recentExpenses(100),
    unpaid(),
    missingThisMonth(),
    edit ? expenseById(edit) : Promise.resolve(null),
  ]);

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

      <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Billed this month" value={formatCents(thisMonth.reduce((n, e) => n + e.amountCents, 0))} sub={`${thisMonth.length} bills`} />
        <Stat label="Owed and unpaid" value={formatCents(owedCents)} sub={owed.length ? `${owed.length} bills` : "nothing outstanding"} tone={owedCents ? "warn" : undefined} />
        <Stat label="Waiting to be confirmed" value={String(drafts.length)} sub={drafts.length ? "read from an email" : "nothing pending"} tone={drafts.length ? "warn" : undefined} />
        <Stat label="Expected, not arrived" value={String(missing.length)} sub={missing.length ? "monthly bills missing" : "every monthly bill is in"} tone={missing.length ? "warn" : undefined} />
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

      {/* ── Record a bill ────────────────────────────────────────────────── */}
      <details id="bill" className="my-4 rounded-lg border border-line bg-surface p-4" open={recent.length === 0 || !!editing}>
        <summary className="cursor-pointer text-sm font-semibold">{editing ? "Edit this bill" : "Record a bill"}</summary>
        <form action={addBill} className="mt-3 grid gap-2 sm:grid-cols-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <label className="text-xs">
            <span className="block text-ink-3">Vendor</span>
            <select name="vendorId" defaultValue={editing?.vendorId ?? ""} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-sm">
              <option value="">—</option>
              {vend.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">Category</span>
            <select name="categoryId" defaultValue={editing?.categoryId ?? ""} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-sm">
              <option value="">—</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">Amount</span>
            <input name="amount" inputMode="decimal" placeholder="129.00" defaultValue={editing ? (editing.amountCents / 100).toFixed(2) : ""} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">Invoiced on</span>
            <input type="date" name="invoiceDate" defaultValue={editing?.invoiceDate ?? todayIso()} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">Paid on <span className="text-ink-3">(blank if still owed)</span></span>
            <input type="date" name="paidOn" defaultValue={editing?.paidOn ?? ""} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">Invoice number</span>
            <input name="invoiceNumber" defaultValue={editing?.invoiceNumber ?? ""} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="block text-ink-3">What it was for</span>
            <input name="description" defaultValue={editing?.description ?? ""} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <div className="flex items-end gap-2">
            <SubmitButton className="btn btn-primary" pendingLabel="Saving…">{editing ? "Save changes" : "Record it"}</SubmitButton>
            {editing && <Link href="/expenses" className="btn">Cancel</Link>}
          </div>
        </form>
        <p className="mt-2 text-xs text-ink-3">
          Two dates because there are two honest answers to &ldquo;when was this a cost&rdquo;. The invoice date is when
          the pharmacy incurred it; the paid date is when the money left. A month&rsquo;s profit differs between the two
          and both are true.
        </p>
      </details>

      {/* ── Vendors and their rules ──────────────────────────────────────── */}
      <details className="my-4 rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">Vendors and email rules — {vend.length} on file</summary>
        <p className="mt-1 text-xs text-ink-3">
          Give a vendor the addresses its invoices arrive from and the category they belong in, and the next one files
          itself. Say it bills monthly and a month it does not arrive becomes visible.
        </p>
        {vend.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">Vendor</th>
                  <th className="px-3 py-2">Files as</th>
                  <th className="px-3 py-2">Bills from</th>
                  <th className="px-3 py-2">How often</th>
                </tr>
              </thead>
              <tbody>
                {vend.map((v) => (
                  <tr key={v.id} className="border-t border-line">
                    <td className="px-3 py-2 font-medium">{v.name}</td>
                    <td className="px-3 py-2 text-xs">{v.categoryId ? (byId.get(v.categoryId)?.name ?? "—") : <span className="text-warn">no rule</span>}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{v.senderEmails || "—"}</td>
                    <td className="px-3 py-2 text-xs">{v.cadence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form action={addVendor} className="mt-3 grid gap-2 sm:grid-cols-4">
          <input name="name" placeholder="Stamps.com" className="rounded-md border border-line px-2 py-1 text-sm" />
          <input name="senderEmails" placeholder="billing@stamps.com" className="rounded-md border border-line px-2 py-1 text-sm" />
          <select name="categoryId" className="rounded-md border border-line px-2 py-1 text-sm">
            <option value="">Category…</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <select name="cadence" className="flex-1 rounded-md border border-line px-2 py-1 text-sm">
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
              <option value="irregular">Irregular</option>
            </select>
            <SubmitButton className="btn" pendingLabel="…">Add</SubmitButton>
          </div>
        </form>
      </details>

      {/* ── Categories ───────────────────────────────────────────────────── */}
      <details className="my-4 rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">Categories — {cats.length}</summary>
        <p className="mt-1 text-xs text-ink-3">
          The kind matters more than the name: it decides where a figure lands on the account. A cost put on the wrong
          side of gross profit moves money between two totals without changing either, which reads like a rounding
          difference and is not.
        </p>
        <ul className="mt-3 grid gap-1 sm:grid-cols-2">
          {cats.map((c) => (
            <li key={c.id} className="flex items-baseline gap-2 text-xs">
              <span className="badge badge-muted shrink-0">{KIND_LABEL[c.kind]}</span>
              <span className="font-medium">{c.name}</span>
            </li>
          ))}
        </ul>
        <form action={newCategory} className="mt-3 flex flex-wrap items-end gap-2">
          <input name="name" placeholder="New category" className="rounded-md border border-line px-2 py-1 text-sm" />
          <select name="kind" className="rounded-md border border-line px-2 py-1 text-sm">
            <option value="operating">Overhead</option>
            <option value="cost_of_goods">Cost of goods</option>
            <option value="revenue_offset">Taken back out of revenue</option>
          </select>
          <input name="notes" placeholder="What belongs in it" className="flex-1 rounded-md border border-line px-2 py-1 text-sm" />
          <SubmitButton className="btn" pendingLabel="…">Add</SubmitButton>
        </form>
      </details>

      {/* ── The bills ────────────────────────────────────────────────────── */}
      <h2 className="mt-8 text-sm font-semibold">Bills</h2>
      {recent.length === 0 ? (
        <Empty>Nothing recorded yet. Add a vendor with the address its invoices come from, and they will start filing themselves.</Empty>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-3 py-2">Invoiced</th>
                <th className="px-3 py-2">Vendor</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">For</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Paid</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap text-xs">{fmt(e.invoiceDate)}</td>
                  <td className="px-3 py-2">{e.vendorId ? (vendorById.get(e.vendorId)?.name ?? "—") : "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {e.categoryId ? (byId.get(e.categoryId)?.name ?? "—") : <span className="text-warn">uncategorised</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-2">{e.description ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCents(e.amountCents)}</td>
                  <td className="px-3 py-2 text-xs">
                    {e.paidOn ? fmt(e.paidOn) : <span className="badge badge-warn">owed</span>}
                  </td>
                  <td className="px-3 py-2">
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
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "warn" ? "border-warn" : "border-line"} bg-surface`}>
      <div className={`text-xl font-bold tabular-nums ${tone === "warn" ? "text-warn" : ""}`}>{value}</div>
      <div className="mt-1 text-xs font-semibold">{label}</div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}
