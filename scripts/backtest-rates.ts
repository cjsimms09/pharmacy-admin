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
 * Writes `rate_backtest` (JSON) for Data health and the payers pages, and prints a summary.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/backtest-rates.ts
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:" + (process.env.DATABASE_PATH || "./data/pharmacy-admin.db") });

type Claim = { id: string; network_id: string; bin: string | null; date_filled: string; days_supply: number | null; ndc11: string | null; remit_cents: number | null; copay_cents: number | null; dispensing_fee_paid_cents: number | null; awp_cents: number | null; wac_cents: number | null; nadac_dispensed_cents: number | null; basis_of_reimbursement: string | null; pbm_name: string | null };
type Rate = { id: string; pbm_name: string; network: string; line_of_business: string; network_ids: string | null; days_supply: string | null; brand_rate: string | null; generic_rate: string | null; status: string | null; source_label: string };

/** A formula as the guide or a deduction wrote it, to a price for this claim. */
function price(formula: string | null, c: Claim): { cents: number; basis: string } | { cents: null; basis: string; why: string } {
  const f = (formula ?? "").trim();
  if (!f) return { cents: null, basis: "none", why: "no rate for this kind of drug" };
  const feeM = /\+\s*\$\s*([\d.]+)\s*$/.exec(f);
  const fee = feeM ? Math.round(Number(feeM[1]) * 100) : 0;
  const body = feeM ? f.slice(0, feeM.index).trim() : f;
  const awp = /\bAWP\s*-\s*([\d.]+)\s*%/i.exec(body);
  if (awp && !/\bMAC\b/i.test(body)) {
    if (c.awp_cents === null) return { cents: null, basis: body, why: "the claim carries no AWP" };
    return { cents: Math.round(c.awp_cents * (1 - Number(awp[1]) / 100)) + fee, basis: body };
  }
  const nadac = /\bNADAC\b(?:\s*\+\s*([\d.]+)\s*%)?/i.exec(body);
  if (nadac && !/\bMAC\b/i.test(body)) {
    if (c.nadac_dispensed_cents === null) return { cents: null, basis: body, why: "the claim carries no NADAC" };
    const pct = nadac[1] ? Number(nadac[1]) / 100 : 0;
    return { cents: Math.round(c.nadac_dispensed_cents * (1 + pct)) + fee, basis: body };
  }
  const wac = /\bWAC\s*([+-])\s*([\d.]+)\s*%/i.exec(body);
  if (wac && !/\bMAC\b/i.test(body)) {
    if (c.wac_cents === null) return { cents: null, basis: body, why: "the claim carries no WAC" };
    return { cents: Math.round(c.wac_cents * (1 + (wac[1] === "-" ? -1 : 1) * Number(wac[2]) / 100)) + fee, basis: body };
  }
  if (/\bMAC\b/i.test(body)) return { cents: null, basis: body, why: "a MAC price the PBM does not publish" };
  return { cents: null, basis: body, why: "a formula the site cannot price" };
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

  type Tally = { network: string; pbm: string | null; lineOfBusiness: string | null; claims: number; programme: boolean; priced: number; within: number; over: number; under: number; diffCents: number; absDiffCents: number; unpriced: Record<string, number>; examples: string[] };
  const tallies = new Map<string, Tally>();
  for (const c of claims) {
    const t = tallies.get(c.network_id) ?? { network: c.network_id, pbm: c.pbm_name, lineOfBusiness: null, claims: 0, programme: programme.has(c.network_id), priced: 0, within: 0, over: 0, under: 0, diffCents: 0, absDiffCents: 0, unpriced: {}, examples: [] };
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
    const p = price(formula, c);
    if (p.cents === null) {
      t.unpriced[p.why] = (t.unpriced[p.why] ?? 0) + 1;
      continue;
    }
    const allowed = (c.remit_cents ?? 0) + (c.copay_cents ?? 0);
    const diff = allowed - p.cents;
    t.priced++;
    t.diffCents += diff;
    t.absDiffCents += Math.abs(diff);
    const tol = Math.max(50, Math.round(p.cents * 0.01));
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
    proved: rows.filter((r) => r.priced >= 3 && r.within / r.priced >= 0.9).map((r) => r.network),
    rows,
  };
  await db.execute({ sql: `insert into settings (key, value) values ('rate_backtest', ?) on conflict(key) do update set value = excluded.value`, args: [JSON.stringify(summary)] });
  console.log(`claims ${summary.claims}, networks ${summary.networks}, priced ${summary.priced}, within tolerance ${summary.within}, proved networks ${summary.proved.length}`);
  for (const r of rows) {
    const un = Object.entries(r.unpriced).map(([k, v]) => `${v} ${k}`).join("; ");
    console.log(`${r.network}\t${(r.pbm ?? "?").slice(0, 16)}\t${r.lineOfBusiness ?? (r.programme ? "programme" : "-")}\tclaims ${r.claims}\tpriced ${r.priced}\twithin ${r.within} over ${r.over} under ${r.under}\tavg diff $${r.priced ? (r.diffCents / r.priced / 100).toFixed(2) : "-"}${un ? `\tunpriced: ${un}` : ""}`);
    for (const e of r.examples) console.log("      e.g. " + e);
  }
  await db.close();
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.stack?.slice(0, 600) : e);
  process.exit(1);
});
