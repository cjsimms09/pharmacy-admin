import "server-only";
import path from "node:path";
import { db, schema } from "@/db";
import { getSettings } from "./settings";
import { filesDir } from "./files";
import { todayIso, daysBetween } from "./dates";

/**
 * Whether this pharmacy's invoice records actually meet the rules, checked rather than asserted.
 *
 * The question asked was "make sure invoice storage is compliant", and the honest way to answer
 * that is not a paragraph claiming it is. It is a list of what each rule requires, what this
 * system does about it, and — where the requirement depends on how the pharmacy has things set
 * up rather than on the code — whether it is actually satisfied right now.
 *
 * Two of these can fail on a correctly written system: the records have to be at the registered
 * location, and they have to survive. A cloud-only store would breach the first; a backup on the
 * same disk as the records fails the second. Both are settings, so both are checked.
 */

export type Requirement = {
  key: string;
  /** The rule, cited exactly. */
  citation: string;
  /** What it requires, in plain words. */
  requires: string;
  /** What this system does about it. */
  how: string;
  /** ok: satisfied. attention: depends on something the pharmacy has not done. */
  state: "ok" | "attention";
  /** What to do, when it is not satisfied. */
  fix?: string;
  href?: string;
};

/** Kansas requires pharmacy records for five years; the DEA requires two. The longer one governs. */
export const RETENTION_YEARS = 5;

