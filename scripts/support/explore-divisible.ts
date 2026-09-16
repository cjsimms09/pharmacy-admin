import "dotenv/config";
import { db } from "../../src/db";

async function q(label: string, sql: string) {
  const r = await (db as any).$client.execute(sql);
  console.log("\n=== " + label + " ===");
  for (const row of r.rows) console.log(JSON.stringify(row));
}

async function main() {
  await q("basis_of_reimbursement values", `select basis_of_reimbursement b, count(*) n from claims group by 1 order by n desc`);
  await q("basis_of_cost_determination values", `select basis_of_cost_determination b, count(*) n from claims group by 1 order by n desc`);
  await q("dispensed NDC counts", `select count(*) claims, count(distinct ndc11) ndcs from claims where ndc11 is not null`);
  await q("dispensed NDCs in directory", `select count(distinct c.ndc11) n from claims c join drug_directory d on d.ndc11 = c.ndc11 where c.ndc11 is not null`);
  await q("forms of dispensed NDCs", `select d.form, count(distinct d.ndc11) n from claims c join drug_directory d on d.ndc11=c.ndc11 group by 1 order by n desc limit 60`);
  await q("routes of dispensed NDCs", `select d.route, count(distinct d.ndc11) n from claims c join drug_directory d on d.ndc11=c.ndc11 group by 1 order by n desc limit 40`);
  await q("te_code of dispensed NDCs", `select d.te_code, count(distinct d.ndc11) n from claims c join drug_directory d on d.ndc11=c.ndc11 group by 1 order by n desc limit 40`);
  process.exit(0);
}
main();
