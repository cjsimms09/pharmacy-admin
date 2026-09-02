import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

export const SETTING_KEYS = [
  "pharmacy_name",
  "pharmacy_registration_number",
  "pharmacy_address",
  "pharmacy_city",
  "pharmacy_state",
  "pharmacy_zip",
  "pharmacy_county",
  "pharmacy_phone",
  "pso_member", // "yes" | "no"
  "pso_name",
  "pso_expires_on",
  "ai_model",
  "anthropic_api_key_enc", // encrypted with APP_ENCRYPTION_KEY; never rendered
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type Settings = Record<SettingKey, string>;

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(schema.settings);
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, ""])) as Settings;
  for (const r of rows) if ((SETTING_KEYS as readonly string[]).includes(r.key)) out[r.key as SettingKey] = r.value;
  if (!out.pharmacy_state) out.pharmacy_state = "KS";
  if (!out.ai_model) out.ai_model = "claude-opus-5";
  return out;
}

export async function setSetting(key: SettingKey, value: string) {
  const existing = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  if (existing) await db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key));
  else await db.insert(schema.settings).values({ key, value });
}
