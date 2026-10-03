import Link from "next/link";
import { Notice, Field } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { formatCents } from "@/lib/money";
import { BUSINESS_KINDS, matchParty, type BusinessDocT } from "@/lib/business-docs";
import { applyBusiness, deleteIntake, dismissIntake, retryIntake } from "../actions";

/**
 * The review card for a document with money on it.
 *
 * One card per kind, every field editable, Claude's reading as the default and the file beside
 * it. What is missing is asked for on the card — a supplier or vendor the site does not know is
 * added here rather than on another page — and the button says where the money will land.
 */
export const KIND_LABEL: Record<(typeof BUSINESS_KINDS)[number], string> = {
  wholesaler_invoice: "A wholesaler's drug invoice",
  bill: "A bill to pay: supplies, rent, utilities, software, a repair",
  remittance: "A payer's remittance advice (what it paid on which prescriptions)",
  rebate_statement: "A wholesaler's rebate statement",
  supplier_statement: "A wholesaler's statement of account",
  credit_memo: "A credit memo from a supplier",
  bank_statement: "The bank's statement",
  sales_summary: "A sales summary from PioneerRx",
  compliance_document: "A licence, certificate, training record or form",
  other: "Something else — keep it in the vault",
};

export function BusinessReview({
  id,
  doc,
  read,
  as,
  suppliers,
  vendors,
  categories,
  error,
}: {
  id: string;
  doc: { fileName: string };
  read: BusinessDocT;
  /** The kind to show the card for: the reading's, or the one the person chose instead. */
  as: (typeof BUSINESS_KINDS)[number];
  suppliers: { id: string; name: string; alsoKnownAs?: string | null }[];
  vendors: { id: string; name: string; categoryId: string | null }[];
  categories: { id: string; name: string; kind: string }[];
  error?: string;
}) {
  const kind = as;
  const low = read.confidence < 0.6;
  const partyName = read.partyIsKnownAs ?? read.party;
  const supplier = matchParty(partyName, suppliers);
  const vendor = matchParty(partyName, vendors);
  const category = categories.find((c) => c.name === read.suggestedCategory) ?? (vendor?.categoryId ? categories.find((c) => c.id === vendor.categoryId) : undefined);
  const dollars = (c: number | undefined) => (c === undefined ? "" : (c / 100).toFixed(2));

  return (
    <>
      <Notice kind={low ? "warn" : "ok"}>
        <b>{read.summary}</b>
        {read.notes ? ` ${read.notes}` : ""}
        {low ? " Claude was not confident: check every field before filing." : ""}
      </Notice>
      {error && <Notice kind="crit">{error}</Notice>}

      <form action={applyBusiness.bind(null, id)} className="space-y-5">
        <input type="hidden" name="kind" value={kind} />
        <section className="card">
          <h2 className="mb-1 font-semibold">What it is</h2>
          <p className="text-sm">{KIND_LABEL[kind]}</p>
          <p className="mt-2 text-xs text-ink-3">
            Not that?{" "}
            {BUSINESS_KINDS.filter((k) => k !== kind).map((k) => (
              <Link key={k} href={`/intake/${id}?as=${k}`} className="mr-2 text-accent underline">
                {KIND_LABEL[k].split(":")[0].split(" (")[0]}
              </Link>
            ))}
          </p>
        </section>

        {kind === "wholesaler_invoice" && (
          <section className="card grid gap-3 sm:grid-cols-2">
            <h2 className="font-semibold sm:col-span-2">Goes to Supplier invoices</h2>
            <Field label="Wholesaler" hint={supplier ? `The document reads “${read.party}”.` : `The document reads “${read.party}”; not on the register.`} className="sm:col-span-2">
              <select name="supplierId" className="field" defaultValue={supplier?.id ?? "new"}>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                <option value="new">Add a new supplier…</option>
              </select>
            </Field>
            <Field label="New supplier's name" hint="Only if you chose to add one."><input name="newSupplierName" className="field" defaultValue={supplier ? "" : read.party} /></Field>
            <Field label="Their sending address" hint="So the next invoice files itself from email."><input name="newSupplierEmail" className="field" placeholder="invoices@supplier.com" /></Field>
            <Field label="Invoice number"><input name="documentNumber" className="field" defaultValue={read.documentNumber ?? ""} /></Field>
            <Field label="Invoice date"><input name="documentDate" type="date" className="field" defaultValue={read.documentDate ?? ""} /></Field>
            <Field label="Total, in dollars"><input name="totalCents" inputMode="decimal" className="field" defaultValue={dollars(read.totalCents)} /></Field>
            <Field label="Paid on" hint="Leave blank if not yet paid; the cash account uses the supplier's terms."><input name="paidOn" type="date" className="field" defaultValue={read.paidOn ?? ""} /></Field>
            <p className="text-xs text-ink-3 sm:col-span-2">The item table is read off the invoice itself — NDCs, quantities, prices, the class letter, the rebate mark — and the schedule decides where it is filed.</p>
          </section>
        )}

        {kind === "bill" && (
          <section className="card grid gap-3 sm:grid-cols-2">
            <h2 className="font-semibold sm:col-span-2">Goes to Spending</h2>
            <Field label="Vendor" hint={vendor ? `The document reads “${read.party}”.` : `The document reads “${read.party}”; not on the vendor list.`} className="sm:col-span-2">
              <select name="vendorId" className="field" defaultValue={vendor?.id ?? "new"}>
                <option value="">— no vendor —</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                <option value="new">Add a new vendor…</option>
              </select>
            </Field>
            <Field label="New vendor's name" hint="Only if you chose to add one."><input name="newVendorName" className="field" defaultValue={vendor ? "" : read.party} /></Field>
            <Field label="Their sending address" hint="So the next bill from them files itself."><input name="newVendorEmail" className="field" placeholder="billing@vendor.com" /></Field>
            <Field label="How often they bill">
              <select name="newVendorCadence" className="field" defaultValue="irregular">
                <option value="monthly">Every month</option>
                <option value="irregular">Now and then</option>
              </select>
            </Field>
            <Field label="Category" hint={read.suggestedCategory ? `Claude suggests ${read.suggestedCategory}.` : undefined}>
              <select name="categoryId" className="field" defaultValue={category?.id ?? ""} required>
                <option value="">— choose —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Bill number"><input name="documentNumber" className="field" defaultValue={read.documentNumber ?? ""} /></Field>
            <Field label="Bill date"><input name="documentDate" type="date" className="field" defaultValue={read.documentDate ?? ""} required /></Field>
            <Field label="Amount, in dollars" hint={read.taxCents ? `Includes ${formatCents(read.taxCents)} of tax.` : undefined}><input name="totalCents" inputMode="decimal" className="field" defaultValue={dollars(read.totalCents)} required /></Field>
            <Field label="Paid on" hint="Blank until it is paid. A fee taken out of a deposit is entered with no paid date."><input name="paidOn" type="date" className="field" defaultValue={read.paidOn ?? ""} /></Field>
            <Field label="What it is for" className="sm:col-span-2"><input name="description" className="field" defaultValue={read.lines.map((l) => l.description).filter(Boolean).slice(0, 3).join("; ") || read.summary} /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="force" /> File it anyway if a bill with this number is already on Spending</label>
          </section>
        )}

        {kind === "remittance" && (
          <section className="card grid gap-3 sm:grid-cols-2">
            <h2 className="font-semibold sm:col-span-2">Goes to the claims it paid, and to the bank</h2>
            <Field label="Payer"><input name="payer" className="field" defaultValue={read.remittance?.payer ?? read.party} /></Field>
            <Field label="Paid on"><input name="paidOn" type="date" className="field" defaultValue={read.remittance?.paidOn ?? read.paidOn ?? read.documentDate ?? ""} required /></Field>
            <Field label="Check or trace number"><input name="traceNumber" className="field" defaultValue={read.remittance?.traceNumber ?? read.documentNumber ?? ""} /></Field>
            <Field label="Total paid, in dollars"><input name="totalCents" inputMode="decimal" className="field" defaultValue={dollars(read.remittance?.totalPaidCents ?? read.totalCents)} /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="bank" defaultChecked /> Bank the total against the month it was paid</label>
            <div className="sm:col-span-2">
              <p className="text-xs font-semibold">Payments read off it ({read.remittance?.claims.length ?? 0})</p>
              {read.remittance && read.remittance.claims.length > 0 ? (
                <div className="mt-1 max-h-48 overflow-auto rounded border border-line">
                  <table className="table text-xs">
                    <thead><tr><th>Rx</th><th>Fill</th><th>Service date</th><th className="num">Paid</th></tr></thead>
                    <tbody>{read.remittance.claims.map((c, i) => <tr key={i}><td>{c.rxNumber}</td><td>{c.fillNumber ?? ""}</td><td>{c.serviceDate ?? ""}</td><td className="num">{formatCents(c.paidCents)}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-ink-3">None could be read. The total can still be banked; the per-claim match needs the 835 file itself (drop it here and it posts on its own).</p>
              )}
              <p className="mt-1 text-xs text-ink-3">A plan&rsquo;s own remittance settles what the claims already carry, so it is never counted as revenue twice; the facilitator&rsquo;s is new money.</p>
            </div>
          </section>
        )}

        {kind === "rebate_statement" && (
          <section className="card grid gap-3 sm:grid-cols-2">
            <h2 className="font-semibold sm:col-span-2">Goes to Spending under Wholesaler rebates, replacing the estimate</h2>
            <Field label="Wholesaler" className="sm:col-span-2">
              <select name="supplierId" className="field" defaultValue={supplier?.id ?? ""}>
                <option value="">— choose —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Statement date" hint="Or the last day of the period it settles."><input name="documentDate" type="date" className="field" defaultValue={read.periodTo ?? read.documentDate ?? ""} required /></Field>
            <Field label="Rebate settled, in dollars"><input name="totalCents" inputMode="decimal" className="field" defaultValue={dollars(read.totalCents)} required /></Field>
            <Field label="Statement number"><input name="documentNumber" className="field" defaultValue={read.documentNumber ?? ""} /></Field>
            <Field label="Money received on" hint="Blank until it lands."><input name="paidOn" type="date" className="field" defaultValue={read.paidOn ?? ""} /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="bank" /> Bank it against the month it was received (needs the date above)</label>
          </section>
        )}

        {(kind === "supplier_statement" || kind === "credit_memo" || kind === "bank_statement" || kind === "sales_summary" || kind === "other" || kind === "compliance_document") && (
          <section className="card grid gap-3 sm:grid-cols-2">
            <h2 className="font-semibold sm:col-span-2">{kind === "compliance_document" ? "Read again as a compliance document" : "Goes to the vault"}</h2>
            {kind === "compliance_document" ? (
              <p className="text-sm text-ink-2 sm:col-span-2">Press &ldquo;Try again&rdquo; below and it is read by the compliance classifier, which knows licences, cards and training records.</p>
            ) : (
              <>
                <Field label="Title" className="sm:col-span-2"><input name="title" className="field" defaultValue={read.summary} /></Field>
                <Field label="Date"><input name="documentDate" type="date" className="field" defaultValue={read.documentDate ?? read.periodTo ?? ""} /></Field>
                <Field label="Notes"><input name="notes" className="field" defaultValue={read.notes ?? ""} /></Field>
              </>
            )}
          </section>
        )}

        <div className="flex flex-wrap gap-2">
          {kind !== "compliance_document" && <button className="btn btn-primary" type="submit">File it</button>}
          <span className="grow" />
          <form action={retryIntake.bind(null, id)}><button className="btn" formNoValidate>Try again</button></form>
          <form action={dismissIntake.bind(null, id)}><button className="btn" formNoValidate>Leave it in the vault</button></form>
          <form action={deleteIntake.bind(null, id)}>
            <ConfirmButton className="btn btn-danger" message="Delete this file entirely?">Delete</ConfirmButton>
          </form>
        </div>
      </form>
      <p className="mt-3 text-xs text-ink-3">{doc.fileName}: the file is already stored. Filing decides where the money lands.</p>
    </>
  );
}
