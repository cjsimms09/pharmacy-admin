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
  id: "anthropic" | "mtf" | "mail" | "imonnit" | "pioneerrx" | "sftp";
  name: string;
  what: string;
  /** Where the credential is obtained, in words the person fetching it can follow. */
  where: string;
  secretKey: SettingKey;
  /** Label for the secret, when "API key" is not what the service calls it. */
  secretLabel?: string;
  /** Some services issue a pair. iMonnit gives a key ID and a secret, and both are needed. */
  secondSecretKey?: SettingKey;
  secondSecretLabel?: string;
  /** Where the rest of the setup for this service lives, when it is not on this page. */
  more?: { href: string; label: string };
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
    id: "imonnit",
    name: "iMonnit temperature sensors",
    what:
      "Pulls refrigerator and freezer readings so a month can be printed, explained and signed here rather than in " +
      "the vendor's portal.",
    where:
      "In iMonnit, under your account settings, generate an API key. It comes as two parts — a key ID and a secret " +
      "— and both are needed.",
    secretKey: "imonnit_key_id_enc",
    secretLabel: "API Key ID",
    secondSecretKey: "imonnit_secret_enc",
    secondSecretLabel: "API Secret Key",
    fields: [
      { key: "imonnit_base_url", label: "Address", hint: "Leave blank unless Monnit have told you otherwise.", placeholder: "https://www.imonnit.com/json" },
    ],
    more: { href: "/temps", label: "Choose which sensors to log" },
  },
  {
    id: "pioneerrx",
    name: "PioneerRx database",
    what:
      "Reads claims, the drug file and what is on hand straight from PioneerRx’s SQL Server, so nothing has to be " +
      "exported and uploaded. The site only ever reads: read-only intent, no locks, one SELECT at a time.",
    where:
      "RedSail (PioneerRx support) gives the instance name, the database name, a user and a password when SQL access " +
      "is turned on for the pharmacy. Type the first three below and paste the password.",
    secretKey: "pioneer_sql_password_enc",
    secretLabel: "Password",
    fields: [
      { key: "pioneer_sql_server", label: "Server or instance", hint: "As RedSail wrote it: a name, NAME\\INSTANCE, or NAME,1433.", placeholder: "PRXSERVER\\PIONEERRX" },
      { key: "pioneer_sql_database", label: "Database", placeholder: "PioneerRx" },
      { key: "pioneer_sql_user", label: "User", placeholder: "" },
    ],
    more: { href: "/tools/pioneer-sql", label: "Test the connection and read the table names" },
  },
  {
    id: "sftp",
    name: "Remittance SFTP mailbox",
    what:
      "The host RedSail and the PBMs push remittances to. The site collects every file there each half hour, files it, " +
      "loads what it recognises (an 835 through the remittance reader) and moves the original to done/ on the host.",
    where:
      "The host was set up with scripts/sftp-host-setup.sh. The site logs in with its own key from data/sftp/; a password " +
      "is only needed where that key is not on the host.",
    secretKey: "sftp_password_enc",
    secretLabel: "Password (optional, when the site’s key is not on the host)",
    fields: [
      { key: "sftp_host", label: "Host", placeholder: "remits.example.com or an address" },
      { key: "sftp_port", label: "Port", placeholder: "22" },
      { key: "sftp_user", label: "User", placeholder: "pharmacy" },
      { key: "sftp_folder", label: "Folder", hint: "Where senders drop files.", placeholder: "/inbox" },
    ],
    more: { href: "/settings/email", label: "Automatic loading is the same switch as email" },
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
  // MTF belongs to the reimbursement work and hides with it. Everything else is compliance and
  // stays: a key you cannot find a home for is a key that ends up in a text file.
  const shown = s.feature_reimbursement === "yes" ? CONNECTIONS : CONNECTIONS.filter((c) => c.id !== "mtf");
  return shown.map((c) => ({
    ...c,
    hint: hintFor(s[c.secretKey]),
    secondHint: c.secondSecretKey ? hintFor(s[c.secondSecretKey]) : null,
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

export async function saveSecret(id: Connection["id"], value: string, second?: string): Promise<void> {
  const c = CONNECTIONS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown connection ${id}`);
  const v = value.trim();
  const v2 = (second ?? "").trim();

  // A paired credential is only useful whole. Storing half of it would leave the service looking
  // configured and failing on every call, which is the least helpful of the possible states.
  if (c.secondSecretKey) {
    const s = await getSettings();
    const haveFirst = Boolean(s[c.secretKey]);
    const haveSecond = Boolean(s[c.secondSecretKey]);
    if ((!v && !haveFirst) || (!v2 && !haveSecond)) {
      throw new Error(`Both the ${c.secretLabel ?? "key"} and the ${c.secondSecretLabel ?? "secret"} are needed.`);
    }
    if (v2) await setSetting(c.secondSecretKey, encryptText(v2));
    if (!v) return;
  } else if (!v) {
    throw new Error("Nothing to save.");
  }

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
  if (c.secondSecretKey) await setSetting(c.secondSecretKey, "");
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
