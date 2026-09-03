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
    inboxItemId: text("inbox_item_id"),
    effectiveOn: text("effective_on"),
    expiresOn: text("expires_on"),
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
    dueOn: text("due_on"), // next occurrence
    lastCompletedOn: text("last_completed_on"),
    lastCompletedBy: text("last_completed_by"),
    lastNotes: text("last_notes"),
    documentId: text("document_id"), // evidence for the most recent completion
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Set when the pharmacy has not confirmed the rule applies to them (e.g. compounding, shipping). */
    needsConfirmation: integer("needs_confirmation", { mode: "boolean" }).notNull().default(false),
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
    completedOn: text("completed_on").notNull(),
    completedBy: text("completed_by").notNull(),
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
