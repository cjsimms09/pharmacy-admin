import "dotenv/config";
import { db, schema } from "@/db";
import { planLookup } from "@/lib/plan-key";
import { receivedCents } from "@/lib/money";
import { planCandidates } from "@/lib/plan-proposals-store";
import { allPioneerPlanRows, pioneerRowsFor } from "@/lib/pioneer-plans";

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

async function main() {
  const groups = await db.select().from(schema.planGroups);
  const claims = await db.query.claims.findMany({ columns: { id: true, bin: true, pcn: true, groupNumber: true, remitCents: true, copayCents: true, status: true, cashPlan: true, payerLabel: true, pbmName: true } });
  const paid = claims.filter((c) => c.status === "paid");
  const lookup = planLookup(groups);

  let unkC = 0, unkCents = 0, knC = 0, knCents = 0, noRow = 0;
  const governedBy = new Map<string, { claims: number; cents: number }>();
  for (const c of paid) {
    const g = lookup({ bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber });
    const got = receivedCents(c.remitCents, c.copayCents) ?? 0;
    if (!g) { noRow++; continue; }
    const e = governedBy.get(g.id) ?? { claims: 0, cents: 0 };
    e.claims++; e.cents += got; governedBy.set(g.id, e);
    if (g.classification === "unknown") { unkC++; unkCents += got; } else { knC++; knCents += got; }
  }
  console.log(`paid claims: ${paid.length}  (all claims ${claims.length})`);
  console.log(`governed by an UNKNOWN plan row: ${unkC} claims, ${usd(unkCents)}`);
  console.log(`governed by a CLASSIFIED row:    ${knC} claims, ${usd(knCents)}`);
  console.log(`no register row at all:          ${noRow}`);

  const unknown = groups.filter((g) => g.classification === "unknown");
  const live = unknown.filter((g) => (governedBy.get(g.id)?.claims ?? 0) > 0);
  console.log(`\nunknown register rows: ${unknown.length}; of those governing >=1 paid claim: ${live.length}; governing none: ${unknown.length - live.length}`);
  console.log(`  blank-PCN unknown rows: ${unknown.filter((g) => n(g.pcn) === "").length}`);
  console.log(`  blank-PCN rows that govern claims: ${live.filter((g) => n(g.pcn) === "").length}`);

  // The live unknown rows, grouped by BIN+PCN
  const cands = await planCandidates();
  const byId = new Map(cands.map((c) => [c.id, c]));
  type Agg = { plans: number; live: number; claims: number; cents: number; label: string; pbm: string; proposed: Set<string>; why: string };
  const agg = new Map<string, Agg>();
  for (const g of unknown) {
    const k = `${n(g.bin)}|${n(g.pcn)}`;
    const st = governedBy.get(g.id) ?? { claims: 0, cents: 0 };
    const c = byId.get(g.id);
    const e = agg.get(k) ?? { plans: 0, live: 0, claims: 0, cents: 0, label: "", pbm: "", proposed: new Set<string>(), why: "" };
    e.plans++; if (st.claims) e.live++;
    e.claims += st.claims; e.cents += st.cents;
    if (!e.label && g.payerLabel) e.label = g.payerLabel;
    if (!e.pbm && c?.pbmName) e.pbm = c.pbmName;
    if (c?.proposed) e.proposed.add(c.proposed);
    if (!e.why && c?.why) e.why = c.why;
    agg.set(k, e);
  }
  console.log(`\n== unknown rows by BIN+PCN (${agg.size} routings), by money ==`);
  const pio = await allPioneerPlanRows();
  for (const [k, v] of [...agg].sort((a, b) => b[1].cents - a[1].cents)) {
    const [bin, pcn] = k.split("|");
    const rows = pioneerRowsFor(pio, bin || null, pcn || null).filter((r) => r.isActive);
    const names = [...new Set(rows.map((r) => (r.planName ?? "").trim()).filter(Boolean))];
    const types = [...new Set(rows.map((r) => r.planType).filter(Boolean))];
    console.log(
      `${k.padEnd(20)} rows ${String(v.plans).padStart(3)}(${String(v.live).padStart(3)} live) claims ${String(v.claims).padStart(4)} ${usd(v.cents).padStart(12)} | ${v.label} | ${v.pbm} | prop=${[...v.proposed].join(",") || "-"} | pio[${rows.length}] types=${types.join("/")} names=${names.slice(0, 3).join(";")}${names.length > 3 ? `+${names.length - 3}` : ""}`,
    );
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
