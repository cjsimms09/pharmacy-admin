/**
 * The retention clock: how long each kind of record must be kept, and so which documents on file may now be
 * destroyed and which must never be, said in one place with the rule that says so.
 *
 * Only periods the rule is sure of are written here, each with its citation; where Kansas and a federal rule both
 * apply the longer wins, because a record kept for the shorter one is a record missing at the other inspection.
 * A kind of record this table does not know is not given a period: it is "awaiting your decision", named as such,
 * and the owner is asked once (CLAUDE.md, clause 5: never-measured is a state, not a blank). Nothing here destroys
 * anything; the clock only says what may go and what must stay.
 *
 * The periods, as of 1 October 2026:
 * - Prescription and dispensing records: five years in Kansas (K.A.R. 68-7-11; K.S.A. 65-1642). Federal DEA records
 *   are two years (21 CFR 1304.04), so the Kansas five applies to controlled-substance invoices, 222 forms,
 *   inventories and counts too.
 * - Purchase invoices: six years, because the DSCSA transaction information and statement ride on the invoice and
 *   must be kept six years (21 U.S.C. 360eee-1(d)(1)(A)(iv)); Kansas's five is the shorter.
 * - CQI records — the summaries, the incident reports, the reviews: five years (K.A.R. 68-19-1(e)), which is what
 *   the register's own annual retention duty already attests to.
 * - HIPAA policies, training, business-associate agreements, notice-of-privacy acknowledgements, risk analyses:
 *   six years from creation or from when last in effect (45 CFR 164.316(b)(2)(i)).
 * - Training records: HIPAA's six years applies to any training record (45 CFR 164.316(b)(2)(i)); OSHA's three for
 *   bloodborne-pathogen training (29 CFR 1910.1030(h)(2)) is shorter and so never the one that binds. Exposure and
 *   medical records thirty years past employment (29 CFR 1910.1020), kept as "never destroy" here.
 * - Medicare Part D records, including claims, remittances and the contracts behind them: ten years
 *   (42 CFR 423.505(d), (i)(2)). Remittances and claim payments are kept under this, the longest that touches them.
 * - Vaccine storage temperature logs: three years under the CDC's Vaccines for Children provider agreement, which
 *   the Kansas program adopts; a fridge log is kept three years whether or not VFC stock was in it.
 * - Bank statements, cheque images and the books' own ledgers: seven years, the ordinary IRS reach for a return
 *   under examination (26 CFR 1.6001-1; six years where income is understated, plus the filing year).
 * - Delivery invoices, driver records, supplier statements and credit memos: seven years with the books.
 * - PioneerRx's own exports (the claims, sales, on-hand and purchase reports the site reads): the pharmacy's record
 *   of what it dispensed, bought and billed; the longest rule that touches them is Part D's ten years.
 * Not written, because the rule is not sure: self-inspection reports, immunisation administration records (Kansas
 * reports to WebIZ; the pharmacy's own copy's period not confirmed), staff files after employment, and insurance
 * policies. Each of those is a question, asked once.
 */
export type RetentionRule = { kind: string; years: number | "never"; because: string; cite: string };

export const RETENTION: RetentionRule[] = [
  { kind: "controlled_substance", years: 5, because: "Kansas keeps every controlled-substance record five years; the federal two is shorter", cite: "K.A.R. 68-7-11; 21 CFR 1304.04" },
  { kind: "prescription", years: 5, because: "Kansas prescription and dispensing records", cite: "K.A.R. 68-7-11; K.S.A. 65-1642" },
  { kind: "purchase_invoice", years: 6, because: "the DSCSA transaction record rides on the invoice and is kept six years; Kansas's five is the shorter", cite: "21 U.S.C. 360eee-1(d)(1)(A)(iv); K.A.R. 68-7-11" },
  { kind: "cqi", years: 5, because: "CQI summaries, incident reports and reviews, as the register's own retention duty attests", cite: "K.A.R. 68-19-1(e)" },
  { kind: "medicare_part_d", years: 10, because: "Part D claims, remittances and the contracts behind them", cite: "42 CFR 423.505(d), (i)(2)" },
  { kind: "hipaa", years: 6, because: "HIPAA policies, training, agreements and acknowledgements, from creation or last effect", cite: "45 CFR 164.316(b)(2)(i)" },
  { kind: "training", years: 6, because: "any training record: HIPAA's six years is the longer of the two that apply", cite: "45 CFR 164.316(b)(2)(i); 29 CFR 1910.1030(h)(2)" },
  { kind: "osha_exposure", years: "never", because: "exposure and medical records live thirty years past employment; kept as never", cite: "29 CFR 1910.1020" },
  { kind: "temperature_log", years: 3, because: "vaccine storage temperature logs under the VFC provider agreement", cite: "CDC VFC provider agreement, as Kansas adopts it" },
  { kind: "books", years: 7, because: "bank statements, cheques, ledgers, the books' own documents: the IRS's ordinary reach plus the filing year", cite: "26 CFR 1.6001-1" },
  { kind: "supplier_paper", years: 7, because: "supplier statements, credit memos, delivery invoices: with the books", cite: "26 CFR 1.6001-1" },
];

