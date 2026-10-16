/**
 * Fills the benchmark prices a claim needs to be judged: NADAC from the site's own table, AWP and
 * WAC from PioneerRx where it can prove they were the prices in force.
 *
 * The owner, 9 September: "we need to make sure we are getting everything we need. we need to make
 * sure we are mapping data to the site properly." The September audit showed the gap plainly. Of
 * 1,661 paid claims, 27 carried an AWP and 27 a NADAC — and the site was already holding 273,783
 * NADAC prices and could have answered for nearly all of them. That is not missing data. It is data
 * the site had and never joined, which is the more embarrassing of the two and the easier to fix.
 *
 * ── Why AWP needs proving and NADAC does not ──
 *
 * NADAC is published weekly with an effective date on every row, so "the price in force on the day
 * this was filled" is a fact the table can answer exactly. `priceInForce` already does it.
 *
 * AWP is not published that way here. PioneerRx keeps one AWP per item, today's, beside the date it
 * last changed. Where that date is on or before the fill, today's figure demonstrably *was* the
 * figure on the day, and it is written. Where the AWP changed after the fill, the current number is
 * simply the wrong one and nothing is written — a stale AWP is worse than none, because the
 * backtest divides by it and would report a contract breach that is really a price move.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/fill-claim-benchmarks.ts
 */
import "dotenv/config";

async function main() {
  const { db, schema } = await import("../src/db");
  const { eq, and, isNull, gte } = await import("drizzle-orm");

  const claims = await db.query.claims.findMany({
    where: and(gte(schema.claims.dateFilled, "2026-09-01")),
    columns: { id: true, ndc11: true, dateFilled: true, awpCents: true, wacCents: true, nadacDispensedCents: true, quantityThousandths: true },
  });
  const need = claims.filter((c) => c.ndc11 && (c.nadacDispensedCents === null || c.awpCents === null));
  console.log(`${claims.length} claims from 1 September, ${need.length} missing a benchmark price`);

  /*
   * NADAC first, from the site's own weekly files.
   *
   * Stored as the price of one dispensing unit, which is how the claim's other figures are held and
   * how the backtest reads it. The quantity is not multiplied in: a per-unit benchmark against a
   * per-unit cost is the comparison, and folding the quantity in here would make every later reader
   * undo it.
   */
  const { priceInForce } = await import("../src/lib/nadac");
  const perNdcDate = new Map<string, number | null>();
  let nadacFilled = 0;
  for (const c of need) {
    if (c.nadacDispensedCents !== null || !c.ndc11) continue;
    const key = `${c.ndc11}|${c.dateFilled}`;
    if (!perNdcDate.has(key)) {
      const p = await priceInForce(c.ndc11, c.dateFilled);
      perNdcDate.set(key, p ? Math.round(p.unitMicros / 10_000) : null);
    }
    const cents = perNdcDate.get(key);
    if (cents === null || cents === undefined) continue;
    await db.update(schema.claims).set({ nadacDispensedCents: cents }).where(eq(schema.claims.id, c.id));
    nadacFilled++;
  }
  console.log(`NADAC written on ${nadacFilled} claims`);

  // AWP and WAC, only where PioneerRx can show the price had not moved since the fill.
  const { pioneerConfig, query } = await import("../src/lib/pioneer-sql");
  const config = await pioneerConfig();
  if ("missing" in config) {
    console.log("PioneerRx is not set up, so no AWP or WAC was written.");
    return;
  }
  const ndcs = [...new Set(need.filter((c) => c.awpCents === null && c.ndc11).map((c) => c.ndc11!))];
  if (ndcs.length === 0) {
    console.log("Every claim already carries an AWP.");
    return;
  }
  const prices = await query(
    `select i.NDC as ndc,
            g.Awp as awp, convert(varchar(10), g.AwpChangedDate, 23) as awp_on,
            g.WAC as wac, convert(varchar(10), g.WACChangedDate, 23) as wac_on
       from Item.InventoryGroup g
       join Item.Item i on i.ItemID = g.ItemID
      where i.NDC is not null and g.Awp > 0`,
    {},
    50_000,
  );
  type P = { awp: number | null; awpOn: string | null; wac: number | null; wacOn: string | null };
  const byNdc = new Map<string, P>();
  for (const row of prices.rows) {
    const ndc = String(row.ndc ?? "").replace(/\D/g, "");
    if (ndc.length !== 11) continue;
    byNdc.set(ndc, {
      awp: row.awp === null ? null : Number(row.awp),
      awpOn: row.awp_on ? String(row.awp_on) : null,
      wac: row.wac === null ? null : Number(row.wac),
      wacOn: row.wac_on ? String(row.wac_on) : null,
    });
  }

  let awpFilled = 0;
  let awpMoved = 0;
  let wacFilled = 0;
  for (const c of need) {
    if (!c.ndc11) continue;
    const p = byNdc.get(c.ndc11);
    if (!p) continue;
    /*
     * Per unit times the quantity dispensed, because that is what the claim holds.
     *
     * PioneerRx keeps one AWP per dispensing unit. The claim’s `awp_cents` is the AWP of the fill,
     * which is what the dispensed export prints and what every reader here expects: $1,943.49 for
     * ninety tablets, not $21.59. Writing the per-unit figure into that column made a claim look
     * as though it had been paid twenty times its own list price, and the backtest duly reported
     * eleven contract breaches that were arithmetic of mine.
     */
    const units = (c.quantityThousandths ?? 0) / 1000;
    if (units <= 0) continue;
    const set: { awpCents?: number; wacCents?: number } = {};
    if (c.awpCents === null && p.awp !== null) {
      // The date is the proof. Without one, nothing can be said about when this price started.
      if (p.awpOn && p.awpOn <= c.dateFilled) set.awpCents = Math.round(p.awp * units * 100);
      else awpMoved++;
    }
    if (c.wacCents === null && p.wac !== null && p.wacOn && p.wacOn <= c.dateFilled) set.wacCents = Math.round(p.wac * units * 100);
    if (set.awpCents === undefined && set.wacCents === undefined) continue;
    await db.update(schema.claims).set(set).where(eq(schema.claims.id, c.id));
    if (set.awpCents !== undefined) awpFilled++;
    if (set.wacCents !== undefined) wacFilled++;
  }
  console.log(`AWP written on ${awpFilled} claims, WAC on ${wacFilled}; ${awpMoved} left blank because the price changed after the fill`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