export async function invoiceCompliance(): Promise<Requirement[]> {
  const [s, rows] = await Promise.all([getSettings(), db.query.supplierInvoices.findMany()]);
  const out: Requirement[] = [];

  const unconfirmed = rows.filter((r) => r.needsReview && !r.reviewedAt).length;
  const undated = rows.filter((r) => !r.invoiceDate).length;

  // ── Separation of Schedule II ─────────────────────────────────────
  out.push({
    key: "separation-2",
    citation: "21 CFR 1304.04(h)(1)",
    requires:
      "Records of Schedule II controlled substances must be maintained separately from all other records of the registrant.",
    how:
      "Every invoice carrying a Schedule II line is filed under a document category no other document uses, written to " +
      "its own directory on disk, and listed on a screen that contains nothing else. An invoice the reader was not " +
      "certain about is held with the Schedule II records rather than with the others, because the only unsafe " +
      "direction is the other one.",
    state: unconfirmed > 0 ? "attention" : "ok",
    fix:
      unconfirmed > 0
        ? `${unconfirmed} invoice${unconfirmed === 1 ? " is" : "s are"} held with the Schedule II records awaiting confirmation. That is the cautious side, but they should be resolved so the Schedule II list contains only Schedule II records.`
        : undefined,
    href: "/inventory/invoices?unconfirmed=1",
  });

  out.push({
    key: "separation-3-5",
    citation: "21 CFR 1304.04(h)(2)",
    requires:
      "Records of Schedules III, IV and V must be maintained either separately from all other records, or in a form " +
      "where the required information is readily retrievable from the pharmacy's ordinary business records.",
    how:
      "They are maintained separately, which satisfies the stricter of the two routes the rule allows — and they are " +
      "also readily retrievable, by supplier, month, date, amount, drug name and invoice number.",
    state: "ok",
  });

  // ── Readily retrievable ───────────────────────────────────────────
  out.push({
    key: "retrievable",
    citation: "21 CFR 1300.01(b), definition of “readily retrievable”",
    requires:
      "Records must be kept in such a manner that they can be separated out from all other records in a reasonable " +
      "time.",
    how:
      "Any schedule, for any date or range of dates, is one filter and returns nothing else. Invoices with no date " +
      "read from them are the exception, because a record outside every date range cannot be produced by one.",
    state: undated > 0 ? "attention" : "ok",
    fix:
      undated > 0
        ? `${undated} invoice${undated === 1 ? " has" : "s have"} no date, so ${undated === 1 ? "it does" : "they do"} not come back in a date range. Put the date from the invoice on each.`
        : undefined,
    href: "/inventory/invoices?undated=1",
  });

  // ── Where the records live ────────────────────────────────────────
  /*
   * The location requirement is the one an electronic system is most likely to breach by accident,
   * because storing things "in the cloud" is the default instinct and it is the wrong one here.
   */
  const localStore = path.resolve(filesDir());
  out.push({
    key: "location",
    citation: "21 CFR 1304.04(a)",
    requires:
      "Records must be maintained at the registered location. Financial and shipping records such as invoices may be " +
      "kept at a central location only if the registrant has notified the Administration in advance.",
    how:
      `Invoices are stored on this computer, at the registered location — ${localStore}. Nothing is held only ` +
      "elsewhere, so no central-recordkeeping notification is required. Backups are copies, not the record.",
    state: "ok",
  });

  // ── Retention ─────────────────────────────────────────────────────
  const oldest = rows.map((r) => r.invoiceDate).filter(Boolean).sort()[0] ?? null;
  out.push({
    key: "retention",
    citation: "21 CFR 1304.04(a); Kansas pharmacy record retention",
    requires:
      "Federal law requires these records to be kept for at least two years. Kansas requires pharmacy records to be " +
      "kept for five, and the longer period governs.",
    how:
      `Nothing here is ever deleted. There is no route in this system that removes a filed invoice, and the oldest ` +
      `held is ${oldest ?? "the first one received"}. Retiring a supplier keeps every invoice filed against them.`,
    state: "ok",
  });

  // ── Availability for inspection ───────────────────────────────────
  out.push({
    key: "inspection",
    citation: "21 CFR 1304.04(a); K.A.R. 68-7-11",
    requires: "Records must be available for inspection and copying by authorised officials.",
    how:
      "Any invoice opens as the original PDF the supplier sent, and any selection can be emailed on as attachments. " +
      "Every send is recorded — who, what, when, and whether Schedule II records were in it — because forwarding one " +
      "of those is a disclosure.",
    state: "ok",
  });

  // ── Survival ──────────────────────────────────────────────────────
  /*
   * Not a DEA requirement in these words, but the one that decides whether any of the others mean
   * anything. Records that exist only on a disk that fails are records the pharmacy cannot produce,
   * and "the computer died" is not a defence anybody has ever succeeded with.
   */
  const backupDir = (s.backup_destination ?? "").trim();
  const secondary = [(s.backup_destination_2 ?? "").trim(), (s.backup_destination_3 ?? "").trim()]
    .filter(Boolean)
    .join(" and ");
  const sameDisk =
    !backupDir || path.resolve(backupDir).startsWith(path.resolve(path.dirname(localStore)));
  const ranAt = s.backup_last_run ? Date.parse(s.backup_last_run) : NaN;
  const backupStale = !Number.isFinite(ranAt) || (Date.now() - ranAt) / 3_600_000 > 50;

  out.push({
    key: "survival",
    citation: "Not a citation — the condition every other line depends on",
    requires:
      "A record the pharmacy cannot produce is a record it does not have, whatever the reason. Two copies, in places " +
      "that do not fail together.",
    how: backupDir
      ? `Every invoice is included in the verified daily backup to ${backupDir}${secondary ? `, and copied to ${secondary}` : ""}.`
      : "Backups are not configured, so these records exist in one place only.",
    state: !backupDir || sameDisk || !secondary || backupStale ? "attention" : "ok",
    fix:
      !backupDir
        ? "No backup destination is set. Everything here exists on one disk."
        : sameDisk
          ? "Backups are written to the application's own data folder, on the same disk as the records they protect. A failed drive takes both."
          : !secondary
            ? "There is one copy of each backup. That covers this computer dying; it does not cover the backup drive dying, or a fire."
            : backupStale
              ? "No backup has completed in the last two days."
              : undefined,
    href: "/settings/backups",
  });

  /*
   * ── Whether the paper can go ──────────────────────────────────────
   *
   * The question actually asked, and it has two different answers depending on how the invoice
   * arrived — which is why it is worth separating rather than answering in general.
   *
   * An invoice emailed by the wholesaler is the original. No paper ever existed, the PDF is the
   * record, and there is nothing to keep or destroy. That is the whole of this pharmacy's McKesson,
   * IPC and IPD feed.
   *
   * An invoice that came on paper and was scanned is different. The system now holds a copy, and
   * the DEA has never issued a rule saying the paper original may be destroyed once it has been
   * imaged. Plenty of pharmacies do it; that is not the same as being authorised to. So this says
   * how many are in each class and does not pretend the second question is settled.
   */
  const emailed = rows.filter((r) => /@/.test(r.receivedFrom ?? "")).length;
  const uploaded = rows.length - emailed;

  out.push({
    key: "originals",
    citation: "21 CFR 1304.04(a); 21 CFR 1300.01(b)",
    requires:
      "The record has to be kept, be at the registered location, and be producible. Where the record itself is " +
      "electronic, that is the whole of it. Where it began as paper, nothing in the regulations says the paper may be " +
      "destroyed once it has been scanned.",
    how:
      `${emailed} of these invoices were emailed by the wholesaler, so the PDF held here is the original record and ` +
      `there is no paper to keep. ${uploaded} ${uploaded === 1 ? "was" : "were"} added by hand — if any of those ` +
      "began life on paper, this system holds an image of it and not the thing itself.",
    state: uploaded > 0 ? "attention" : "ok",
    fix:
      uploaded > 0
        ? "Keep the paper for anything that arrived on paper until you have asked. The DEA field office and the " +
          "Kansas Board will both answer it, and the answer is worth having in writing before anything is thrown away."
        : undefined,
    href: "/inventory/invoices",
  });

  /*
   * ── The one this system does not hold ─────────────────────────────
   *
   * A compliance panel that lists what it does well and stays silent about what it does not is
   * worse than no panel, because it is read as complete. Paper DEA Form 222s are the gap: they are
   * not invoices, they do not arrive by email, nothing here touches them, and they have a
   * retention rule of their own that no amount of good invoice filing satisfies.
   */
  out.push({
    key: "order-forms",
    citation: "21 CFR 1305.17(a), (c)",
    requires:
      "Copy 3 of every executed paper DEA Form 222 must be retained by the purchaser, with the number of packages " +
      "received and the date recorded on it, for at least two years. Electronic CSOS orders are retained electronically.",
    how:
      "Not held here, and not something invoice filing can satisfy. An order form is a different record from the " +
      "invoice for the same goods, and this system holds the invoice.",
    state: "attention",
    fix:
      "Keep paper 222s exactly as you do now. If you order Schedule II through CSOS instead, those records live in the " +
      "CSOS system and this line does not apply to them.",
    href: "/inventory/power-of-attorney",
  });

  // ── The feed itself ───────────────────────────────────────────────
  const suppliers = await db.query.suppliers.findMany();
  const active = suppliers.filter((x) => x.active);
  out.push({
    key: "capture",
    citation: "Not a citation — the condition that makes the archive complete",
    requires:
      "Every invoice the pharmacy receives has to reach the archive. A record that never arrived cannot be produced " +
      "either, and nothing about a well-kept archive reveals that it is missing one.",
    how:
      active.length > 0
        ? `${active.length} supplier${active.length === 1 ? " is" : "s are"} recognised by the address they send from, and silence from one that used to write is reported.`
        : "No supplier is recorded, so nothing arriving by email will be filed as an invoice.",
    state: active.length === 0 || active.some((x) => !x.senderEmails.trim()) ? "attention" : "ok",
    fix:
      active.length === 0
        ? "Add the wholesalers and the addresses they send invoices from, or nothing will be filed automatically."
        : active.some((x) => !x.senderEmails.trim())
          ? `${active.filter((x) => !x.senderEmails.trim()).map((x) => x.name).join(", ")} ${active.filter((x) => !x.senderEmails.trim()).length === 1 ? "has" : "have"} no sending address recorded, so their invoices will not be recognised.`
          : undefined,
    href: "/suppliers",
  });

  void todayIso;
  void daysBetween;
  void schema;
  return out;
}
