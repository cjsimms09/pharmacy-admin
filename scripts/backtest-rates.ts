/**
 * The backtest: every claim on a settled network priced from that network's rate, beside what the
 * plan actually paid.
 *
 * The owner, 8 September: "the long term plan is to gain confidence in how we expect claims to be
 * paid via our contract links.. then once we are confident they are right, how do we exploit to
 * make more money … along the way making sure we never make dangerous assumptions." This is the
 * confidence, measured. A network is proved where its rate reproduces the plan's allowed amount
 * (what it paid plus what the patient paid) on its own claims; it is not proved by being linked.
 *
 * What can be priced: a formula off a published price the claim carries — "AWP - 21.10%", "NADAC +
 * $10.50", "WAC + 3%" — plus the dispensing fee. A MAC formula cannot be priced from the outside
 * and is reported as such rather than guessed. Brand or generic is the FDA directory's word.
 *
 * Two things decide whether a claim is testable at all, and both were missing until 9 September.
 *
 * The claim's own basis of reimbursement (NCPDP 522-FM) says how the plan actually priced it. Where
 * that is MAC, no contract formula can reproduce it however sound the rate on file is: 432 of this
 * pharmacy's first 1,319 claims were priced that way and every one was being reported as an
 * underpayment averaging 87% of AWP. Where the claim's basis and the rate on file name different
 * things, that is a fact about the link rather than a sum to check, and it is counted as one.
 *
 * And a rate written "Max AWP - 44%" is a ceiling, not a price. Under it is agreement; only a
 * payment above it is a finding. Read as a price it made five Caremark networks look as though they
 * were underpaying by up to $214 a claim when nothing was wrong at all.
 *
 * Writes `rate_backtest` (JSON) for Data health and the payers pages, and prints a summary.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/backtest-rates.ts
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:" + (process.env.DATABASE_PATH || "./data/pharmacy-admin.db") });

type Claim = { id: string; network_id: string; bin: string | null; date_filled: string; days_supply: number | null; ndc11: string | null; remit_cents: number | null; copay_cents: number | null; dispensing_fee_paid_cents: number | null; awp_cents: number | null; wac_cents: number | null; nadac_dispensed_cents: number | null; basis_of_reimbursement: string | null; pbm_name: string | null };
type Rate = { id: string; pbm_name: string; network: string; line_of_business: string; network_ids: string | null; days_supply: string | null; brand_rate: string | null; generic_rate: string | null; status: string | null; source_label: string };

/**
 * A formula as the guide or a deduction wrote it, to a price for this claim.
 *
 * `ceiling` is the difference between "this is what the plan pays" and "this is the most the plan
 * pays". Caremark's commercial generic rate is written "Max AWP - 44%", and Max is not decoration:
 * the plan pays the lesser of its own MAC and that figure, and for a generic the MAC is almost
 * always lower. Priced as though the discount were the rate, every one of those claims came out
 * underpaid — 96 of them, by an average of $30 to $214 a claim, on rates that were not being
 * broken at all. A ceiling is still worth testing, but the test is one-sided: at or under it is
 * agreement, and only a payment above it is a finding.
 */
