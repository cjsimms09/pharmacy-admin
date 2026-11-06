/* Creates the first (or an additional) login. Usage: npm run user:create */
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const dbPath = path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db");
const client = createClient({ url: `file:${dbPath}` });

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const count = Number((await client.execute("select count(*) as n from users")).rows[0].n);
  console.log(count === 0 ? "No users yet. Create the owner login." : `${count} user(s) exist. Create another login.`);
  const name = (await rl.question("Full name: ")).trim();
  const username = (await rl.question("Username (lowercase, no spaces): ")).trim().toLowerCase();
  const roleIn = count === 0 ? "owner" : (await rl.question("Role [owner/pic/staff]: ")).trim().toLowerCase();
  const role = ["owner", "pic", "staff"].includes(roleIn) ? roleIn : "staff";
  let password = "";
  for (;;) {
    password = (await rl.question("Password (12+ characters): ")).trim();
    if (password.length >= 12) break;
    console.log("Too short.");
  }
  rl.close();
  const hash = await bcrypt.hash(password, 12);
  await client.execute({
    sql: "insert into users (id, name, username, password_hash, role, active) values (?, ?, ?, ?, ?, 1)",
    args: [crypto.randomUUID(), name, username, hash, role],
  });
  console.log(`Created ${role} login "${username}".`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
