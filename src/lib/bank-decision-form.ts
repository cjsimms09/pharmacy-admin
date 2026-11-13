/**
 * What a person says about a bank line nothing could place, read off the form and checked before anything is written.
 *
 * The owner, 2 October 2026: "easy way to reconcile bank statements (tell site things it cant match)". The bank page
 * used to say a cheque was "yours to categorise" and offer nothing on that page to do it with. This is the reading of
 * the form on the row; `decideBankLine` (app/money/bank.ts) does the writing. Pure, so every refusal can be tested.
 *
 * A debit can be: a cost under a category and a payee (a cheque is the same, said so); one of the standing costs;
 * before the books; noted under a category, booked nowhere. A credit can be: a deposit from a named payer; the
 * register's days from..to; before the books; noted. Nothing is defaulted — a blank is a refusal with a reason.
 */

export type Decision =
  | { kind: "before_books"; note: string }
  | { kind: "books_bill"; category: string; vendor: string; note: string }
  | { kind: "deposit"; payer: string; receiptKind: "third_party" | "patient" | "other"; note: string }
  | { kind: "noted"; category: string; note: string }
  | { kind: "confirms_run"; from: string; to: string; note: string }
  | { kind: "standing"; name: string; note: string };

export type FormFields = Partial<Record<"what" | "category" | "vendor" | "payer" | "receiptKind" | "standing" | "from" | "to" | "note", string>>;

export const DEBIT_CHOICES = [
  { key: "cost", label: "A cost, under a category and a payee" },
  { key: "cheque", label: "A cheque to a payee, for a cost" },
  { key: "standing", label: "One of the standing costs (rent, payroll, the accountant)" },
  { key: "before_books", label: "For something from before the books began" },
  { key: "noted", label: "Note what it is; book nothing (its own invoice is still to come)" },
] as const;

export const CREDIT_CHOICES = [
  { key: "deposit", label: "A deposit from a named payer" },
  { key: "register_run", label: "The counter's takings for a run of register days" },
  { key: "before_books", label: "For something from before the books began" },
  { key: "noted", label: "Note what it is; book nothing" },
] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const t = (f: FormFields, k: keyof FormFields) => (f[k] ?? "").trim();

export function decisionFromForm(f: FormFields, amountCents: number, said: string): { ok: true; decision: Decision } | { ok: false; why: string } {
  const what = t(f, "what");
  const note = t(f, "note") || said;
  const debit = amountCents < 0;
  if (!what) return { ok: false, why: "Say what the line was for." };
  if (debit) {
    if (what === "cost" || what === "cheque") {
      const category = t(f, "category");
      const vendor = t(f, "vendor");
      if (!category) return { ok: false, why: "Pick the category it goes under." };
      if (!vendor) return { ok: false, why: "Say who was paid." };
      return { ok: true, decision: { kind: "books_bill", category, vendor, note: what === "cheque" ? `A cheque to ${vendor}. ${note}` : note } };
    }
    if (what === "standing") {
      const name = t(f, "standing");
      if (!name) return { ok: false, why: "Pick which standing cost it is." };
      return { ok: true, decision: { kind: "standing", name, note } };
    }
  } else {
    if (what === "deposit") {
      const payer = t(f, "payer");
      const receiptKind = t(f, "receiptKind") as Decision extends { receiptKind: infer K } ? K : never;
      if (!payer) return { ok: false, why: "Name the payer." };
      if (!["third_party", "patient", "other"].includes(receiptKind)) return { ok: false, why: "Say whether it is a plan, a patient, or something else." };
      return { ok: true, decision: { kind: "deposit", payer, receiptKind: receiptKind as "third_party" | "patient" | "other", note } };
    }
    if (what === "register_run") {
      const from = t(f, "from");
      const to = t(f, "to");
      if (!DAY.test(from) || !DAY.test(to)) return { ok: false, why: "Give the first and last register day, as YYYY-MM-DD." };
      if (to < from) return { ok: false, why: "The last day is before the first." };
      return { ok: true, decision: { kind: "confirms_run", from, to, note } };
    }
    if (what === "cost" || what === "cheque" || what === "standing") return { ok: false, why: "Money in cannot be a cost." };
  }
  if (what === "before_books") return { ok: true, decision: { kind: "before_books", note } };
  if (what === "noted") {
    const category = t(f, "category");
    if (!category) return { ok: false, why: "Say what it is, as a category, so the cash account can place it." };
    return { ok: true, decision: { kind: "noted", category, note } };
  }
  return { ok: false, why: `"${what}" is not a choice this line offers.` };
}
