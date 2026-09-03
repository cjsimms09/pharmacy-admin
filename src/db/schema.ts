import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ── Auth ─────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["owner", "pic", "staff"] }).notNull().default("staff"),
  personId: text("person_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(now()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(now()),
});

// ── Pharmacy settings (key/value) ────────────────────────────────────
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ── Workforce ────────────────────────────────────────────────────────
export const PERSON_ROLES = ["pharmacist", "technician", "intern", "other"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  role: text("role", { enum: PERSON_ROLES }).notNull(),
  title: text("title"), // e.g. "Pharmacist-in-Charge", "Certified Technician"
  isPic: integer("is_pic", { mode: "boolean" }).notNull().default(false),
  /** Where training links and reminders are sent. Staff are not on the pharmacy network. */
  email: text("email"),
  mobile: text("mobile"),
  administersVaccines: integer("administers_vaccines", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  hiredOn: text("hired_on"),
  endedOn: text("ended_on"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
});

export const CREDENTIAL_TYPES = [
  "pharmacist_license",
  "technician_registration",
  "intern_registration",
  "cpr",
  "immunization_training",
  // The written protocol each immunizer works under. Reviewed and re-signed annually, and
  // separate from the one-off training certificate: the certificate does not expire, the
  // protocol does.
  "immunization_protocol",
  "controlled_substance_poa",
  "pharmacy_registration",
  "dea_registration",
  "csos_certificate",
  "kmap_enrollment",
  "npi",
  "ncpdp",
  "liability_insurance",
  "property_insurance",
  "workers_comp_insurance",
  "cyber_insurance",
  "business_license",
  "sales_tax_permit",
  "psao_agreement",
  "wholesaler_account",
  "other",
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").references(() => people.id, { onDelete: "cascade" }), // null = pharmacy-level
    type: text("type", { enum: CREDENTIAL_TYPES }).notNull(),
    label: text("label"), // free text for "other"
    number: text("number"),
    issuer: text("issuer"),
    issuedOn: text("issued_on"),
    expiresOn: text("expires_on"),
    /**
     * Deliberately has no expiry — a certificate that does not lapse, a diploma, a one-off
     * training. Kept apart from a blank date, because a blank date means nobody entered one and
     * that is the thing worth chasing. Saying so is a decision; leaving it empty is an omission,
     * and a screen that cannot tell them apart nags forever about the first kind.
     */
    noExpiry: integer("no_expiry", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("credentials_person_idx").on(t.personId), index("credentials_expires_idx").on(t.expiresOn)],
);

export const ceEntries = sqliteTable(
  "ce_entries",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    completedOn: text("completed_on").notNull(),
    hours: integer("hours_tenths").notNull(), // stored as tenths of an hour to avoid float issues
    title: text("title").notNull(),
    provider: text("provider"),
    acpeNumber: text("acpe_number"),
    isBoardCourse: integer("is_board_course", { mode: "boolean" }).notNull().default(false),
    isLive: integer("is_live", { mode: "boolean" }).notNull().default(false),
    documentId: text("document_id"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("ce_person_idx").on(t.personId)],
);

// ── Documents ────────────────────────────────────────────────────────
export const DOCUMENT_CATEGORIES = [
  "license",
  "cpr_card",
  "immunization_training",
  "immunization_protocol",
  "pharmacy_registration",
  "dea_registration",
  "controlled_substance_poa",
  "cs_inventory",
  "cs_discrepancy",
  "insurance",
  "agreement",
  "cqi_summary",
  "cqi_incident",
  "ce_certificate",
  "policy",
  "report",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    category: text("category", { enum: DOCUMENT_CATEGORIES }).notNull(),
    title: text("title").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    personId: text("person_id").references(() => people.id, { onDelete: "set null" }),
    credentialId: text("credential_id").references(() => credentials.id, { onDelete: "set null" }),
    cqiSummaryId: text("cqi_summary_id"),
    cqiIncidentId: text("cqi_incident_id"),
    csInventoryId: text("cs_inventory_id"),
    csDiscrepancyId: text("cs_discrepancy_id"),
    inboxItemId: text("inbox_item_id"),
    effectiveOn: text("effective_on"),
    expiresOn: text("expires_on"),
    /** Stated as not expiring, rather than simply left blank. */
    noExpiry: integer("no_expiry", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedAt: text("uploaded_at").notNull().default(now()),
  },
  (t) => [index("documents_person_idx").on(t.personId), index("documents_category_idx").on(t.category)],
);

// ── Workforce training (annual, per person) ──────────────────────────
// Separate from credentials because these recur on a fixed cycle and are tracked as a matrix of
// people against years — "who has done this year's FWA training" is the question that gets asked.
export const TRAINING_TYPES = [
  "fwa_general_compliance",
  "hipaa_privacy_security",
  "osha_bloodborne",
  "osha_hazard_communication",
  "controlled_substance_diversion",
  "immunization_protocol_review",
  "cqi_program_review",
  "other",
] as const;
export type TrainingType = (typeof TRAINING_TYPES)[number];

export const trainings = sqliteTable(
  "trainings",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    type: text("type", { enum: TRAINING_TYPES }).notNull(),
    label: text("label"), // free text for "other"
    completedOn: text("completed_on").notNull(),
    /** The compliance year this satisfies — usually the calendar year of completion. */
    cycleYear: integer("cycle_year").notNull(),
    expiresOn: text("expires_on"), // next due; defaults to a year after completion
    provider: text("provider"),
    minutes: integer("minutes"),
    documentId: text("document_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("trainings_person_idx").on(t.personId), index("trainings_cycle_idx").on(t.cycleYear)],
);

// ── Recurring pharmacy obligations (the compliance calendar) ─────────
// One row per standing duty. Seeded with the Kansas and federal calendar on first run; the PIC can
// add, edit or switch off any of them, because no two pharmacies carry exactly the same set.
export const OBLIGATION_CADENCES = ["monthly", "quarterly", "annual", "biennial", "triennial", "as_needed"] as const;
export type ObligationCadence = (typeof OBLIGATION_CADENCES)[number];

/**
 * How a duty is closed out. This is the difference between a compliance list and a compliance
 * tool: each kind needs a different action from the PIC, and three of them need nothing at all.
 *
 *   attest     Done outside the site — a portal checked, a walk-through completed. The PIC
 *              confirms it and the site records a specific, dated statement of what was
 *              confirmed. One click, but the evidence is a sentence an inspector can read, not
 *              a tick in a box.
 *   evidence   Not done until a document exists. A temperature log, a signed attestation, a
 *              renewed certificate. Arrives by email or is uploaded.
 *   witnessed  The site saw it happen. A CQI summary finalised here, an inventory recorded here,
 *              a training filed here. Closes itself — asking the PIC to confirm something the
 *              software watched them do is the software making them prove things to it.
 *   renewal    Driven by a credential's expiry date rather than by a period.
 */
export const OBLIGATION_KINDS = ["attest", "evidence", "witnessed", "renewal"] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export const obligations = sqliteTable(
  "obligations",
  {
    id: text("id").primaryKey(),
    /** Stable key for the seeded ones, so a later release can update wording without duplicating. */
    seedKey: text("seed_key"),
    title: text("title").notNull(),
    detail: text("detail"),
    citation: text("citation"), // the rule this comes from
    cadence: text("cadence", { enum: OBLIGATION_CADENCES }).notNull(),
    kind: text("kind", { enum: OBLIGATION_KINDS }).notNull().default("attest"),
    /** How many separate pieces of evidence a period needs. Two temperature logs a month, say. */
    expectedPerPeriod: integer("expected_per_period").notNull().default(1),
    /**
     * The sentence recorded when the PIC attests. {period} and {date} are filled in, so the
     * record says what was actually confirmed rather than that a box was ticked.
     */
    attestationTemplate: text("attestation_template"),
    /** For witnessed duties: what in the site satisfies it. */
    witnessSource: text("witness_source"),
    dueOn: text("due_on"), // next occurrence
    lastCompletedOn: text("last_completed_on"),
    lastCompletedBy: text("last_completed_by"),
    lastNotes: text("last_notes"),
    documentId: text("document_id"), // evidence for the most recent completion
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Set when the pharmacy has not confirmed the rule applies to them (e.g. compounding, shipping). */
    needsConfirmation: integer("needs_confirmation", { mode: "boolean" }).notNull().default(false),
    /**
     * When someone answered that question, and who.
     *
     * Kept because both answers are worth showing an inspector. "Yes, and here is every period
     * since" is the obvious one; "no, and here is the date we decided that" is the one that turns
     * an absent record from a hole into a decision. It is also where period counting starts for a
     * duty confirmed late, so confirming something in March does not manufacture two missed months.
     */
    confirmedOn: text("confirmed_on"),
    confirmedBy: text("confirmed_by"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("obligations_due_idx").on(t.dueOn)],
);

/** Every time an obligation is signed off, so there is a history rather than just a last date. */
export const obligationCompletions = sqliteTable(
  "obligation_completions",
  {
    id: text("id").primaryKey(),
    obligationId: text("obligation_id").notNull().references(() => obligations.id, { onDelete: "cascade" }),
    /** Which period this satisfies: "2026-08", "2026-Q3", "2026". */
    periodKey: text("period_key"),
    completedOn: text("completed_on").notNull(),
    completedBy: text("completed_by").notNull(),
    /** The attestation as recorded. This is the evidence, not the row's existence. */
    statement: text("statement"),
    notes: text("notes"),
    documentId: text("document_id"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("obligation_completions_idx").on(t.obligationId)],
);

// ── Document intake (drop anything, Claude files it) ─────────────────
export const intakeItems = sqliteTable("intake_items", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  status: text("status", { enum: ["extracted", "applied", "failed", "discarded"] }).notNull().default("extracted"),
  resultJson: text("result_json").notNull().default("{}"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now()),
  appliedAt: text("applied_at"),
});

// ── CQI (K.A.R. 68-19-1) ─────────────────────────────────────────────
// Incident types exactly as listed on Kansas Board forms C-550 / C-650 (rev. 2025).
export const INCIDENT_TYPES = [
  "wrong_drug",
  "incorrect_strength",
  "incorrect_dosage_form",
  "wrong_patient",
  "packaging_labeling_directions",
  "serious_harm",
  "other",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const cqiIncidents = sqliteTable(
  "cqi_incidents",
  {
    id: text("id").primaryKey(),
    incidentNumber: integer("incident_number").notNull().unique(),
    occurredOn: text("occurred_on").notNull(),
    reportCreatedOn: text("report_created_on").notNull(), // starts the 7-day / 30-day clocks
    type: text("type", { enum: INCIDENT_TYPES }).notNull(),
    typeOther: text("type_other"),
    description: text("description").notNull(), // no patient identifiers
    rxNumbersEnc: text("rx_numbers_enc"), // AES-GCM encrypted JSON array of Rx numbers
    reachedPatient: integer("reached_patient", { mode: "boolean" }),
    reviewStartedOn: text("review_started_on"),
    reviewCompletedOn: text("review_completed_on"),
    employeeCommunication: text("employee_communication"),
    rootCauseAnalysis: text("root_cause_analysis"),
    correctiveActionPlan: text("corrective_action_plan"),
    capImplementedOn: text("cap_implemented_on"),
    reviewerPersonId: text("reviewer_person_id"), // PIC or designee who started the review
    employeeReviews: text("employee_reviews").notNull().default("[]"), // JSON [{personId, reviewedOn, reviewedByPersonId}]
    capClosed: integer("cap_closed", { mode: "boolean" }).notNull().default(false), // both C-550 reviews done
    rcaBeforeAi: text("rca_before_ai"), // previous text kept when Claude rewrites, so it can be restored
    capBeforeAi: text("cap_before_ai"),
    // Background write-up: an incident logged at the counter has its RCA and CAP drafted automatically.
    aiState: text("ai_state", { enum: ["idle", "queued", "done", "failed"] }).notNull().default("idle"),
    aiError: text("ai_error"),
    supersedesIncidentId: text("supersedes_incident_id"), // set when a CAP judged ineffective is revised
    externalReportRef: text("external_report_ref"), // where the C-650 / full incident report is filed
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("cqi_incidents_created_idx").on(t.reportCreatedOn)],
);

export const cqiSummaries = sqliteTable(
  "cqi_summaries",
  {
    id: text("id").primaryKey(),
    periodStart: text("period_start").notNull(), // first day of first month covered
    periodEnd: text("period_end").notNull(), // last day of second month covered
    dueOn: text("due_on").notNull(), // 15th of the following month
    isNullReport: integer("is_null_report", { mode: "boolean" }).notNull().default(false),
    isHistorical: integer("is_historical", { mode: "boolean" }).notNull().default(false), // uploaded prior summary
    status: text("status", { enum: ["draft", "final"] }).notNull().default("draft"),
    incidentIds: text("incident_ids").notNull().default("[]"), // JSON array
    priorCapEvaluation: text("prior_cap_evaluation"), // evaluation of CAPs from previous four months
    additionalNotes: text("additional_notes"),
    preparedByPersonId: text("prepared_by_person_id"),
    preparedOn: text("prepared_on"),
    communicatedOn: text("communicated_on"),
    communicationMethod: text("communication_method"), // meeting, email, webinar, etc.
    communicatedTo: text("communicated_to").notNull().default("[]"), // JSON array of people.id
    finalizedAt: text("finalized_at"),
    finalizedBy: text("finalized_by"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("cqi_summaries_period_idx").on(t.periodStart)],
);

// CAP effectiveness reviews recorded on the C-550 ("First review" / "Second review").
export const cqiCapReviews = sqliteTable(
  "cqi_cap_reviews",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull().references(() => cqiIncidents.id, { onDelete: "cascade" }),
    summaryId: text("summary_id").notNull().references(() => cqiSummaries.id, { onDelete: "cascade" }),
    reviewNumber: integer("review_number").notNull(), // 1 or 2
    effective: integer("effective", { mode: "boolean" }),
    comments: text("comments"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("cap_reviews_incident_idx").on(t.incidentId), index("cap_reviews_summary_idx").on(t.summaryId)],
);

// ── Controlled substance inventories (K.A.R. 68-20-16, 21 CFR 1304.11, Form C-250) ──
export const csInventories = sqliteTable(
  "cs_inventories",
  {
    id: text("id").primaryKey(),
    inventoryDate: text("inventory_date").notNull(),
    takenAt: text("taken_at", { enum: ["opening", "close", "24h"] }).notNull().default("close"),
    timeStarted: text("time_started"),
    timeEnded: text("time_ended"),
    isKsAnnual: integer("is_ks_annual", { mode: "boolean" }).notNull().default(true),
    isDeaBiennial: integer("is_dea_biennial", { mode: "boolean" }).notNull().default(false),
    isPicOutgoing: integer("is_pic_outgoing", { mode: "boolean" }).notNull().default(false),
    isPicIncoming: integer("is_pic_incoming", { mode: "boolean" }).notNull().default(false),
    coversCii: integer("covers_cii", { mode: "boolean" }).notNull().default(true),
    coversCiiiV: integer("covers_ciii_v", { mode: "boolean" }).notNull().default(true),
    coversDrugsOfConcern: integer("covers_drugs_of_concern", { mode: "boolean" }).notNull().default(true),
    participantIds: text("participant_ids").notNull().default("[]"), // JSON array of people.id
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("cs_inventories_date_idx").on(t.inventoryDate)],
);

// ── AI imports of scanned CQI packets ────────────────────────────────
export const cqiImports = sqliteTable("cqi_imports", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  status: text("status", { enum: ["extracted", "applied", "failed"] }).notNull().default("extracted"),
  resultJson: text("result_json").notNull().default("{}"),
  error: text("error"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now()),
  appliedAt: text("applied_at"),
});

// ── Mailbox sweep (reports emailed to the pharmacy's admin address) ──
export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull(), // IMAP message id, so a message is never processed twice
    receivedAt: text("received_at").notNull(),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull().default(""),
    fileName: text("file_name"),
    documentId: text("document_id"), // set when the attachment was stored
    status: text("status", { enum: ["stored", "rejected", "ignored"] }).notNull(),
    reason: text("reason"), // why rejected or ignored
    /** What the sweep recognised the attachment as, and what happened when it was loaded. */
    routedAs: text("routed_as"),
    routeResult: text("route_result"),
    scanned: integer("scanned", { mode: "boolean" }).notNull().default(false),
    sweptAt: text("swept_at").notNull().default(now()),
  },
  (t) => [index("inbox_message_idx").on(t.messageId), index("inbox_swept_idx").on(t.sweptAt)],
);

// ── Payer reference data (the claim → contract routing layer) ────────
// Loaded from CSVs dropped in data/reference/. Plain lookup tables, no AI: this is what lets
// a claim carrying a BIN be resolved to the PBM and the agreement that governs it.

export const payerBins = sqliteTable(
  "payer_bins",
  {
    id: text("id").primaryKey(),
    bin: text("bin").notNull(),
    pbmName: text("pbm_name").notNull(),
    subNetwork: text("sub_network"),
    linesOfBusiness: text("lines_of_business"),
    aliases: text("aliases"),
    helpDesk: text("help_desk"),
    macContact: text("mac_contact"),
    notes: text("notes"),
    /** True when this BIN appears under more than one PBM — never resolve on BIN alone. */
    collides: integer("collides", { mode: "boolean" }).notNull().default(false),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("payer_bins_bin_idx").on(t.bin), index("payer_bins_pbm_idx").on(t.pbmName)],
);

/** Every document known to exist, whether or not its file has arrived. Drives the checklist. */
export const contractDocs = sqliteTable(
  "contract_docs",
  {
    id: text("id").primaryKey(),
    pbmName: text("pbm_name").notNull(),
    documentName: text("document_name").notNull(),
    documentType: text("document_type"),
    effectiveYear: integer("effective_year"),
    /** Set when the PDF has been found in data/contracts/. */
    fileName: text("file_name"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    matchedBy: text("matched_by", { enum: ["manifest", "filename", "manual", "unmatched"] }),
    /** Whether this one is in the priority set worth extracting. */
    priority: integer("priority", { mode: "boolean" }).notNull().default(false),
    extractionState: text("extraction_state", { enum: ["none", "queued", "done", "failed"] }).notNull().default("none"),
    extractionJson: text("extraction_json"),
    extractionError: text("extraction_error"),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("contract_docs_pbm_idx").on(t.pbmName), index("contract_docs_priority_idx").on(t.priority)],
);

// ── NADAC (National Average Drug Acquisition Cost) ───────────────────
// Published weekly by CMS, free and public. Under the Kansas Consumer Prescription Protection
// and Accountability Act (SB 20, effective 1 July 2026) it is the reimbursement floor for
// commercial plans not preempted by ERISA, so this is the benchmark an underpayment is proved
// against. One row per NDC per effective date: a claim must be priced against the figure in
// force on its fill date, never the current one.
export const nadacPrices = sqliteTable(
  "nadac_prices",
  {
    id: text("id").primaryKey(),
    ndc11: text("ndc11").notNull(),
    description: text("description"),
    /** Dollars x 1,000,000. CMS publishes five decimals and every one of them matters. */
    unitMicros: integer("unit_micros").notNull(),
    /** EA, ML or GM. A quantity in the wrong unit produces a confidently wrong number. */
    pricingUnit: text("pricing_unit").notNull(),
    effectiveOn: text("effective_on").notNull(),
    /** B or G, CMS's brand/generic classification for rate setting. */
    classification: text("classification"),
    otc: integer("otc", { mode: "boolean" }).notNull().default(false),
    explanationCode: text("explanation_code"),
    /** The "As of Date" of the CMS file this row came from — cited in a complaint. */
    fileAsOf: text("file_as_of").notNull(),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [
    index("nadac_ndc_eff_idx").on(t.ndc11, t.effectiveOn),
    index("nadac_file_idx").on(t.fileAsOf),
  ],
);

// ── Audit ────────────────────────────────────────────────────────────
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    at: text("at").notNull().default(now()),
    userId: text("user_id"),
    userName: text("user_name"),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    details: text("details"),
  },
  (t) => [index("audit_at_idx").on(t.at)],
);

// ── PBM reference (Health Mart Atlas contracting resources) ──────────
// Collected from the HMA PBM Contract Resources portal. This is the layer that turns a BIN on a
// claim into everything we know about the payer behind it: what the network pays, who to appeal
// to, and where the money comes from. Every row carries its source URL, because a rate asserted
// without a citation is not usable in an appeal.
//
// Names differ between the HMA BIN listing and the network/appeal tables, so each row stores a
// canonical name resolved at import time alongside the label the source actually used. Lookups
// join on the canonical name; the source label is kept so a figure can be traced back.

/** One row per network per line of business: what the contract says it pays. */
export const networkRates = sqliteTable(
  "network_rates",
  {
    id: text("id").primaryKey(),
    pbmName: text("pbm_name").notNull(),
    sourceLabel: text("source_label").notNull(),
    lineOfBusiness: text("line_of_business").notNull(),
    network: text("network").notNull(),
    effectiveDate: text("effective_date"),
    status: text("status"),
    daysSupply: text("days_supply"),
    /** Rate expressions as published, e.g. "AWP-18.75% + $0.75". Never parsed into a number here. */
    brandRate: text("brand_rate"),
    genericRate: text("generic_rate"),
    berGuardrail: text("ber_guardrail"),
    gerGuardrail: text("ger_guardrail"),
    notes: text("notes"),
    sourceUrl: text("source_url"),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("network_rates_pbm_idx").on(t.pbmName), index("network_rates_lob_idx").on(t.lineOfBusiness)],
);

/** How a MAC appeal reaches this PBM, and on whose clock. */
export const macAppealTerms = sqliteTable(
  "mac_appeal_terms",
  {
    id: text("id").primaryKey(),
    pbmName: text("pbm_name").notNull(),
    sourceLabel: text("source_label").notNull(),
    submissionChannel: text("submission_channel"),
    submissionTarget: text("submission_target"),
    appealWindowDays: integer("appeal_window_days"),
    windowBasis: text("window_basis"),
    requiredFields: text("required_fields"),
    invoiceRequired: text("invoice_required"),
    responseSlaDays: integer("response_sla_days"),
    adjustmentRetroactive: text("adjustment_retroactive"),
    escalationContact: text("escalation_contact"),
    notes: text("notes"),
    sourceUrl: text("source_url"),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("mac_appeal_terms_pbm_idx").on(t.pbmName)],
);

/** Whether the money comes through HMA central pay or direct, and where the remittance lives. */
export const paymentRouting = sqliteTable(
  "payment_routing",
  {
    id: text("id").primaryKey(),
    pbmName: text("pbm_name").notNull(),
    sourceLabel: text("source_label").notNull(),
    paysVia: text("pays_via"),
    paymentMethod: text("payment_method"),
    remittanceSource: text("remittance_source"),
    paymentCycle: text("payment_cycle"),
    onContractListing: text("on_contract_listing"),
    notes: text("notes"),
    sourceUrl: text("source_url"),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("payment_routing_pbm_idx").on(t.pbmName)],
);

/** Help desks, MAC mailboxes, credentialing, portals. */
export const pbmContacts = sqliteTable(
  "pbm_contacts",
  {
    id: text("id").primaryKey(),
    pbmName: text("pbm_name").notNull(),
    sourceLabel: text("source_label").notNull(),
    contactType: text("contact_type").notNull(),
    phone: text("phone"),
    email: text("email"),
    portalUrl: text("portal_url"),
    notes: text("notes"),
    sourceUrl: text("source_url"),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("pbm_contacts_pbm_idx").on(t.pbmName)],
);

/** The HMA PBM communications feed — rate changes and network notices, newest first. */
export const pbmCommunications = sqliteTable(
  "pbm_communications",
  {
    id: text("id").primaryKey(),
    pbmName: text("pbm_name"),
    sourceLabel: text("source_label"),
    publishedDate: text("published_date").notNull(),
    subject: text("subject").notNull(),
    type: text("type"),
    url: text("url"),
    sourceUrl: text("source_url"),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("pbm_communications_date_idx").on(t.publishedDate), index("pbm_communications_pbm_idx").on(t.pbmName)],
);

// ── Inventory discrepancy log ────────────────────────────────────────
// A count that did not come out right, written down while it is fresh.
//
// This is not a DEA 106 and not a CQI incident. Kansas does not require this log, and nothing
// here files itself anywhere — it is kept because a pattern across months is worth seeing, and
// because a discrepancy that was reasoned through at the time reads very differently to an
// inspector than one reconstructed a year later.
//
// The quantity is stored in thousandths so a 0.5 mL or half-tablet count is exact. Expected and
// counted are both kept rather than only the difference, so the arithmetic can be re-checked.
export const csDiscrepancies = sqliteTable(
  "cs_discrepancies",
  {
    id: text("id").primaryKey(),
    discoveredOn: text("discovered_on").notNull(),
    drugName: text("drug_name").notNull(),
    ndc11: text("ndc11"),
    strength: text("strength"),
    schedule: text("schedule", { enum: ["CII", "CIII", "CIV", "CV", "non_controlled", "unknown"] }).notNull().default("unknown"),
    /** Counts x 1,000. Expected and counted are kept separately; the difference is derived. */
    expectedThousandths: integer("expected_thousandths"),
    countedThousandths: integer("counted_thousandths"),
    unit: text("unit").notNull().default("EA"),
    /** What happened, in the PIC's own words. The reason this log exists. */
    narrative: text("narrative").notNull(),
    /** What was concluded, if anything. Blank while it is still open. */
    resolution: text("resolution"),
    resolvedOn: text("resolved_on"),
    /** Linked when a discrepancy turned out to warrant one; usually null. */
    csInventoryId: text("cs_inventory_id"),
    reportedToDea: integer("reported_to_dea", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("cs_discrepancies_date_idx").on(t.discoveredOn), index("cs_discrepancies_drug_idx").on(t.drugName)],
);

// ── Claims ───────────────────────────────────────────────────────────
// Dispensing and adjudication detail exported from PioneerRx, matched to the payer that priced
// it. This is the table everything on the money side reads from: expected reimbursement, MAC
// appeals, and any filing under the Kansas floor.
//
// Money is in cents and quantity in thousandths, both as integers, so nothing drifts. A value
// the export did not carry is null — never zero. The difference matters: zero is a claim that
// paid nothing, null is a claim we cannot yet judge, and collapsing them would put unpriceable
// claims into a schedule as if they were underpayments.

export const claimImports = sqliteTable("claim_imports", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  rowsRead: integer("rows_read").notNull().default(0),
  claimsAdded: integer("claims_added").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  /** Why rows were skipped, counted by reason. JSON object. */
  skipReasons: text("skip_reasons").notNull().default("{}"),
  /** Columns in the file we did not recognise, so a renamed export is visible immediately. */
  unmappedColumns: text("unmapped_columns").notNull().default("[]"),
  periodFrom: text("period_from"),
  periodTo: text("period_to"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now()),
});

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    importId: text("import_id").notNull().references(() => claimImports.id, { onDelete: "cascade" }),

    rxNumber: text("rx_number").notNull(),
    fillNumber: integer("fill_number"),
    dateFilled: text("date_filled").notNull(),

    ndc11: text("ndc11"),
    itemName: text("item_name"),

    // ── Which contract priced it ──
    bin: text("bin"),
    pcn: text("pcn"),
    groupNumber: text("group_number"),
    networkId: text("network_id"),
    planId: text("plan_id"),
    planType: text("plan_type"),
    pharmacyServiceType: text("pharmacy_service_type"),
    basisOfReimbursement: text("basis_of_reimbursement"),
    basisOfCostDetermination: text("basis_of_cost_determination"),
    /** The payer name as the export wrote it. */
    payerLabel: text("payer_label"),
    /** Resolved against the BIN listing. Null when the BIN is unknown. */
    pbmName: text("pbm_name"),
    /** How the payer was settled: bin, bin_and_name, name, or unresolved. */
    matchMethod: text("match_method"),
    /** True when the BIN alone pointed at more than one PBM and the name did not settle it. */
    payerAmbiguous: integer("payer_ambiguous", { mode: "boolean" }).notNull().default(false),

    // ── Amounts ──
    quantityThousandths: integer("quantity_thousandths"),
    quantityUnit: text("quantity_unit"),
    daysSupply: integer("days_supply"),
    remitCents: integer("remit_cents"),
    copayCents: integer("copay_cents"),
    awpCents: integer("awp_cents"),
    acquisitionCents: integer("acquisition_cents"),
    grossProfitCents: integer("gross_profit_cents"),
    ingredientPaidCents: integer("ingredient_paid_cents"),
    dispensingFeePaidCents: integer("dispensing_fee_paid_cents"),
    daw: text("daw"),

    /** Everything the export carried, kept verbatim so a later question needs no re-import. */
    rawJson: text("raw_json"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("claims_import_idx").on(t.importId),
    index("claims_pbm_idx").on(t.pbmName),
    index("claims_bin_idx").on(t.bin),
    index("claims_date_idx").on(t.dateFilled),
    index("claims_rx_idx").on(t.rxNumber),
  ],
);

// ── Plan register ────────────────────────────────────────────────────
// One row per benefit plan we bill, and the single question that decides whether the Kansas
// floor reaches it: is this plan preempted by ERISA.
//
// Nothing else in the system answers that. The claim carries a plan type from PioneerRx, but
// that field is descriptive rather than legal — Medicare contract numbers turn up on claims
// labelled "Standard", and a discount card looks like commercial insurance from the outside.
// So the determination is made once per plan by a person, recorded with its evidence, and every
// claim on that plan inherits it.
//
// Default is "unknown", and unknown never files. A plan nobody has looked at is a reason to
// investigate, not a reason to assume.

export const PLAN_CLASSES = [
  "commercial_fully_insured", // state-regulated insurer — the Kansas floor applies
  "commercial_self_funded",   // ERISA plan — preempted, out of reach
  "governmental",             // city, county, school district, state — not an ERISA plan, floor applies
  "church_plan",              // exempt from ERISA by election — floor applies
  "medicare",                 // Part D or MA-PD — federally preempted
  "medicaid",                 // governed separately
  "workers_comp",             // priced by a different scheme entirely
  "discount_card",            // not insurance at all; no plan to regulate
  "unknown",                  // not yet determined. Never files.
] as const;
export type PlanClass = (typeof PLAN_CLASSES)[number];

export const planGroups = sqliteTable(
  "plan_groups",
  {
    id: text("id").primaryKey(),
    /** The natural key of a plan on a claim: who processes it and under which group. */
    bin: text("bin"),
    groupNumber: text("group_number"),
    /** The payer name as the claims wrote it, for recognising the row. */
    payerLabel: text("payer_label"),
    pbmName: text("pbm_name"),
    /** The employer or plan sponsor, once identified. What a Form 5500 search is run against. */
    sponsorName: text("sponsor_name"),
    classification: text("classification", { enum: PLAN_CLASSES }).notNull().default("unknown"),
    /** How it was established — a Form 5500 filing, the plan document, a call. Required to file. */
    basis: text("basis"),
    sourceUrl: text("source_url"),
    decidedBy: text("decided_by"),
    decidedOn: text("decided_on"),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("plan_groups_key_idx").on(t.bin, t.groupNumber), index("plan_groups_class_idx").on(t.classification)],
);

// ── Supplier catalogues ──────────────────────────────────────────────
// What each wholesaler currently charges for an NDC. The other half of the margin question: a
// MAC is set per molecule, so reimbursement barely moves between manufacturers and acquisition
// cost is the lever.
//
// Prices are per dispensing unit in micros (1e-6 of a dollar), because a tablet at $0.00241
// rounds to nothing in cents and a 90-count would then price at zero.

export const supplierImports = sqliteTable("supplier_imports", {
  id: text("id").primaryKey(),
  supplier: text("supplier").notNull(),
  fileName: text("file_name").notNull(),
  rowsRead: integer("rows_read").notNull().default(0),
  itemsAdded: integer("items_added").notNull().default(0),
  itemsUpdated: integer("items_updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  skipReasons: text("skip_reasons").notNull().default("{}"),
  unmappedColumns: text("unmapped_columns").notNull().default("[]"),
  pricedOn: text("priced_on"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now()),
});

export const supplierItems = sqliteTable(
  "supplier_items",
  {
    id: text("id").primaryKey(),
    supplier: text("supplier").notNull(),
    ndc11: text("ndc11").notNull(),
    description: text("description"),
    /** Derived from the description so items can be compared across suppliers and against claims. */
    productKey: text("product_key"),
    manufacturer: text("manufacturer"),
    packSize: text("pack_size"),
    /** Cost per dispensing unit, in millionths of a dollar. */
    unitCostMicros: integer("unit_cost_micros"),
    /** Cost of the whole package, in cents. */
    packCostCents: integer("pack_cost_cents"),
    /** Whether this line sits on a purchasing contract — buying off it can cost rebate tiers. */
    contractFlag: text("contract_flag"),
    availability: text("availability"),
    pricedOn: text("priced_on"),
    importId: text("import_id").notNull(),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    index("supplier_items_ndc_idx").on(t.ndc11),
    index("supplier_items_key_idx").on(t.productKey),
    index("supplier_items_supplier_idx").on(t.supplier),
  ],
);


// ── Training assignments ─────────────────────────────────────────────
// The loop that turns "I should get everyone through FWA training" into evidence.
//
// Staff are not on the pharmacy network and should not need a login, so an assignment carries a
// long random token and reaches them as a link. They open it, work through the material, type
// their name and attest. The site records the exact words they agreed to, when, and from where.
//
// Under the ESIGN Act and the Kansas UETA that is a valid electronic signature: there is intent
// to sign, the signature is attached to the record it relates to, and the record is retained and
// reproducible. It is stronger evidence than a paper roster, because a roster records that
// someone wrote their name and nothing about what they were agreeing to.

export const trainingAssignments = sqliteTable(
  "training_assignments",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    type: text("type", { enum: TRAINING_TYPES }).notNull(),
    /** Secret in the link. Long enough that guessing one is not a route in. */
    token: text("token").notNull().unique(),
    assignedOn: text("assigned_on").notNull(),
    dueOn: text("due_on").notNull(),
    /** Where the material lives, if it is not being read on the page itself. */
    materialUrl: text("material_url"),
    /** The wording the person is asked to agree to. Stored per assignment so a later change
     *  to the template can never rewrite what somebody already signed. */
    statement: text("statement").notNull(),

    completedAt: text("completed_at"),
    /** Typed by the person. Compared against their name on file, but not required to match —
     *  a maiden name or a nickname is not a reason to reject a signature. */
    signedName: text("signed_name"),
    signedIp: text("signed_ip"),
    signedAgent: text("signed_agent"),
    /** Set when the completion produced a trainings row, so it is never double-counted. */
    trainingId: text("training_id"),

    remindersSent: integer("reminders_sent").notNull().default(0),
    lastReminderAt: text("last_reminder_at"),
    sentAt: text("sent_at"),
    sendError: text("send_error"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("training_assignments_person_idx").on(t.personId),
    index("training_assignments_due_idx").on(t.dueOn),
  ],
);

// ── Temperature monitoring ───────────────────────────────────────────
// Readings pulled from iMonnit, kept here so the pharmacy owns its own record.
//
// The reason to store rather than link out: a VFC visit or an excursion investigation asks for a
// continuous record over a period, and a vendor portal is a place you can be locked out of, that
// prunes history, and that nobody can print a clean month from. Once the readings are here they
// can be printed, annotated and kept for as long as the rule asks.
//
// Temperatures are stored in tenths of a degree Fahrenheit as integers. A vaccine fridge range is
// 36 to 46 F and a tenth is the resolution that matters; floating point has no place in a record
// somebody may have to defend.

export const tempSensors = sqliteTable(
  "temp_sensors",
  {
    id: text("id").primaryKey(),
    /** The sensor's ID in iMonnit. */
    externalId: text("external_id").notNull().unique(),
    /** What iMonnit calls it. */
    externalName: text("external_name"),
    /** What the pharmacy calls it — this is what appears on a printed log. */
    name: text("name").notNull(),
    kind: text("kind", { enum: ["refrigerator", "freezer", "room", "other"] }).notNull().default("refrigerator"),
    /** Only tracked sensors are polled and logged. Most of an account is not the pharmacy's. */
    tracked: integer("tracked", { mode: "boolean" }).notNull().default(false),
    /** The acceptable range, in tenths of a degree F. Outside it is an excursion. */
    minTenthsF: integer("min_tenths_f").notNull().default(360),
    maxTenthsF: integer("max_tenths_f").notNull().default(460),
    lastReadingAt: text("last_reading_at"),
    lastSyncAt: text("last_sync_at"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("temp_sensors_tracked_idx").on(t.tracked)],
);

export const tempReadings = sqliteTable(
  "temp_readings",
  {
    id: text("id").primaryKey(),
    sensorId: text("sensor_id").notNull().references(() => tempSensors.id, { onDelete: "cascade" }),
    /** UTC instant the sensor reported. Unique per sensor, so re-polling never duplicates. */
    takenAt: text("taken_at").notNull(),
    /** Local calendar month, so a month's log is one indexed lookup rather than a scan. */
    periodKey: text("period_key").notNull(),
    valueTenthsF: integer("value_tenths_f").notNull(),
    /** True when it sat outside the sensor's range at the moment it was taken. */
    excursion: integer("excursion", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("temp_readings_sensor_period_idx").on(t.sensorId, t.periodKey),
    index("temp_readings_taken_idx").on(t.sensorId, t.takenAt),
  ],
);

/** What the PIC wrote about an excursion, or about a month as a whole. */
export const tempNotes = sqliteTable(
  "temp_notes",
  {
    id: text("id").primaryKey(),
    sensorId: text("sensor_id").notNull().references(() => tempSensors.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    /** Set when the note is about one specific reading rather than the month. */
    readingId: text("reading_id"),
    note: text("note").notNull(),
    /** Signed off when the month has been reviewed — what turns a data dump into a record. */
    reviewed: integer("reviewed", { mode: "boolean" }).notNull().default(false),
    writtenBy: text("written_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("temp_notes_sensor_period_idx").on(t.sensorId, t.periodKey)],
);
