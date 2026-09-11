import "dotenv/config";
import { db, schema } from "@/db";
import { planKey } from "@/lib/plan-key";
import { receivedCents } from "@/lib/money";
import { findPlanClass, isFinding } from "@/lib/plan-evidence";
import { allPioneerPlanRows, pioneerRowsFor } from "@/lib/pioneer-plans";

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

async function main() {
  const groups = await db.select().from(schema.planGroups);
  const claims = (await db.query.claims.findMany({ columns: { bin: true, pcn: true, groupNumber: true, remitCents: true, copayCents: true, status: true, cashPlan: true } })).filter((c) => c.status === "paid");
  const bins = await db.select({ bin: schema.payerBins.bin, linesOfBusiness: schema.payerBins.linesOfBusiness, pbmName: schema.payerBins.pbmName }).from(schema.payerBins);
  const lob = new Map<string, string | null>();
  for (const b of bins) { const s = lob.get(b.bin); if (s === undefined) lob.set(b.bin, b.linesOfBusiness); else if (s !== b.linesOfBusiness) lob.set(b.bin, null); }
  const pbm = new Map<string, string>();
  for (const b of bins) if (!pbm.has(b.bin)) pbm.set(b.bin, b.pbmName);
  const pio = await allPioneerPlanRows();

  // For every blank-PCN unknown row: which PCNs do ITS OWN claims carry?
  const byBinGroup = new Map<string, { pcns: Map<string, { claims: number; cents: number }> }>();
  for (const c of claims) {
    if (c.cashPlan) continue;
    const k = `${n(c.bin)}|${n(c.groupNumber)}`;
    const e = byBinGroup.get(k) ?? { pcns: new Map() };
    const p = e.pcns.get(n(c.pcn)) ?? { claims: 0, cents: 0 };
    p.claims++; p.cents += receivedCents(c.remitCents, c.copayCents) ?? 0;
    e.pcns.set(n(c.pcn), p);
    byBinGroup.set(k, e);
  }

  const blanks = groups.filter((g) => g.classification === "unknown" && n(g.pcn) === "");
  let onePcn = 0, onePcnClaims = 0, onePcnCents = 0, manyPcn = 0, manyClaims = 0, manyCents = 0, noClaims = 0;
  let settleable = 0, settleClaims = 0, settleCents = 0;
  const settleBy = new Map<string, { rows: number; claims: number; cents: number; ex: string }>();
  for (const g of blanks) {
    const e = byBinGroup.get(`${n(g.bin)}|${n(g.groupNumber)}`);
    if (!e || e.pcns.size === 0) { noClaims++; continue; }
    const cl = [...e.pcns.values()].reduce((s, p) => s + p.claims, 0);
    const ce = [...e.pcns.values()].reduce((s, p) => s + p.cents, 0);
    if (e.pcns.size > 1) { manyPcn++; manyClaims += cl; manyCents += ce; continue; }
    onePcn++; onePcnClaims += cl; onePcnCents += ce;
    const thePcn = [...e.pcns.keys()][0];
    if (!thePcn) continue; // claims genuinely have no PCN either
    const r = findPlanClass({ bin: g.bin, pcn: thePcn, groupNumber: g.groupNumber, payerLabel: g.payerLabel, pbmName: g.pbmName ?? (g.bin ? pbm.get(g.bin) ?? null : null), linesOfBusiness: g.bin ? lob.get(g.bin) ?? null : null, pioneer: pioneerRowsFor(pio, g.bin, thePcn) });
    if (isFinding(r)) {
      settleable++; settleClaims += cl; settleCents += ce;
      const k = `${r.classification}/${r.source}/${n(g.bin)}|${thePcn}`;
      const s = settleBy.get(k) ?? { rows: 0, claims: 0, cents: 0, ex: r.from.slice(0, 100) };
      s.rows++; s.claims += cl; s.cents += ce; settleBy.set(k, s);
    }
  }
  console.log(`blank-PCN unknown rows: ${blanks.length}`);
  console.log(`  their claims all carry ONE PCN: ${onePcn} rows, ${onePcnClaims} claims, ${usd(onePcnCents)}`);
  console.log(`  their claims carry SEVERAL PCNs: ${manyPcn} rows, ${manyClaims} claims, ${usd(manyCents)}`);
  console.log(`  no claims at all: ${noClaims}`);
  console.log(`  of the one-PCN rows, findPlanClass settles: ${settleable} rows, ${settleClaims} claims, ${usd(settleCents)}`);
  console.log(`\n  -- what settles them --`);
  for (const [k, v] of [...settleBy].sort((a, b) => b[1].cents - a[1].cents)) console.log(`  ${k.padEnd(52)} rows ${String(v.rows).padStart(3)} claims ${String(v.claims).padStart(4)} ${usd(v.cents).padStart(12)} | ${v.ex}`);

  // Same question for the PCN-bearing unknown rows: what would confirming all proposals unlock?
  const exact = groups.filter((g) => g.classification === "unknown" && n(g.pcn) !== "");
  const stat = new Map<string, { claims: number; cents: number }>();
  for (const c of claims) {
    if (c.cashPlan) continue;
    const k = planKey(c.bin, c.pcn, c.groupNumber);
    const e = stat.get(k) ?? { claims: 0, cents: 0 };
    e.claims++; e.cents += receivedCents(c.remitCents, c.copayCents) ?? 0;
    stat.set(k, e);
  }
  const by = new Map<string, { rows: number; claims: number; cents: number; ex: string }>();
  let ok = 0, okC = 0, okCents = 0;
  for (const g of exact) {
    const r = findPlanClass({ bin: g.bin, pcn: g.pcn, groupNumber: g.groupNumber, payerLabel: g.payerLabel, pbmName: g.pbmName ?? (g.bin ? pbm.get(g.bin) ?? null : null), linesOfBusiness: g.bin ? lob.get(g.bin) ?? null : null, pioneer: pioneerRowsFor(pio, g.bin, g.pcn) });
    const s = stat.get(planKey(g.bin, g.pcn, g.groupNumber)) ?? { claims: 0, cents: 0 };
    if (!isFinding(r)) continue;
    ok++; okC += s.claims; okCents += s.cents;
    const k = `${r.classification}/${r.source}/${n(g.bin)}|${n(g.pcn)}`;
    const e = by.get(k) ?? { rows: 0, claims: 0, cents: 0, ex: r.from.slice(0, 100) };
    e.rows++; e.claims += s.claims; e.cents += s.cents; by.set(k, e);
  }
  console.log(`\nPCN-bearing unknown rows: ${exact.length}; findPlanClass settles ${ok}, ${okC} claims, ${usd(okCents)}`);
  for (const [k, v] of [...by].sort((a, b) => b[1].cents - a[1].cents)) console.log(`  ${k.padEnd(52)} rows ${String(v.rows).padStart(3)} claims ${String(v.claims).padStart(4)} ${usd(v.cents).padStart(12)} | ${v.ex}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
