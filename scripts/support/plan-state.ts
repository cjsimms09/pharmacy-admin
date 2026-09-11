import "dotenv/config";
import { db, schema } from "@/db";
import { planRegister, CLASS_INFO } from "@/lib/plans";
import { planCandidates } from "@/lib/plan-proposals-store";

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const rows = await planRegister();
  const unknown = rows.filter((r) => r.classification === "unknown");
  console.log(`plans on register: ${rows.length}`);
  console.log(`classified:        ${rows.length - unknown.length}`);
  console.log(`unclassified:      ${unknown.length}`);
  console.log(`unclassified claims: ${unknown.reduce((s, r) => s + r.claims, 0)}  received ${usd(unknown.reduce((s, r) => s + r.receivedCents, 0))}`);
  console.log(`classified claims:   ${rows.filter((r) => r.classification !== "unknown").reduce((s, r) => s + r.claims, 0)}  received ${usd(rows.filter((r) => r.classification !== "unknown").reduce((s, r) => s + r.receivedCents, 0))}`);
  const byClass = new Map<string, { n: number; claims: number; cents: number }>();
  for (const r of rows) {
    const e = byClass.get(r.classification) ?? { n: 0, claims: 0, cents: 0 };
    e.n++; e.claims += r.claims; e.cents += r.receivedCents;
    byClass.set(r.classification, e);
  }
  console.log("\n-- by class --");
  for (const [k, v] of [...byClass].sort((a, b) => b[1].cents - a[1].cents)) {
    console.log(`${k.padEnd(26)} plans ${String(v.n).padStart(4)}  claims ${String(v.claims).padStart(5)}  ${usd(v.cents).padStart(14)}  inScope=${CLASS_INFO[k as keyof typeof CLASS_INFO].inScope}`);
  }

  // What the existing proposal machinery already offers
  const cands = await planCandidates();
  const offered = cands.filter((c) => c.proposed);
  console.log(`\n-- existing proposal machinery on the ${cands.length} unknown plans --`);
  console.log(`offers a class on: ${offered.length} plans, ${offered.reduce((s, c) => s + c.fills, 0)} fills`);
  const byProp = new Map<string, number>();
  for (const c of offered) byProp.set(`${c.proposed}/${c.proposedSource}`, (byProp.get(`${c.proposed}/${c.proposedSource}`) ?? 0) + 1);
  for (const [k, v] of [...byProp].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(40)} ${v}`);
  const hints = cands.filter((c) => c.governmentHint);
  console.log(`government hints:  ${hints.length} plans`);

  // The unproposable ones grouped by their reason
  const why = new Map<string, { n: number; fills: number }>();
  for (const c of cands.filter((x) => !x.proposed)) {
    const k = (c.why ?? "").slice(0, 90);
    const e = why.get(k) ?? { n: 0, fills: 0 };
    e.n++; e.fills += c.fills;
    why.set(k, e);
  }
  console.log(`\n-- reasons nothing is proposed (top 25 of ${why.size}) --`);
  for (const [k, v] of [...why].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) console.log(`${String(v.n).padStart(4)} plans ${String(v.fills).padStart(5)} fills | ${k}`);

  // Raw evidence coverage on the unknown rows
  const unknownIds = new Set(cands.map((c) => c.id));
  const groups = await db.select().from(schema.planGroups);
  const u = groups.filter((g) => unknownIds.has(g.id));
  const n = (v: string | null) => (v ?? "").trim();
  console.log(`\n-- evidence carried by the ${u.length} unknown register rows --`);
  console.log(`with BIN:   ${u.filter((g) => n(g.bin)).length}`);
  console.log(`with PCN:   ${u.filter((g) => n(g.pcn)).length}`);
  console.log(`with group: ${u.filter((g) => n(g.groupNumber)).length}`);
  console.log(`with payerLabel: ${u.filter((g) => n(g.payerLabel)).length}`);
  console.log(`with pbmName:    ${u.filter((g) => n(g.pbmName)).length}`);
  console.log(`distinct BINs:      ${new Set(u.map((g) => n(g.bin))).size}`);
  console.log(`distinct BIN+PCN:   ${new Set(u.map((g) => `${n(g.bin)}|${n(g.pcn)}`)).size}`);

  // Group the unknown register rows by BIN+PCN with money
  const byRouting = new Map<string, { plans: number; claims: number; cents: number; label: string; pbm: string; types: Set<string> }>();
  for (const r of unknown) {
    const k = `${n(r.bin)}|${n(r.pcn)}`;
    const e = byRouting.get(k) ?? { plans: 0, claims: 0, cents: 0, label: r.payerLabel ?? "", pbm: r.pbmName ?? "", types: new Set<string>() };
    e.plans++; e.claims += r.claims; e.cents += r.receivedCents;
    if (!e.label && r.payerLabel) e.label = r.payerLabel;
    if (!e.pbm && r.pbmName) e.pbm = r.pbmName;
    for (const t of r.planTypes) e.types.add(t);
    byRouting.set(k, e);
  }
  console.log(`\n-- unknown plans grouped by BIN+PCN: ${byRouting.size} routings --`);
  for (const [k, v] of [...byRouting].sort((a, b) => b[1].cents - a[1].cents).slice(0, 40)) {
    console.log(`${k.padEnd(22)} plans ${String(v.plans).padStart(4)} claims ${String(v.claims).padStart(5)} ${usd(v.cents).padStart(13)} | ${v.label} | ${v.pbm} | ${[...v.types].join(",")}`);
  }
  const tail = [...byRouting].sort((a, b) => b[1].cents - a[1].cents).slice(40);
  console.log(`... ${tail.length} more routings, ${tail.reduce((s, t) => s + t[1].plans, 0)} plans, ${tail.reduce((s, t) => s + t[1].claims, 0)} claims, ${usd(tail.reduce((s, t) => s + t[1].cents, 0))}`);

  // PioneerRx plan types seen on unknown-plan claims
  const claims = await db.query.claims.findMany({ columns: { bin: true, pcn: true, groupNumber: true, planType: true, status: true, cashPlan: true } });
  const pt = new Map<string, number>();
  for (const c of claims) if (c.status === "paid") pt.set(c.planType ?? "(none)", (pt.get(c.planType ?? "(none)") ?? 0) + 1);
  console.log(`\n-- claim.planType across all paid claims --`);
  for (const [k, v] of [...pt].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);

  const ppt = await db.select().from(schema.pioneerPlanTypes);
  const ppc = new Map<string, number>();
  for (const r of ppt) ppc.set(`${r.source}/${r.planType ?? "(null)"}`, (ppc.get(`${r.source}/${r.planType ?? "(null)"}`) ?? 0) + 1);
  console.log(`\n-- pioneer_plan_types rows: ${ppt.length} --`);
  for (const [k, v] of [...ppc].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(34)} ${v}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
