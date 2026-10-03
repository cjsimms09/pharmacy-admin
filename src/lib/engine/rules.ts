import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * What the site has learned and been told, kept as data the engine reads: an answer given once is a rule from then on.
 *
 * docs/REBUILD.md: "every answer you give becomes a rule the engine reads … it is data, not code." Kept in the
 * settings table under one key, as the draw cadences and the cheque expectations are, so no migration stands
 * between an answer and its taking effect. Each rule says who said it and when; a measured rule says what it
 * was measured on.
 *
 *   programme_route   how a manufacturer programme pays and how long it takes (CNRX → RedSail's copay 835s, ~8 weeks)
 *   payer_alias       one payer under two names (SS&C HEALTH ↔ ARGUS HEALTH SYS)
 *   vendor_category   a card charge's category by vendor (Anthropic → Software and systems)
 */
const KEY = "engine_rules";

export type Rule = { kind: string; key: string; value: Record<string, unknown>; saidBy: string; saidOn: string };

export async function rules(kind?: string): Promise<Rule[]> {
  const rows = await db.all<{ value: string | null }>(sql`select value from settings where key = ${KEY}`);
  let all: Rule[] = [];
  try {
    all = rows[0]?.value ? (JSON.parse(rows[0].value) as Rule[]) : [];
  } catch {
    all = [];
  }
  return kind ? all.filter((r) => r.kind === kind) : all;
}

export async function setRule(r: Omit<Rule, "saidOn"> & { saidOn?: string }): Promise<Rule[]> {
  const all = (await rules()).filter((x) => !(x.kind === r.kind && x.key === r.key));
  all.push({ ...r, saidOn: r.saidOn ?? new Date().toISOString().slice(0, 10) });
  const value = JSON.stringify(all);
  const existing = await db.all<{ key: string }>(sql`select key from settings where key = ${KEY}`);
  if (existing.length) await db.run(sql`update settings set value = ${value} where key = ${KEY}`);
  else await db.run(sql`insert into settings (key, value) values (${KEY}, ${value})`);
  return all;
}

export async function rule(kind: string, key: string): Promise<Rule | null> {
  return (await rules(kind)).find((r) => r.key.toLowerCase() === key.toLowerCase()) ?? null;
}
