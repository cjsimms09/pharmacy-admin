import "dotenv/config";
async function main() {
  const { db, schema } = await import("../../src/db");
  const rows = await db.select({ from: schema.inboxItems.fromAddress, subject: schema.inboxItems.subject, status: schema.inboxItems.status, routedAs: schema.inboxItems.routedAs, imported: schema.inboxItems.imported, reason: schema.inboxItems.reason, result: schema.inboxItems.routeResult, received: schema.inboxItems.receivedAt, file: schema.inboxItems.fileName }).from(schema.inboxItems);
  const dom = (a: string) => (a.split("@")[1] ?? a).toLowerCase();
  const key = new Map<string, { n: number; stored: number; imported: number; held: number; rejected: number; ignored: number; subjects: Set<string>; first: string; last: string; whyHeld: Set<string> }>();
  for (const r of rows) {
    const k = `${dom(r.from)} | ${r.routedAs}`;
    const e = key.get(k) ?? { n: 0, stored: 0, imported: 0, held: 0, rejected: 0, ignored: 0, subjects: new Set(), first: r.received, last: r.received, whyHeld: new Set() };
    e.n++;
    if (r.status === "stored") e.stored++;
    if (r.status === "rejected") e.rejected++;
    if (r.status === "ignored") e.ignored++;
    if (r.imported === true) e.imported++;
    if (r.status === "stored" && r.imported === false) { e.held++; e.whyHeld.add((r.result ?? "").slice(0, 90)); }
    e.subjects.add(r.subject.replace(/\d{2,}/g, "#").slice(0, 50));
    if (r.received < e.first) e.first = r.received;
    if (r.received > e.last) e.last = r.received;
    key.set(k, e);
  }
  console.log(`${rows.length} inbox items`);
  for (const [k, e] of [...key.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(e.n).padStart(4)}  ${k.padEnd(52)} stored ${e.stored} imported ${e.imported} held ${e.held} rejected ${e.rejected} ignored ${e.ignored}  ${e.first.slice(0, 10)}..${e.last.slice(0, 10)}`);
    console.log(`      subjects: ${[...e.subjects].slice(0, 4).join(" / ")}`);
    if (e.whyHeld.size) console.log(`      held: ${[...e.whyHeld].slice(0, 3).join(" | ")}`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