function price(formula: string | null, c: Claim): { cents: number; basis: string; ceiling: boolean } | { cents: null; basis: string; why: string } {
  const f = (formula ?? "").trim();
  if (!f) return { cents: null, basis: "none", why: "no rate for this kind of drug" };
  const feeM = /\+\s*\$\s*([\d.]+)\s*$/.exec(f);
  const fee = feeM ? Math.round(Number(feeM[1]) * 100) : 0;
  const body = feeM ? f.slice(0, feeM.index).trim() : f;
  // "Max AWP - 44%", "Lesser of AWP - 22.95%": the figure is a limit, not the price.
  const ceiling = /\b(max|maximum|lesser of|up to|not to exceed)\b/i.test(body);
  const awp = /\bAWP\s*-\s*([\d.]+)\s*%/i.exec(body);
  if (awp && !/\bMAC\b/i.test(body)) {
    if (c.awp_cents === null) return { cents: null, basis: body, why: "the claim carries no AWP" };
    return { cents: Math.round(c.awp_cents * (1 - Number(awp[1]) / 100)) + fee, basis: body, ceiling };
  }
  const nadac = /\bNADAC\b(?:\s*\+\s*([\d.]+)\s*%)?/i.exec(body);
  if (nadac && !/\bMAC\b/i.test(body)) {
    if (c.nadac_dispensed_cents === null) return { cents: null, basis: body, why: "the claim carries no NADAC" };
    const pct = nadac[1] ? Number(nadac[1]) / 100 : 0;
    return { cents: Math.round(c.nadac_dispensed_cents * (1 + pct)) + fee, basis: body, ceiling };
  }
  const wac = /\bWAC\s*([+-])\s*([\d.]+)\s*%/i.exec(body);
  if (wac && !/\bMAC\b/i.test(body)) {
    if (c.wac_cents === null) return { cents: null, basis: body, why: "the claim carries no WAC" };
    return { cents: Math.round(c.wac_cents * (1 + (wac[1] === "-" ? -1 : 1) * Number(wac[2]) / 100)) + fee, basis: body, ceiling };
  }
  if (/\bMAC\b/i.test(body)) return { cents: null, basis: body, why: "a MAC price the PBM does not publish" };
  return { cents: null, basis: body, why: "a formula the site cannot price" };
}

/**
 * What the plan says it priced a claim on, from NCPDP field 522-FM as the claim carries it.
 *
 * The single most useful field in this whole exercise, and it was being ignored. The contract says
 * what the plan agreed to pay by; this says what it actually paid by, claim for claim. Of this
 * pharmacy's first 1,319 claims, 432 were priced by MAC — a figure no PBM publishes and nothing
 * here can reproduce — and the backtest was measuring every one of them against an AWP discount
 * and reporting the shortfall as though the plan had broken its contract. The average "underpayment"
 * on those claims was 87% of AWP, which is not a contract being broken; it is a MAC price.
 *
 * Codes, from the standard: 03 is AWP less a percentage, 06 and 07 are MAC, 13 is WAC, 20 is NADAC,
 * 09 is acquisition cost, 04 and 05 involve the usual and customary charge, 08 is contract pricing.
 * A leading zero is optional in the wild and both forms appear in this pharmacy's own data.
 */
function basisFamily(raw: string | null): "awp" | "mac" | "nadac" | "wac" | "acquisition" | "usual" | "other" | null {
  const code = (raw ?? "").trim();
  if (!code) return null;
  const n = /^\d+$/.test(code) ? Number(code) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n === 2 || n === 3) return "awp";
  if (n === 6 || n === 7) return "mac";
  if (n === 20) return "nadac";
  if (n === 13) return "wac";
  if (n === 9) return "acquisition";
  if (n === 4 || n === 5) return "usual";
  return "other";
}

/** The family a rate formula belongs to, so it can be set against what the plan actually did. */
function formulaFamily(formula: string | null): "awp" | "mac" | "nadac" | "wac" | "other" | null {
  const f = (formula ?? "").trim();
  if (!f) return null;
  if (/\bMAC\b/i.test(f)) return "mac";
  if (/\bNADAC\b/i.test(f)) return "nadac";
  if (/\bAWP\b/i.test(f)) return "awp";
  if (/\bWAC\b/i.test(f)) return "wac";
  return "other";
}

function daysFit(band: string | null, days: number | null): boolean {
  if (!band) return true;
  const m = /^(\d+)\s*-\s*(\d*)\+?$/.exec(band.replace(/\s/g, "")) ?? /^(\d+)\+$/.exec(band.replace(/\s/g, ""));
  if (!m) return true;
  if (days === null) return false;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : Infinity;
  return days >= lo && days <= hi;
}

