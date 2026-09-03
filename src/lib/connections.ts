import "server-only";
import { decryptText, encryptText } from "./crypto";
import { getSettings, setSetting, type SettingKey } from "./settings";

/**
 * Credentials for outside services, in one place.
 *
 * Every secret here is encrypted at rest with APP_ENCRYPTION_KEY (AES-256-GCM) and is never
 * rendered back to the browser — only a hint, enough to confirm which key is stored without
 * exposing it. A key that has to be re-pasted to be checked is a key that ends up in a text
 * file somewhere, so the hint matters.
 */

export type Connection = {
  id: "anthropic" | "mtf" | "mail";
  name: string;
  what: string;
  /** Where the credential is obtained, in words the person fetching it can follow. */
  where: string;
  secretKey: SettingKey;
  /** Plain (non-secret) settings that belong with it. */
  fields: { key: SettingKey; label: string; hint?: string; placeholder?: string }[];
  /** Rejects an obviously wrong paste before it is stored. */
  validate?: (v: string) => string | null;
};

export const CONNECTIONS: Connection[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    what: "Reads uploaded documents, drafts CQI write-ups, and extracts contract terms.",
    where: "console.anthropic.com → Settings → API keys.",
    secretKey: "anthropic_api_key_enc",
    fields: [{ key: "ai_model", label: "Model", placeholder: "claude-opus-5" }],
    validate: (v) => (v.startsWith("sk-ant-") && v.length >= 30 ? null : "Anthropic keys start with sk-ant-."),
  },
  {
    id: "mtf",
    name: "Medicare Transaction Facilitator (MTF)",
    what:
      "Pulls 835 remittance files for Maximum Fair Price refunds on selected Part D drugs. This is the CMS " +
      "channel only — it does not carry commercial or ordinary Part D payments.",
    where:
      "The MTF portal → Developer Tools → API key → Generate. Copy it straight away: generating a new key " +
      "cancels the previous one, and the portal will not show it again.",
    secretKey: "mtf_api_key_enc",
    fields: [
      { key: "mtf_payee_id", label: "Payee ID", hint: "From Developer Tools → your remit profile.", placeholder: "" },
      { key: "mtf_cli_path", label: "Path to mtf-cli", hint: "Leave blank if it is on the system PATH.", placeholder: "mtf-cli" },
      { key: "mtf_download_dir", label: "Download folder", hint: "Where 835 files land. Defaults to data/remits/mtf.", placeholder: "data/remits/mtf" },
    ],
  },
];

export async function connectionState() {
  const s = await getSettings();
  // The MTF key belongs to the reimbursement work; no reason to show it while that is off.
  const shown = s.feature_reimbursement === "yes" ? CONNECTIONS : CONNECTIONS.filter((c) => c.id !== "mtf");
  return shown.map((c) => ({
    ...c,
    hint: hintFor(s[c.secretKey]),
    values: Object.fromEntries(c.fields.map((f) => [f.key, s[f.key] ?? ""])) as Record<string, string>,
  }));
}

/** Last four characters only. Enough to tell two keys apart, useless to anyone who sees it. */
function hintFor(stored: string | undefined): string | null {
  if (!stored) return null;
  try {
    const k = decryptText(stored);
    return k.length <= 8 ? "•".repeat(k.length) : `${"•".repeat(8)}${k.slice(-4)}`;
  } catch {
    return "(unreadable — the encryption key changed)";
  }
}

export async function saveSecret(id: Connection["id"], value: string): Promise<void> {
  const c = CONNECTIONS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown connection ${id}`);
  const v = value.trim();
  if (!v) throw new Error("Nothing to save.");
  const bad = c.validate?.(v);
  if (bad) throw new Error(bad);
  await setSetting(c.secretKey, encryptText(v));
  // MTF keys expire 90 days after generation and the portal gives no warning. Stamping the date
  // here is the only way the pharmacy finds out before a scheduled pull starts failing.
  if (id === "mtf") await setSetting("mtf_key_set_on", new Date().toISOString().slice(0, 10));
}

export async function clearSecret(id: Connection["id"]): Promise<void> {
  const c = CONNECTIONS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown connection ${id}`);
  await setSetting(c.secretKey, "");
  if (id === "mtf") await setSetting("mtf_key_set_on", "");
}

/** Decrypts a stored secret for use on the server. Never send the result to the browser. */
export async function readSecret(id: Connection["id"]): Promise<string | null> {
  const c = CONNECTIONS.find((x) => x.id === id);
  if (!c) return null;
  const s = await getSettings();
  const raw = s[c.secretKey];
  if (!raw) return null;
  try {
    return decryptText(raw);
  } catch {
    return null;
  }
}
