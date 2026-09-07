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
  "pharmacy_tin", // Federal tax id, which an ERA/EFT enrollment asks for and nothing else on the site does
  "pharmacy_dea",
  "pharmacy_chain_code", // PSAO-assigned; gates which rate exhibit governs a claim
  "psao_name", // Pharmacy Services Administrative Organization — not the PSO below
  "psao_member_id",
  "pso_member", // "yes" | "no"
  "pso_name",
  "pso_expires_on",
  /**
   * The pharmacy's logo, as a document id.
   *
   * Held as a reference rather than a path so it travels with the backup like any other document
   * and cannot end up pointing at a file that was never copied.
   */
  "logo_document_id",
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
  /**
   * A ceiling, in dollars, on what Claude may cost in any rolling month.
   *
   * Not a cost control so much as a way to stop worrying about one. A pharmacist paying his own
   * API bill should be able to set a number he is comfortable with and then stop thinking about
   * it, rather than watching a button and wondering. Blank means no ceiling.
   */
  "ai_monthly_cap",
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
  // When it last actually succeeded, which is a different question from when it last ran.
  "nadac_last_ok",
  // What data.medicaid.gov currently calls its NADAC datasets, as JSON, read from the listing at
  // most once a week. The yearly dataset's id changes every January; this is how it is followed.
  "nadac_datasets_json",
  /*
   * The Kansas Medicaid professional dispensing fee, in cents.
   *
   * SB 20 sets the floor at NADAC plus the *greater* of $10.50 or this fee, so leaving it unset
   * is safe — the statutory minimum applies — but it understates the floor if the state fee is
   * higher. Entered rather than hard-coded because the state changes it and a figure that drifts
   * silently is worse than one somebody had to type.
   */
  "ks_medicaid_dispensing_fee_cents",
  /** How many months of weekly NADAC files to keep behind today. The claims need the price in force on their fill date; a year and a half covers every fill the floor can reach. Default 18. */
  "nadac_keep_months",
  /*
   * The smallest shortfall worth putting in front of the Insurance Department, in cents.
   *
   * Not a legal threshold — there is none. It exists because a schedule padded with eleven-cent
   * lines invites an argument about rounding instead of an argument about the statute.
   */
  "floor_materiality_cents",
  /*
   * The generic rebate tier rate from the McKesson rebate report, as a percentage.
   *
   * Read off the report rather than modelled: the rate depends on a scrubbed generic compliance
   * rate with drugs carved out of it, and a figure this site worked out for itself would be a
   * guess sitting inside a purchasing recommendation. Left empty, every comparison uses gross
   * invoice prices and says so, which understates the pharmacy's position rather than inventing a
   * discount it may not earn.
   */
  "mck_generic_rebate_rate",
  /* The last rebate breakdown read, so the page can say where the rate came from and when. */
  "mck_rebate_last_statement",
  /*
   * Where the compliance ratio stands today, off the daily Purchase Drill Down.
   *
   * A different fact from the monthly settlement and it has to be kept apart from it. The
   * settlement says what was earned last month; this says which band an order placed this morning
   * will be discounted in. Pricing today's decision off last month's closed figure is the whole
   * error this exists to prevent.
   */
  "rebate_ratio_latest",
  /*
   * A returns policy read from a PDF but not yet confirmed.
   *
   * One at a time, holding the supplier it belongs to, because it is a step in a conversation
   * rather than a record: read the policy, check each figure against its quote, save. A draft left
   * behind is replaced by the next read, and saving clears it.
   */
  "returns_policy_draft",
  // ── iMonnit temperature monitoring ──
  "imonnit_key_id_enc",
  "imonnit_secret_enc",
  "imonnit_base_url",
  "imonnit_last_sync",
  "imonnit_last_result",
  "mail_allowed_senders", // one per line
  "mail_auto_import", // "yes" | "no" — load recognised reports rather than only filing them
  /*
   * Where the record of receipt for controlled substances is kept, when it is not kept here.
   *
   * 21 CFR 1304.22(c) wants a record of what arrived and when. Most pharmacies confirm receipt in
   * the wholesaler's own ordering system as the tote is checked in — this pharmacy does — and
   * asking them to do it a second time here is duplicate work that would go undone within a week,
   * leaving a panel permanently red about a record that does exist. Naming the system settles it:
   * the panel says where the record is rather than that there is none, and stops asking.
   */
  "receipt_record_kept_in",
  /*
   * How this pharmacy actually works, on the handful of points its manual depends on — one JSON
   * row rather than a column per question, because the list changes as the manual does and a
   * migration per question is a reason not to ask one. See practice-decisions.ts.
   */
  "practice_decisions",
  "mail_supplier_rules", // one per line: a sender or subject fragment, then "=", then a supplier name
  // Off by default. The reimbursement side is built and tested but waiting on data that has to
  // come from outside, and half-working pages in the daily path are a daily irritation.
  "feature_reimbursement", // "yes" | "no"
  "backup_destination",
  // A second place every verified archive is also written. One disk failing, one laptop stolen,
  // one folder deleted by accident — a single copy answers none of those.
  "backup_destination_2",
  /**
   * A third place, because two is not the number the rule asks for.
   *
   * Three copies, on two kinds of media, one of them off the premises. A USB drive in a drawer and
   * a synced cloud folder fail in different ways and neither of them is this computer, which is
   * the whole point.
   */
  "backup_destination_3",
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
  /**
   * Who actually pays the driver: "clinic" (the default) or "pharmacy".
   *
   * The site raises the driver's invoice and sends it, but raising an invoice says nothing about
   * whose money it is. Here it is raised on the driver's behalf and billed to the clinic, so the
   * amount is neither the pharmacy's revenue nor its cost and must stay out of the account — and
   * the account says so rather than leaving the omission to be noticed. Where a pharmacy pays its
   * own driver, this makes the month's invoices an operating cost, which is what they are.
   */
  "driver_paid_by",
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
   * The roles the inherited manual keeps naming, and who actually holds them here.
   *
   * The handbook came from a physician practice: complaints go to a Human Resources Manager,
   * appeals to a Chief Administrator, keys to a Department Manager. Nobody at this pharmacy holds
   * any of those titles, so the manual routes its own procedures to people who do not exist —
   * which is a finding the pharmacy wrote for itself. Nine audit findings across six sections are
   * that one problem, and one answer settles all of them.
   */
  "role_complaints",
  "role_complaints_alt",
  "role_hiring",
  "role_termination",
  /** Which schedules the DEA registration covers. On the certificate, nowhere else in the site. */
  "dea_schedules",
  /**
   * What the "Put it right" press is doing, as JSON, so the page can show it.
   *
   * The work used to happen inside the button's own request. A press that takes a minute makes
   * the browser's router wait on it — every other link on the site stops responding until it
   * returns, which is indistinguishable from the site having frozen. So the press now only
   * starts the job and this is where the job says where it has got to.
   */
  "manual_job",
  // The NADAC fetch as a background job, for the same reason the manual audit is one.
  "nadac_job",
  // The FDA drug directory and Orange Book fetch. Two multi-megabyte zips, so the same shape again.
  "drug_directory_job",
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
  /* Whether the daily fetch runs on its own. Anything but "no" means it does. */
  "mtf_auto",
  "mtf_last_pull",
  "mtf_last_result",

  // Where a supply order from the Supplies page is sent. The pharmacy orders bags, labels and
  // vials by emailing a rep, so the address is the whole of the integration.
  "supplies_rep_email",
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
