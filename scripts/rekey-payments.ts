/**
 * Re-keys the payments the facilitator sent under its own spelling of the prescription.
 *
 * Until 8 September the 835 reader filed "000000318553FILL1" whole as the prescription number, so
 * none of the facilitator's payments could find its claim or its fill. The reader now splits that
 * spelling; this puts the rows already held on the same footing, and looks the claim up again the
 * way the reader does. The original reference is kept on the row's `reference`, so nothing is
 * lost. Safe to run again: a row already split is left alone.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/rekey-payments.ts
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:" + (process.env.DATABASE_PATH || "./data/pharmacy-admin.db") });

function split(reference: string): { rxNumber: string; fillNumber: number | null } | null {
  const r = reference.trim();
  const fill = /^0*(\d+)\s*FILL\s*(\d+)$/i.exec(r);
  if (fill) return { rxNumber: fill[1], fillNumber: Number(fill[2]) };
  const padded = /^0+(\d+)$/.exec(r);
  if (padded) return { rxNumber: padded[1], fillNumber: null };
  return null;
}

async function main() {
  const rows = (await db.execute(`select id, rx_number, fill_number, date_filled, ndc11 from claim_payments where claim_id is null`)).rows as unknown as {
    id: string; rx_number: string; fill_number: number | null; date_filled: string | null; ndc11: string | null;
  }[];
  let rekeyed = 0, matched = 0, untouched = 0;
  for (const p of rows) {
    const s = split(p.rx_number);
    const rx = s?.rxNumber ?? p.rx_number.trim();
    const fillNumber = s?.fillNumber ?? p.fill_number;
    const claims = (await db.execute({ sql: `select id, fill_number, date_filled, ndc11 from claims where rx_number = ?`, args: [rx] })).rows as unknown as {
      id: string; fill_number: number | null; date_filled: string; ndc11: string | null;
    }[];
    const levels = [
      (c: (typeof claims)[number]) => (fillNumber === null || c.fill_number === fillNumber) && (p.date_filled === null || c.date_filled === p.date_filled) && (p.ndc11 === null || c.ndc11 === p.ndc11),
      (c: (typeof claims)[number]) => (p.date_filled === null || c.date_filled === p.date_filled) && (p.ndc11 === null || c.ndc11 === p.ndc11),
    ];
    let claimId: string | null = null;
    for (const fits of levels) {
      const hits = claims.filter(fits);
      if (hits.length >= 1) { claimId = hits[0].id; break; }
    }
    if (!s && !claimId) { untouched++; continue; }
    await db.execute({ sql: `update claim_payments set rx_number = ?, fill_number = ?, claim_id = coalesce(?, claim_id) where id = ?`, args: [rx, fillNumber, claimId, p.id] });
    if (s) rekeyed++;
    if (claimId) matched++;
  }
  console.log(`${rows.length} payments without a claim looked at: ${rekeyed} re-keyed to the bare prescription number, ${matched} now on a claim, ${untouched} left as they were.`);
  await db.close();
}
main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