async function main() {
  const claims = (await db.execute(`select id, upper(trim(network_id)) network_id, bin, date_filled, days_supply, ndc11, remit_cents, copay_cents, dispensing_fee_paid_cents, awp_cents, wac_cents, nadac_dispensed_cents, basis_of_reimbursement, pbm_name from claims where status='paid' and network_id is not null and date_filled >= '2026-09-01'`)).rows as unknown as Claim[];
  const rates = (await db.execute(`select id, pbm_name, network, line_of_business, network_ids, days_supply, brand_rate, generic_rate, status, source_label from network_rates where network_ids is not null and coalesce(status,'') <> 'superseded'`)).rows as unknown as Rate[];
  const links = (await db.execute(`select upper(trim(contract_id)) network_id, basis from payer_links where contract_id is not null`)).rows as unknown as { network_id: string; basis: string | null }[];
  const programme = new Set(links.filter((l) => /^Programme:/.test(l.basis ?? "")).map((l) => l.network_id));
  const { directoryKeys } = await import("../src/lib/drug-directory-store");
  const keys = await directoryKeys();
  const byNetwork = new Map<string, Rate[]>();
  for (const r of rates) for (const id of (r.network_ids ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)) byNetwork.set(id, [...(byNetwork.get(id) ?? []), r]);

  type Tally = { network: string; pbm: string | null; lineOfBusiness: string | null; claims: number; programme: boolean; priced: number; within: number; over: number; under: number; ceilingPriced: number; ceilingUnder: number; ceilingOver: number; paidOnAnotherBasis: number; diffCents: number; absDiffCents: number; unpriced: Record<string, number>; examples: string[] };
  const tallies = new Map<string, Tally>();
  for (const c of claims) {
    const t = tallies.get(c.network_id) ?? { network: c.network_id, pbm: c.pbm_name, lineOfBusiness: null, claims: 0, programme: programme.has(c.network_id), priced: 0, within: 0, over: 0, under: 0, ceilingPriced: 0, ceilingUnder: 0, ceilingOver: 0, paidOnAnotherBasis: 0, diffCents: 0, absDiffCents: 0, unpriced: {}, examples: [] };
    tallies.set(c.network_id, t);
    t.claims++;
    if (t.programme) continue;
    const candidates = (byNetwork.get(c.network_id) ?? []).filter((r) => daysFit(r.days_supply, c.days_supply));
    if (candidates.length === 0) {
      t.unpriced["no rate line names this network"] = (t.unpriced["no rate line names this network"] ?? 0) + 1;
      continue;
    }
    const rate = candidates[0];
    t.lineOfBusiness = rate.line_of_business;
    const cls = c.ndc11 ? keys.get(c.ndc11)?.classification ?? null : null;
    const formula = cls === "B" ? rate.brand_rate : cls === "G" ? rate.generic_rate : null;
    if (cls === null) {
      t.unpriced["brand or generic not known for the NDC"] = (t.unpriced["brand or generic not known for the NDC"] ?? 0) + 1;
      continue;
    }
    /*
     * What the plan says it did, before what the contract says it should have.
     *
     * A claim the plan priced by MAC cannot be checked against an AWP discount however sound the
     * rate on file is, and pretending otherwise produced 432 false shortfalls. Where the claim
     * names a basis, that basis decides whether this claim is testable at all. Where the two
     * disagree — the rate says AWP-minus and the plan priced by MAC — that is not a pricing error
     * to measure but a fact about the link, and it is counted as one so it can be seen.
     */
    const paidBy = basisFamily(c.basis_of_reimbursement);
    const saysPay = formulaFamily(formula);
    if (paidBy === "mac") {
      t.unpriced["the plan priced this claim by MAC, which it does not publish"] = (t.unpriced["the plan priced this claim by MAC, which it does not publish"] ?? 0) + 1;
      if (saysPay && saysPay !== "mac") t.paidOnAnotherBasis++;
      continue;
    }
    if (paidBy && saysPay && paidBy !== saysPay && paidBy !== "other") {
      t.unpriced[`the plan priced this claim on ${paidBy.toUpperCase()} where the rate on file says ${saysPay.toUpperCase()}`] =
        (t.unpriced[`the plan priced this claim on ${paidBy.toUpperCase()} where the rate on file says ${saysPay.toUpperCase()}`] ?? 0) + 1;
      t.paidOnAnotherBasis++;
      continue;
    }
    const p = price(formula, c);
    if (p.cents === null) {
      t.unpriced[p.why] = (t.unpriced[p.why] ?? 0) + 1;
      continue;
    }
    const allowed = (c.remit_cents ?? 0) + (c.copay_cents ?? 0);
    const diff = allowed - p.cents;
    const tol = Math.max(50, Math.round(p.cents * 0.01));
    /*
     * A ceiling is tested one way only.
     *
     * "Max AWP - 44%" says the plan will pay no more than that; it does not say it will pay that.
     * Counting a claim paid beneath it as underpaid put 96 of this pharmacy's claims in the wrong
     * column and made five Caremark networks look as though they were breaking their contracts by
     * up to $214 a claim. Under the ceiling is agreement. Over it is the finding, and it is a
     * sharper one than an ordinary miss: the plan paid more than the agreement allows for, so
     * either the rate on file is not the rate that governs or the claim was priced on something
     * else entirely.
     */
    if (p.ceiling) {
      t.ceilingPriced++;
      if (diff <= tol) t.ceilingUnder++;
      else {
        t.ceilingOver++;
        if (t.examples.length < 3) t.examples.push(`${c.date_filled} ${cls} ${p.basis}: allowed $${(allowed / 100).toFixed(2)}, above the ceiling of $${(p.cents / 100).toFixed(2)}`);
      }
      continue;
    }
    t.priced++;
    t.diffCents += diff;
    t.absDiffCents += Math.abs(diff);
    if (Math.abs(diff) <= tol) t.within++;
    else if (diff > 0) t.over++;
    else t.under++;
    if (Math.abs(diff) > tol && t.examples.length < 3) t.examples.push(`${c.date_filled} ${cls} ${p.basis}: expected $${(p.cents / 100).toFixed(2)}, allowed $${(allowed / 100).toFixed(2)}`);
  }
  const rows = [...tallies.values()].sort((a, b) => b.claims - a.claims);
  const summary = {
    testedOn: new Date().toISOString().slice(0, 10),
    claims: claims.length,
    networks: rows.length,
    priced: rows.reduce((n, r) => n + r.priced, 0),
    within: rows.reduce((n, r) => n + r.within, 0),
    ceilingPriced: rows.reduce((n, r) => n + r.ceilingPriced, 0),
    ceilingUnder: rows.reduce((n, r) => n + r.ceilingUnder, 0),
    ceilingOver: rows.reduce((n, r) => n + r.ceilingOver, 0),
    paidOnAnotherBasis: rows.reduce((n, r) => n + r.paidOnAnotherBasis, 0),
    proved: rows.filter((r) => r.priced >= 3 && r.within / r.priced >= 0.9).map((r) => r.network),
    // Not the same claim as `proved`, and kept apart from it: no claim on these networks was paid
    // above the most their agreement allows. That is consistent with the contract, not proof of it.
    withinCeiling: rows.filter((r) => r.ceilingPriced >= 3 && r.ceilingOver === 0).map((r) => r.network),
    rows,
  };
  await db.execute({ sql: `insert into settings (key, value) values ('rate_backtest', ?) on conflict(key) do update set value = excluded.value`, args: [JSON.stringify(summary)] });
  console.log(`claims ${summary.claims}, networks ${summary.networks}, priced ${summary.priced}, within tolerance ${summary.within}, proved networks ${summary.proved.length}; priced against a ceiling ${summary.ceilingPriced}, of which ${summary.ceilingOver} were paid above it, on ${summary.withinCeiling.length} networks with no breach; ${summary.paidOnAnotherBasis} claims the plan priced on a basis the rate on file does not name`);
  for (const r of rows) {
    const un = Object.entries(r.unpriced).map(([k, v]) => `${v} ${k}`).join("; ");
    console.log(`${r.network}\t${(r.pbm ?? "?").slice(0, 16)}\t${r.lineOfBusiness ?? (r.programme ? "programme" : "-")}\tclaims ${r.claims}\tpriced ${r.priced}\twithin ${r.within} over ${r.over} under ${r.under}${r.ceilingPriced ? `	ceiling ${r.ceilingPriced}: ${r.ceilingUnder} under it, ${r.ceilingOver} over` : ""}\tavg diff $${r.priced ? (r.diffCents / r.priced / 100).toFixed(2) : "-"}${un ? `\tunpriced: ${un}` : ""}`);
    for (const e of r.examples) console.log("      e.g. " + e);
  }
  await db.close();
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.stack?.slice(0, 600) : e);
  process.exit(1);
});
