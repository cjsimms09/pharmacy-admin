// THROWAWAY read-only. Delete before finishing.
import { createClient } from "@libsql/client";
const db = createClient({ url: "file:./data/pharmacy-admin.db" });
const rows = (await db.execute("select file_name, body from contract_text where file_name like '%Caremark - 2025 Provider Manual (State Addenda Supplement)%' or file_name like '%Caremark - 2026 Provider Manual.pdf%' or file_name like '%Caremark - 2025 Provider Manual (Dispute%'")).rows;
for (const r of rows) { console.log("\n########## " + r.file_name + " ##########\n"); console.log(r.body); }
