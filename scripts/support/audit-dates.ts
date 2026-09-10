import "dotenv/config";
import { db } from "../../src/db";
import { sql } from "drizzle-orm";

async function q(label: string, s: string) {
  console.log(`\n== ${label} ==`);
  try {
    const r = await db.run(sql.raw(s));
    for (const row of r.rows as unknown as Record<string, unknown>[]) console.log(JSON.stringify(row));
  } catch (e) {
    console.log("ERR " + (e as Error).message.slice(0, 300));
  }
}

async function main() {
  const rxs = ["335221","333105","335656","335687","335705","334124","299248","335863","335877","335906","335907","335884","322492","336115","327403","335996","302567","336042","327747","324526"];
  await q(
    "every claim row for each stranded-reversal prescription",
    `select rx_number, fill_number, date_filled, status, bin, ndc11, remit_cents, copay_cents, patient_total_cents, acquisition_cents,
            case when reversal_key is null then '-' when reversal_key=transaction_key then 'SELF' else 'PAIRED' end rk, completed_at
     from claims where rx_number in (${rxs.map((r) => `'${r}'`).join(",")}) order by rx_number, fill_number, date_filled, status desc`,
  );

  await q(
    "would a bin-blind, copay-blind pairing find a partner? (remit exact negation, same rx+fill+ndc)",
    `select r.rx_number, r.fill_number, r.bin rev_bin, p.bin paid_bin, r.remit_cents rev_remit, p.remit_cents paid_remit,
            r.copay_cents rev_copay, p.copay_cents paid_copay, p.patient_total_cents paid_total, p.status
     from claims r join claims p
       on p.rx_number=r.rx_number and coalesce(p.fill_number,-1)=coalesce(r.fill_number,-1) and p.ndc11=r.ndc11
      and p.remit_cents = -r.remit_cents and p.id<>r.id
     where r.remit_cents<0 and r.status='reversed' and r.reversal_key=r.transaction_key
       and not exists (select 1 from claims o where o.id<>r.id and o.reversal_key=r.transaction_key)`,
  );

  await q(
    "how the till reversal rows differ: bin mismatch count / copay mismatch count",
    `select sum(case when p.bin <> r.bin then 1 else 0 end) bin_diff,
            sum(case when p.copay_cents <> -r.copay_cents then 1 else 0 end) copay_diff,
            count(*) n
     from claims r join claims p
       on p.rx_number=r.rx_number and coalesce(p.fill_number,-1)=coalesce(r.fill_number,-1) and p.ndc11=r.ndc11
      and p.remit_cents = -r.remit_cents and p.id<>r.id and p.status='paid'
     where r.remit_cents<0 and r.status='reversed' and r.reversal_key=r.transaction_key
       and not exists (select 1 from claims o where o.id<>r.id and o.reversal_key=r.transaction_key)`,
  );

  await q(
    "revenue standing on claims that a stranded reversal cancels (remit exact negation, still paid)",
    `select count(*) n, sum(p.remit_cents) remit, sum(coalesce(p.patient_total_cents,p.copay_cents,0)) pat, sum(coalesce(p.acquisition_cents,0)) acq,
            sum(case when coalesce(p.completed_at,p.sold_on) is not null then 1 else 0 end) sold
     from claims r join claims p
       on p.rx_number=r.rx_number and coalesce(p.fill_number,-1)=coalesce(r.fill_number,-1) and p.ndc11=r.ndc11
      and p.remit_cents = -r.remit_cents and p.id<>r.id and p.status='paid'
     where r.remit_cents<0 and r.status='reversed' and r.reversal_key=r.transaction_key
       and not exists (select 1 from claims o where o.id<>r.id and o.reversal_key=r.transaction_key)`,
  );

  await q(
    "reversed claims whose fillKey collides with a live paid claim (same rx|fill|dateFilled|ndc)",
    `select count(distinct r.rx_number||'|'||coalesce(r.fill_number,'')||'|'||r.date_filled||'|'||coalesce(r.ndc11,'')) n
     from claims r join claims p on p.rx_number=r.rx_number and coalesce(p.fill_number,-1)=coalesce(r.fill_number,-1)
       and p.date_filled=r.date_filled and coalesce(p.ndc11,'')=coalesce(r.ndc11,'') and p.status='paid'
     where r.status='reversed'`,
  );
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
