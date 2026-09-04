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
  /**
   * The physician who authorises immunizations under K.S.A. 65-1635a.
   *
   * Held once rather than typed onto each protocol, because every immunizer works under the same
   * one and a name typed five times is a name spelled four ways.
   */
  "protocol_physician_name",
  "pharmacy_phone",
  "pharmacy_npi",
  "pharmacy_ncpdp", // NCPDP / NABP provider number
  "pharmacy_dea",
  "pharmacy_chain_code", // PSAO-assigned; gates which rate exhibit governs a claim
  "psao_name", // Pharmacy Services Administrative Organization — not the PSO below
  "psao_member_id",
  "pso_member", // "yes" | "no"
  "pso_name",
  "pso_expires_on",
  "ai_model",
  /**
   * What a million tokens costs, in dollars, in and out.
   *
   * A setting rather than a constant because it is a fact about somebody else's price list, and
   * the alternative is a figure in the code that is wrong the first time the list changes and
   * nobody notices. Blank means the built-in default.
   */
  "ai_price_in",
  "ai_price_out",
  "anthropic_api_key_enc", // encrypted with APP_ENCRYPTION_KEY; never rendered
  "mail_enabled", // "yes" | "no"
  "mail_host",
  "mail_port",
  "mail_user",
  "mail_password_enc", // app password, encrypted; never rendered
  // The address staff reach the site on. A training link is useless without it.
  "public_base_url",
  "training_reminders_last",
  "cqi_automation_last",
  "cqi_automation_result",
  // One line per training: the type, then "=", then the link staff are sent to.
  "training_materials",
  /**
   * Whether the course text travels as a file attachment.
   *
   * Off by default, and that default is the fix for a real failure: a bare message arrived and the
   * same message with seven text files and a Word document attached did not. Providers accept it,
   * then drop it; virus and attachment filters take it out; nothing bounces and nothing is logged.
   * The course is a click away in the email either way, so the attachment buys very little and
   * costs the whole message.
   */
  "training_attach_material", // "yes" to attach; anything else, including unset, means no
  // NADAC is published weekly by CMS, free and without a key. These control the automatic pull.
  "nadac_auto", // "yes" | "no"
  "nadac_source_url",
  "nadac_last_fetch",
  "nadac_last_result",
  // ── iMonnit temperature monitoring ──
  "imonnit_key_id_enc",
  "imonnit_secret_enc",
  "imonnit_base_url",
  "imonnit_last_sync",
  "imonnit_last_result",
  "mail_allowed_senders", // one per line
  "mail_auto_import", // "yes" | "no" — load recognised reports rather than only filing them
  "mail_supplier_rules", // one per line: a sender or subject fragment, then "=", then a supplier name
  // Off by default. The reimbursement side is built and tested but waiting on data that has to
  // come from outside, and half-working pages in the daily path are a daily irritation.
  "feature_reimbursement", // "yes" | "no"
  "backup_destination",
  // A second place every verified archive is also written. One disk failing, one laptop stolen,
  // one folder deleted by accident — a single copy answers none of those.
  "backup_destination_2",
  "backup_enabled", // "no" to switch off; anything else, including unset, means on
  "backup_keep", // how many archives to keep
  "backup_last_run",
  // Checked on a background beat and cached, so the dashboard can say an update is waiting
  // without every page load reaching out to GitHub.
  "updates_last_check",
  "updates_behind",
  "updates_newest",
  "updates_check_error",
  /**
   * What each supplier is expected to ship, one rule per line: "Supplier = none | 3-5 | 2".
   *
   * Never used to classify anything. It is used the other way round — to notice when a supplier
   * sends something they never send, which is the shape of both a diversion problem and an
   * ordering mistake, and is invisible otherwise.
   */
  "supplier_expected_schedule",
  // ── The delivery driver's monthly invoice ──
  "driver_name",
  "driver_bill_to",
  "driver_invoice_to",
  "driver_rate_cents",
  "driver_payment_terms",
  "driver_invoice_auto",
  /** The first month this pharmacy started recording deliveries here. Nothing earlier is chased. */
  "driver_tracking_from",
  /** Months handled outside this site, one per line as "YYYY-MM = why". Never chased, never invoiced. */
  "driver_skipped_months",
  "driver_invoice_last_check",
  "driver_invoice_last_result",
  "manual_audit_last",
  "manual_audit_result",
  "manual_audit_auto",
  /**
   * What the "Put it right" press is doing, as JSON, so the page can show it.
   *
   * The work used to happen inside the button's own request. A press that takes a minute makes
   * the browser's router wait on it — every other link on the site stops responding until it
   * returns, which is indistinguishable from the site having frozen. So the press now only
   * starts the job and this is where the job says where it has got to.
   */
  "manual_job",
  "backup_last_result",
  "backup_last_failure",
  // The rehearsal: an archive already on disk, opened and restored to a scratch database, to prove
  // that what was written last month is still what comes back today.
  "backup_restore_last",
  "backup_restore_result",
  "mail_last_sweep",
  /**
   * The SMTP conversation from the last send, verbatim, with credentials removed.
   *
   * Kept because every other signal had been exhausted: the site said sent, the pharmacy said
   * nothing arrived, and there was no way to tell which end was wrong. The transcript settles it —
   * it shows the server's own words, the recipient it accepted, and the id it gave the message.
   */
  "mail_last_transcript",
  // Sending is not the same server as reading, and a pharmacy that cannot test it cannot tell a
  // failed send from one that was never attempted.
  "mail_smtp_host",
  "mail_smtp_port",
  "mail_smtp_working",
  "mail_last_send_result",
  // The weekly note to the PIC. Everything this site knows was otherwise only knowable by
  // opening it, which is the wrong way round for a licence that expires.
  "digest_last_sent",
  "digest_last_result",
  "digest_enabled",
  // Which version of the site-maintained appendix is in the filed policy manual, so drift between
  // the two is something the site notices rather than something somebody remembers to check.
  "manual_appendix_filed_version",
  "manual_appendix_filed_on",
  "mail_last_result",
  // ── Medicare Transaction Facilitator (MTF) ──
  // CMS's channel for Maximum Fair Price refunds under the Inflation Reduction Act. The key is
  // generated in the MTF portal's Developer Tools and is single-use in the sense that generating
  // a new one cancels the old, so it is stored encrypted and never rendered back.
  "mtf_api_key_enc",
  "mtf_key_set_on", // MTF keys expire 90 days after generation; this is what makes that visible
  "mtf_payee_id",
  "mtf_download_dir",
  "mtf_cli_path",
  "mtf_last_pull",
  "mtf_last_result",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type Settings = Record<SettingKey, string>;

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(schema.settings);
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, ""])) as Settings;
  for (const r of rows) if ((SETTING_KEYS as readonly string[]).includes(r.key)) out[r.key as SettingKey] = r.value;
  if (!out.pharmacy_state) out.pharmacy_state = "KS";
  if (!out.ai_model) out.ai_model = "claude-opus-5";
  if (!out.mail_host) out.mail_host = "imap.gmail.com";
  if (!out.mail_port) out.mail_port = "993";
  return out;
}

export async function setSetting(key: SettingKey, value: string) {
  const existing = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  if (existing) await db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key));
  else await db.insert(schema.settings).values({ key, value });
}
