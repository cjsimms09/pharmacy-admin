import "dotenv/config";
/* RedSail's copay remittances through the site's own 835 reader, joined to the claims by prescription: whose programme do they pay? No names printed. */
const $ = (c: number) => (c / 100).toFixed(2);
async function main() {
  const { db, schema } = await import("../../src/db");
  const { like, or, sql } = await import("drizzle-orm");
  const { readFile } = await import("../../src/lib/files");
  const { parse835 } = await import("../../src/lib/x12-835");
  const docs = await db.query.documents.findMany({ where: or(like(schema.documents.fileName, "RS-%ERA%"), like(schema.documents.fileName, "%ACH-ERA%")), columns: { fileName: true, storageKey: true } });
  for (const d of docs) {
    const r = parse835((await readFile(d.storageKey)).toString("latin1"));
    const pays = (r as any).payments ?? (r as any).claims ?? [];
    console.log(`\n=== ${d.fileName.slice(-24)}: ${pays.length} payments, paid ${$((r as any).totalPaidCents ?? 0)} on ${(r as any).paidOn}`);
    let known = 0, cnrx = 0, exact = 0, exactSame = 0;
    const byPcn = new Map<string, { n: number; paid: number }>();
    const items = new Map<string, number>();
    for (const p of pays) {
      const rx = String(p.rxNumber ?? "").replace(/^0+/, "");
      const dos = p.serviceDate ?? p.dateFilled ?? null;
      const rows = (await db.all(sql`select pbm_name, pcn, item_name, date_filled, fill_number, remit_cents, copay_cents from claims where ltrim(rx_number, '0') = ${rx} order by date_filled desc`)) as any[];
      if (!rows.length) continue;
      known++;
      const r0 = rows[0];
      const key = `${String(r0.pbm_name).slice(0, 26)} / ${r0.pcn}`;
      const e = byPcn.get(key) ?? { n: 0, paid: 0 };
      e.n++; e.paid += p.paidCents ?? 0; byPcn.set(key, e);
      if (/CNRX/i.test(r0.pcn ?? "")) cnrx++;
      items.set(String(r0.item_name).replace(/\s+/g, " ").slice(0, 18), (items.get(String(r0.item_name).replace(/\s+/g, " ").slice(0, 18)) ?? 0) + 1);
      const same = rows.find((x: any) => x.date_filled === dos);
      if (same) { exact++; if (same.remit_cents === p.paidCents) exactSame++; }
    }
    console.log(`   prescriptions known to the site: ${known}; on a CNRX (ConnectiveRx) claim: ${cnrx}; with the same fill date on file: ${exact}, of which paid exactly PioneerRx's remit: ${exactSame}`);
    console.log(`   by programme today: ${[...byPcn].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([k, v]) => `${k} ×${v.n} $${$(v.paid)}`).join(" | ")}`);
    console.log(`   drugs: ${[...items].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(", ")}`);
    const big = pays.filter((p: any) => (p.paidCents ?? 0) >= 50_000);
    console.log(`   payments of $500+: ${big.length}: ${big.map((p: any) => `${$(p.paidCents)} (charged ${$(p.chargedCents ?? 0)}, patient ${$(p.patientResponsibilityCents ?? p.patientCents ?? 0)}, fill ${p.serviceDate ?? "?"})`).join("; ")}`);
    if (pays.length) console.log(`   reader fields: ${Object.keys(pays[0]).join(",")}`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
