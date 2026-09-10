import { createClient } from "@libsql/client";
const c = createClient({ url: "file:" + process.cwd() + "/data/pharmacy-admin.db" });
console.log("cols:", (await c.execute("select name from pragma_table_info('plan_groups')")).rows.map(r=>r.name).filter(n=>n.startsWith('proposed')).join(","));
console.log("idx:", (await c.execute("select name from sqlite_master where type='index' and tbl_name='pioneer_plan_types'")).rows.map(r=>r.name).join(","));
