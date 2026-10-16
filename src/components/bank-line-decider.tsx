"use client";

import { useState } from "react";
import { CREDIT_CHOICES, DEBIT_CHOICES } from "@/lib/bank-decision-form";

/**
 * The controls on a bank line nothing could place, on the row itself.
 *
 * The owner, 2 October 2026: "easy way to reconcile bank statements (tell site things it cant match)". One choice of
 * what the line was for, then only the fields that choice needs, then one button. The lists it offers are the site's
 * own: the expense categories, the payees on file, the payers that have paid before, the standing costs. Nothing is
 * defaulted; the server reads the form and refuses a blank with its reason (bank-decision-form.ts).
 */
export function BankLineDecider({
  lineId,
  month,
  amountCents,
  categories,
  vendors,
  payers,
  standing,
  action,
}: {
  lineId: string;
  month: string;
  amountCents: number;
  categories: string[];
  vendors: string[];
  payers: string[];
  standing: string[];
  action: (fd: FormData) => Promise<void>;
}) {
  const debit = amountCents < 0;
  const choices = debit ? DEBIT_CHOICES : CREDIT_CHOICES;
  const [what, setWhat] = useState<string>("");
  const field = "field h-9 rounded-md text-sm";
  return (
    <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="lineId" value={lineId} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="amountCents" value={amountCents} />
      <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
        What it was for
        <select name="what" value={what} onChange={(e) => setWhat(e.target.value)} className={`${field} min-w-[16rem]`}>
          <option value="">choose…</option>
          {choices.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {(what === "cost" || what === "cheque" || what === "noted") && (
        <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
          Category
          <select name="category" defaultValue="" className={`${field} min-w-[14rem]`}>
            <option value="">choose…</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      {(what === "cost" || what === "cheque") && (
        <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
          Paid to
          <input name="vendor" list={`vendors-${lineId}`} placeholder="payee" className={`${field} w-44`} />
          <datalist id={`vendors-${lineId}`}>
            {vendors.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </label>
      )}
      {what === "standing" && (
        <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
          Which one
          <select name="standing" defaultValue="" className={`${field} min-w-[12rem]`}>
            <option value="">choose…</option>
            {standing.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
      {what === "deposit" && (
        <>
          <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
            From
            <input name="payer" list={`payers-${lineId}`} placeholder="payer" className={`${field} w-44`} />
            <datalist id={`payers-${lineId}`}>
              {payers.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
            Which is
            <select name="receiptKind" defaultValue="" className={`${field}`}>
              <option value="">choose…</option>
              <option value="third_party">a plan or payer</option>
              <option value="patient">patients, at the counter</option>
              <option value="other">something else</option>
            </select>
          </label>
        </>
      )}
      {what === "register_run" && (
        <>
          <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
            First register day
            <input name="from" type="date" className={field} />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
            Last register day
            <input name="to" type="date" className={field} />
          </label>
        </>
      )}
      {what && (
        <>
          <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
            In a few words (optional)
            <input name="note" placeholder="why" className={`${field} w-56`} />
          </label>
          <button type="submit" className="btn btn-sm btn-primary">
            Name it
          </button>
        </>
      )}
    </form>
  );
}