export const UNDECIDED_KINDS = ["self_inspection", "immunisation_record", "staff_file", "insurance"] as const;

/** The kind of record a document category is, or null where the table has no view. Categories are the documents table's own words. */
export function kindOfCategory(category: string | null | undefined): string | null {
  const c = (category ?? "").toLowerCase();
  if (!c) return null;
  if (/cs_|controlled|dea|222|csos|biennial|inventory_count|power_of_attorney|poa/.test(c)) return "controlled_substance";
  if (/prescription|dispens|pioneer_catalog|claims?_(export|file|import)|rx_transactions/.test(c)) return "prescription";
  if (/driver|delivery/.test(c)) return "supplier_paper";
  if (/supplier_invoice|invoice|credit_memo|receiving/.test(c)) return "purchase_invoice";
  if (/remit|835|payer_payment|accesshealth|mtf|medicare|part_d|contract|agreement_pbm|psao|^report$|report_|rx_transactions|on_hand|sales_by|purchase_drilldown|accrual_sales/.test(c)) return "medicare_part_d";
  if (/hipaa|privacy|business_associate|baa|policy_ack|notice_of_privacy|risk_analysis|manual|policy/.test(c)) return "hipaa";
  if (/exposure|incident_medical/.test(c)) return "osha_exposure";
  if (/osha|bloodborne|training/.test(c)) return "training";
  if (/temp|temperature|fridge|freezer|sensor/.test(c)) return "temperature_log";
  if (/bank|cheque|check_image|statement_bank|tax|ledger|report_month|payroll|loan|^agreement$|supplier_agreement/.test(c)) return "books";
  if (/supplier_statement|delivery|driver|ap_history|statement/.test(c)) return "supplier_paper";
  if (/cqi/.test(c)) return "cqi";
  if (/self_inspection|inspection/.test(c)) return "self_inspection";
  if (/immuni|vaccine/.test(c)) return "immunisation_record";
  if (/credential|licen|certificate|cpr|registration|staff|employee|new_hire/.test(c)) return "staff_file";
  if (/insurance/.test(c)) return "insurance";
  return null;
}

export type RetentionVerdict =
  | { state: "keep"; until: string; rule: RetentionRule }
  | { state: "may_destroy"; since: string; rule: RetentionRule }
  | { state: "never"; rule: RetentionRule }
  | { state: "awaiting_decision"; kind: string | null; question: string };

const addYears = (iso: string, years: number) => {
  const d = new Date(Date.parse(`${iso}T00:00:00Z`));
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
};

/**
 * Pure: what the clock says about one document. The clock starts at the record's own date (effective_on) where it has
 * one, else the day it was filed; for a record "in effect" (a policy, an agreement) the caller passes the day it
 * stopped being in effect as `from`, because the six years run from then.
 */
export function retentionOf(category: string | null | undefined, from: string | null | undefined, today: string): RetentionVerdict {
  const kind = kindOfCategory(category);
  const rule = kind ? RETENTION.find((r) => r.kind === kind) : undefined;
  if (!rule) {
    return {
      state: "awaiting_decision",
      kind,
      question: kind
        ? `How long does the pharmacy keep its ${kind.replace(/_/g, " ")} records? The rule this site holds is not sure of Kansas's period, so nothing is said until you say.`
        : `What kind of record is "${category ?? "uncategorised"}", and how long is it kept? Nothing is said about it until you say.`,
    };
  }
  if (rule.years === "never") return { state: "never", rule };
  if (!from) return { state: "awaiting_decision", kind, question: `This ${kind?.replace(/_/g, " ")} record carries no date of its own, so its ${rule.years}-year clock cannot start. Give it one.` };
  const until = addYears(from, rule.years);
  return until > today ? { state: "keep", until, rule } : { state: "may_destroy", since: until, rule };
}
