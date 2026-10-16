import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { FillForScripts, MonthlyPL, PLInputs } from "../profit-and-loss";

/**
 * The month accounts, computed by the engine and stored; the books read rows.
 *
 * Measured 2 October 2026: `loadShared` for one month was 5.4 s, and the books page asked for it four times from
 * cold — both bases, the six-month strip, the twelve-month trend — so the page he named as hard to follow was also
 * the slowest, at twelve seconds, and cold was the usual state because every arriving file empties the held
 * readings. The month in progress is recomputed on the engine's pass whenever anything moved or the day did (its
 * standing costs accrue by the day). The three most recent closed months are recomputed whenever anything moved as
 * well: the owner names a bank line in a closed month and expects the page to show it — on 2 October 2026 he named two
 * September cheques and the books went on asking him to name them, because September was closed and only the night
 * would have recomputed it. Older closed months wait for the nightly pass, where a late document dated into them is rare.
 */

const currentMonth = (today: string) => today.slice(0, 7);

export async function inBooksMonthsThrough(today: string): Promise<string[]> {
  const { SITE_STARTS_ON } = await import("../books-start");
  const out: string[] = [];
  let m = SITE_STARTS_ON.slice(0, 7);
  while (m <= currentMonth(today)) {
    out.push(m);
    const d = new Date(Date.parse(`${m}-01T00:00:00Z`));
    d.setUTCMonth(d.getUTCMonth() + 1);
    m = d.toISOString().slice(0, 7);
  }
  return out;
}

export async function writeMonthAccounts(today: string, now: string, opts: { force?: boolean } = {}): Promise<{ computed: string[]; kept: string[]; ms: number }> {
  const started = Date.now();
  const { fingerprint } = await import("../held");
  const { accountsFor } = await import("../profit-and-loss");
  const fp = await fingerprint();
  const months = await inBooksMonthsThrough(today);
  const existing = await db.query.monthAccounts.findMany({ columns: { month: true, basis: true, fingerprint: true, computedOn: true } });
  const have = new Map(existing.map((r) => [`${r.month}|${r.basis}`, r]));
  const computed: string[] = [];
  const kept: string[] = [];
  for (const month of months) {
    for (const basis of ["accrual", "cash"] as const) {
      const key = `${month}|${basis}`;
      const row = have.get(key);
      const open = month === currentMonth(today);
      /* The open month and the three closed months before it follow every change; older months follow the night. */
      const recent = months.indexOf(month) >= months.length - 4;
      const fresh = row && (open ? row.fingerprint === fp && row.computedOn === today : recent ? row.fingerprint === fp : true);
      if (!opts.force && fresh) {
        kept.push(key);
        continue;
      }
      const s = Date.now();
      const r = await accountsFor([month], basis, { fresh: true });
      const values = {
        account: JSON.stringify(r.months[0]),
        inputs: JSON.stringify(r.inputs[0]),
        fills: JSON.stringify(r.fills),
        fingerprint: fp,
        computedOn: today,
        computedAt: now,
        ms: Date.now() - s,
      };
      if (row) await db.update(schema.monthAccounts).set(values).where(and(eq(schema.monthAccounts.month, month), eq(schema.monthAccounts.basis, basis)));
      else await db.insert(schema.monthAccounts).values({ month, basis, ...values });
      computed.push(key);
    }
  }
  return { computed, kept, ms: Date.now() - started };
}

/**
 * The stored accounts for a run of months, or null where any in-books month is not stored yet (then the caller
 * computes, as it always did). Months before the books are answered without a read, exactly as `accountsFor` does.
 */
export async function readStoredAccounts(
  months: string[],
  basis: "accrual" | "cash",
): Promise<{ months: MonthlyPL[]; inputs: PLInputs[]; fills: FillForScripts[]; stored: { computedAt: string } } | null> {
  const { monthIsOutOfBooks } = await import("../books-start");
  const { beforeBooksAccount, beforeBooksInputs } = await import("../profit-and-loss");
  const inBooks = months.filter((m) => !monthIsOutOfBooks(m));
  const rows = inBooks.length ? await db.query.monthAccounts.findMany({ where: and(eq(schema.monthAccounts.basis, basis), inArray(schema.monthAccounts.month, inBooks)) }) : [];
  const by = new Map(rows.map((r) => [r.month, r]));
  if (inBooks.some((m) => !by.has(m))) return null;
  const out = { months: [] as MonthlyPL[], inputs: [] as PLInputs[], fills: [] as FillForScripts[], stored: { computedAt: rows.map((r) => r.computedAt).sort()[0] ?? "" } };
  for (const m of months) {
    if (monthIsOutOfBooks(m)) {
      out.months.push(beforeBooksAccount(m, basis));
      out.inputs.push(beforeBooksInputs(m, basis));
      continue;
    }
    const r = by.get(m)!;
    const account = JSON.parse(r.account) as MonthlyPL;
    const when = new Date(r.computedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    account.caveats = [...(account.caveats ?? []), `Figures as the engine computed them ${when}; it recomputes the month in progress after every arriving file and every closed month overnight.`];
    out.months.push(account);
    out.inputs.push(JSON.parse(r.inputs) as PLInputs);
    /*
     * A month's stored list also carries the fills dated in an earlier month and collected in it, so a fill dated in
     * September and collected in October sits in both rows. A script is counted in the month it was filled, once —
     * taking each row whole put 179 of September's 6,913 in the table twice, beside a KPI that said 6,734.
     */
    out.fills.push(...(JSON.parse(r.fills) as FillForScripts[]).filter((f) => f.dateFilled.startsWith(m)));
  }
  return out;
}
