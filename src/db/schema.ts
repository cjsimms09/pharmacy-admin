import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  /**
   * Employed, or here for a fixed spell.
   *
   * A KU P4 on a five-week rotation is not staff and is not a former employee either. Treating
   * them as staff means the dashboard chases them for annual training they will never owe and
   * keeps doing so after they have gone; marking them inactive when they leave loses the fact
   * that they were here in June, which is exactly what an inspector asks about a June incident.
   * So they are their own kind of person, with the dates they were actually present.
   */
  engagement: text("engagement", { enum: ["staff", "rotation"] }).notNull().default("staff"),
  /** For a rotation: the window they are on site. Outside it they are retained but not chased. */
  startsOn: text("starts_on"),
  endsOn: text("ends_on"),
  /** Who they are here from — the school, the employer of record. */
  affiliation: text("affiliation"),
  hiredOn: text("hired_on"),
  endedOn: text("ended_on"),
  /**
   * Why they left, and who recorded it.
   *
   * Somebody leaving is not a reason to lose their file. Their training records, their licence
   * history and their signed attestations all still have to be producible for years afterwards —
   * an inspector asking about a dispensing error from two years ago does not care that the
   * technician involved has moved on. So nobody is ever deleted; they are ended, on a date, with
   * a reason, and everything attached to them stays exactly where it is.
   */
  endedReason: text("ended_reason"),
  endedBy: text("ended_by"),
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
  /**
   * What a student on rotation has to produce before their first shift.
   *
   * Taken from what the affiliation agreement actually obliges each side to do, rather than from
   * a guess: the school provides these and tells the student to hand them over on request, which
   * means the pharmacy is the party holding nothing unless it asks. A student who works a five
   * week rotation and leaves no record behind is the gap nobody notices until an inspector asks
   * who was on the bench in July.
   */
  "immunization_record",
  "tb_screening",
  "background_check",
  /**
   * The hepatitis B vaccination offer, and its refusal.
   *
   * 29 CFR 1910.1030(f)(2) requires the series to be offered free of charge within ten working
   * days of taking on duties with occupational exposure, and 1910.1030(f)(2)(iv) requires a signed
   * declination in the specific wording of Appendix A to the standard from anyone who refuses.
   * The declination is the record that matters — an employee who was never offered and an
   * employee who declined look identical without it, and only one of those is compliant.
   */
  "hepatitis_b",
  /**
   * PTCB or NHA national certification — the CPhT.
   *
   * Distinct from the Kansas technician registration, which every technician must hold to work at
   * all. Certification is the national credential on top of it, it expires on its own cycle, and
   * it applies to technicians and to nobody else — an intern or a pharmacist does not hold one.
   */
  "technician_certification",
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

/**
 * A request to a member of staff for a credential the pharmacy does not hold.
 *
 * The gap is visible on every screen; closing it meant emailing somebody by hand, waiting, then
 * remembering to file whatever came back against the right person and the right requirement. Each
 * of those steps is where it stopped happening.
 *
 * So the request is a record. It carries a code, the reply is matched on that code *and* the
 * sender's own address, and the attachment that comes back is filed against the person and the
 * requirement it was asked for — which is the whole loop, closed without anybody remembering
 * anything.
 */
export const credentialRequests = sqliteTable(
  "credential_requests",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    type: text("type", { enum: CREDENTIAL_TYPES }).notNull(),
    /** Short, spoken-aloud-able, and what the reply is matched on. */
    replyCode: text("reply_code").notNull(),
    requestedOn: text("requested_on").notNull(),
    requestedBy: text("requested_by"),
    sentAt: text("sent_at"),
    sendError: text("send_error"),
    remindersSent: integer("reminders_sent").notNull().default(0),
    /** Set when a reply arrived and something was filed from it. */
    fulfilledAt: text("fulfilled_at"),
    /** The document that came back, and the credential row it produced. */
    documentId: text("document_id"),
    credentialId: text("credential_id"),
    /** Cancelled without being fulfilled — they left, or it was asked for in error. */
    cancelledAt: text("cancelled_at"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("credential_requests_person_idx").on(t.personId), index("credential_requests_code_idx").on(t.replyCode)],
);

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
  /** A MAC appeal or a Kansas floor complaint as sent, and the ERA enrollment request as sent. */
  "appeal",
  "era_enrollment",
  "cpr_card",
  "immunization_training",
  "immunization_protocol",
  "pharmacy_registration",
  "dea_registration",
  "controlled_substance_poa",
  "cs_inventory",
  "cs_discrepancy",
  /**
   * Supplier invoices, split by schedule, and split on purpose.
   *
   * 21 CFR 1304.04(h)(1) requires Schedule II records to be kept separately from all other
   * records of the registrant; (h)(2) allows Schedule III-V records to be separate or merely
   * readily retrievable. Three categories rather than one is what makes "show me every Schedule
   * II invoice for last year" a filter rather than a search, and a C2 invoice sitting in the same
   * pile as the floor stock is the finding this exists to prevent.
   */
  "invoice_schedule_2",
  "invoice_schedule_3_5",
  "invoice",
  /** The delivery driver's monthly invoice, as it was sent. */
  "driver_invoice",
  /** A vendor's bill — rent, utilities, supplies, software — as it arrived, behind its expense row. */
  "bill",
  /** A payer's remittance advice (an 835 or its paper), behind the payments it posted. */
  "remittance",
  /** The bank's statement, kept until it can be read in. */
  "bank_statement",
  "insurance",
  "agreement",
  /**
   * A Kansas Board of Pharmacy inspection report, past or present.
   *
   * Worth its own category rather than living under "other": the first thing the next inspector
   * asks is what the last one found, and an answer that involves opening a filing cabinet is a
   * worse answer than one that does not.
   */
  "board_inspection",
  /**
   * A wholesaler or supplier agreement, including a rebate schedule.
   *
   * Kept apart from a business associate agreement, which is a HIPAA instrument about access to
   * protected health information. A purchasing contract is a commercial one, and filing them
   * together makes the BAA register — which is reviewed annually and must be complete — wrong.
   */
  "supplier_agreement",
  /**
   * A statement of account, rebate breakdown or credit memo from a supplier.
   *
   * Not an invoice, and the distinction is not cosmetic. An invoice is a receipt record under
   * 21 CFR 1304.22(c) and its Schedule II copy has to be held apart from everything else; a
   * statement is a summary of an account and is a record of nothing that was received. Filed
   * together, the controlled-substance filing fills up with documents that record no receipt, and
   * the one question the category exists to answer — show me every invoice for these goods —
   * stops having a clean answer.
   */
  "supplier_statement",
  "cqi_summary",
  "cqi_incident",
  "ce_certificate",
  /** A completed training: a certificate, or the emailed attestation that stands for one. */
  "training_record",
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
  /**
   * Reading and acknowledging the pharmacy's own policy and procedure manual.
   *
   * The manual itself says every employee signs an acknowledgement page and that it is retained
   * in their file. That is the pharmacy's own policy, and until now nothing enforced it — which
   * is the most awkward kind of gap, because it is not a rule somebody else imposed and forgot
   * to follow up on. It is theirs, written down, and unmet.
   */
  "policy_manual_acknowledgement",
  /**
   * The pharmacy's own technician training course, required by K.A.R. 68-5-15.
   *
   * Unlike everything else in this list it is not an annual refresher. It is the course the
   * pharmacist-in-charge must maintain — "designed for the functioning of that pharmacy" — which a
   * technician must complete within 180 days of employment, and before which they may not perform
   * tasks the pharmacy act authorises a technician to perform. Technicians only: it says nothing
   * about pharmacists or interns and chasing them for it would be noise.
   */
  "technician_initial_training",
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
    /**
     * Which manual a policy acknowledgement was signed against.
     *
     * Only ever set for the policy manual acknowledgement, and the reason it exists is that the
     * manual is edited here. A signature collected in March refers to text that may not exist by
     * June, so "I have read the manual" with nothing else recorded becomes quietly false and
     * cannot answer the question an inspector asks — which version did your staff acknowledge.
     *
     * "legacy" for the ones signed before this was recorded: a real acknowledgement, of a manual
     * nothing identifies.
     */
    manualRevision: text("manual_revision"),
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
    /**
     * The electronic signature behind it, where there is one.
     *
     * Null for a completion filed as evidence rather than attested, and for the ones recorded
     * before attestations were signed — which is worth being able to tell apart rather than
     * showing every row as though it carried a signature.
     */
    signatureId: text("signature_id"),
    notes: text("notes"),
    documentId: text("document_id"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("obligation_completions_idx").on(t.obligationId)],
);

/**
 * Business associate agreements.
 *
 * HIPAA requires one with every vendor that touches protected health information, and the thing
 * that goes wrong is never that nobody signed one — it is that nobody can find it, or it expired
 * three years ago and the relationship carried on. So they are tracked like any other expiring
 * obligation rather than living in a folder, and the annual BAA review closes itself off this
 * table instead of asking the PIC to assert something from memory.
 */
export const businessAssociates = sqliteTable(
  "business_associates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** What they do that gives them access — "software", "shredding", "billing", "rotations". */
    service: text("service"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    signedOn: text("signed_on"),
    /** Many BAAs are evergreen. Said so explicitly rather than left blank. */
    expiresOn: text("expires_on"),
    noExpiry: integer("no_expiry", { mode: "boolean" }).notNull().default(false),
    /** The agreement itself. */
    documentId: text("document_id"),
    /** Set when the relationship has ended; the agreement is kept for its retention period. */
    endedOn: text("ended_on"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("business_associates_expires_idx").on(t.expiresOn)],
);

/**
 * Self-inspection: walking the pharmacy against the criteria an inspector uses.
 *
 * The compliance calendar already carries a self-inspection duty, and until now closing it meant
 * attesting "I walked the pharmacy against the Board's criteria". That is a real record and a
 * weak one: it proves somebody said they looked, and nothing about what they looked at or what
 * they found. A pharmacy that produces a dated, itemised walkthrough — with the two things it
 * found and the dates those were put right — is telling an inspector something no attestation
 * can, which is that the place inspects itself and fixes what it finds.
 *
 * Findings are the point, not the ticks. An inspection with nothing found is either a very good
 * pharmacy or a walkthrough nobody took seriously, and the screen says so.
 */
export const selfInspections = sqliteTable("self_inspections", {
  id: text("id").primaryKey(),
  startedOn: text("started_on").notNull(),
  /** Set when it is finalised. An unfinished walkthrough is not evidence of anything. */
  completedOn: text("completed_on"),
  completedBy: text("completed_by"),
  /** Which period of the compliance calendar this satisfies. */
  periodKey: text("period_key"),
  notes: text("notes"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now()),
});

export const SELF_INSPECTION_RESULTS = ["ok", "finding", "na"] as const;
export type SelfInspectionResult = (typeof SELF_INSPECTION_RESULTS)[number];

export const selfInspectionItems = sqliteTable(
  "self_inspection_items",
  {
    id: text("id").primaryKey(),
    inspectionId: text("inspection_id").notNull().references(() => selfInspections.id, { onDelete: "cascade" }),
    /** Stable key from the checklist definition, so wording can be improved without losing history. */
    itemKey: text("item_key").notNull(),
    result: text("result", { enum: SELF_INSPECTION_RESULTS }).notNull(),
    note: text("note"),
    /** What is being done about a finding, and when it was done. */
    correctiveAction: text("corrective_action"),
    correctedOn: text("corrected_on"),
    correctedBy: text("corrected_by"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("self_inspection_items_idx").on(t.inspectionId)],
);

/**
 * The policy and procedure manual, kept here rather than in a Word file.
 *
 * Two documents describing one pharmacy will always drift, and the drift is invisible until an
 * inspector reads both. The only arrangement that holds is one document — so the manual lives
 * here, in sections, and is exported when a paper copy is wanted rather than being the paper copy.
 *
 * Sections come in two kinds and the distinction is the whole design. A pharmacy section is prose
 * the pharmacy owns and edits: hours, conduct, benefits, the premises. A site section is
 * generated from what this system actually does and cannot be edited by hand — because the moment
 * it can be, it will say something the software does not do, and a manual is a standard an
 * inspector holds you to.
 */
export const MANUAL_SECTION_SOURCES = ["pharmacy", "site"] as const;
export type ManualSectionSource = (typeof MANUAL_SECTION_SOURCES)[number];

export const manualSections = sqliteTable(
  "manual_sections",
  {
    id: text("id").primaryKey(),
    /** Stable key for a site-generated section, so regeneration replaces rather than duplicates. */
    sourceKey: text("source_key"),
    source: text("source", { enum: MANUAL_SECTION_SOURCES }).notNull().default("pharmacy"),
    title: text("title").notNull(),
    /** 1 for a chapter, 2 for a section within it. Deeper than that and nobody reads it. */
    level: integer("level").notNull().default(1),
    /** Sparse ordering, so a section can be moved without renumbering everything. */
    position: integer("position").notNull(),
    body: text("body").notNull().default(""),
    /** Reviewed at least annually; the date is what an inspector asks for. */
    reviewedOn: text("reviewed_on"),
    reviewedBy: text("reviewed_by"),
    /** Set when a section is retired, so its history survives being removed from the manual. */
    retiredOn: text("retired_on"),
    /**
     * Who maintains this section, when it is not the pharmacy.
     *
     * The employment half of this handbook belongs to the medical practice next door; the
     * pharmacy is bound by it but does not write it. Marking that is not cosmetic — it stops the
     * site chasing an annual review the pharmacist-in-charge cannot perform, stops counting
     * somebody else's empty heading as this pharmacy's gap, and puts the right name on the page
     * when an inspector asks who owns a policy.
     *
     * Null means the pharmacy maintains it.
     */
    managedBy: text("managed_by"),
    updatedBy: text("updated_by"),
    /**
     * When this section was last read against the requirements, rather than merely signed off.
     *
     * Separate from reviewedOn on purpose. An annual review is a date a person puts their name to;
     * this is the date something actually checked the words against Kansas and federal
     * requirements and against what the system does. A manual can be reviewed on time for years
     * and still be wrong, which is the failure mode this column exists to make visible.
     */
    auditedOn: text("audited_on"),
    /**
     * When reading this section last failed, and why.
     *
     * Without this a section that cannot be read is retried first for ever. The queue is ordered
     * oldest-first, a never-audited section sorts first, and two sections that fail every time
     * therefore consume every batch — the audit reports "0 sections read" indefinitely while the
     * other hundred and eighteen are never reached. Recording the attempt moves them to the back
     * without pretending they were read, and gives the pharmacist something to act on.
     */
    auditFailedOn: text("audit_failed_on"),
    auditError: text("audit_error"),
    /**
     * How many times reading this section has failed.
     *
     * Because a section that fails stays due, and a duty that is always due is retried for ever.
     * Once everything else has been read, the only sections left are the ones that cannot be, and
     * the half-hourly beat would retry them every half hour indefinitely — each attempt costing a
     * model call, on the pharmacy's own account, with nobody at the computer. Three strikes and it
     * is parked: still due, still reported, but not retried on its own again until somebody asks.
     */
    auditFailCount: integer("audit_fail_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("manual_sections_pos_idx").on(t.position)],
);

/**
 * What the audit found, kept until somebody does something about it.
 *
 * Findings are rows rather than a report, because a report is read once and a row is worked
 * through. Each carries the text the audit would put in its place, so the fix is a button rather
 * than a writing job — and each has to be either applied or explicitly dismissed with a reason,
 * so "we looked at it and decided it was fine" is itself a record.
 */
export const MANUAL_FINDING_SEVERITIES = ["blocking", "should", "note"] as const;
export type ManualFindingSeverity = (typeof MANUAL_FINDING_SEVERITIES)[number];

export const manualFindings = sqliteTable(
  "manual_findings",
  {
    id: text("id").primaryKey(),
    sectionId: text("section_id").notNull(),
    /** Kept alongside the id so a finding still reads if the section is later retired. */
    sectionTitle: text("section_title").notNull(),
    severity: text("severity", { enum: MANUAL_FINDING_SEVERITIES }).notNull().default("should"),
    /** What is wrong with the section as it stands. */
    what: text("what").notNull(),
    /** The requirement, or the thing this site does, that it is wrong against. */
    why: text("why").notNull(),
    /** The replacement text, where the audit could write one. Empty where it could not. */
    suggestedBody: text("suggested_body").notNull().default(""),
    /**
     * What the pharmacy says about this, where the finding was waiting on a fact.
     *
     * Most findings that carry no suggested text are not asking for judgement — they are asking a
     * question. "The manual sets a standard for release that delivery cannot meet; the pharmacy
     * must decide who the driver may release to." Nothing could answer that but the pharmacist,
     * and there was nowhere for him to answer it, so twenty-three findings came back unchanged on
     * every pass until the list stopped being read. This is the answer, kept against the finding
     * that asked, and it is what the rewrite is then written from.
     */
    answer: text("answer"),
    /** When the answer was given, so a stale rewrite can be told from a current one. */
    answeredAt: text("answered_at"),
    appliedAt: text("applied_at"),
    dismissedAt: text("dismissed_at"),
    /** Why it was dismissed. A finding waved away with no reason is not closed, it is hidden. */
    dismissedReason: text("dismissed_reason"),
    closedBy: text("closed_by"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("manual_findings_section_idx").on(t.sectionId)],
);

/**
 * Supplier invoices, and which schedule each one carries.
 *
 * The separation requirement is not about paper. 21 CFR 1304.04(h)(1) says Schedule II records
 * are maintained separately from all other records of the registrant, and (h)(2) lets Schedule
 * III-V be separate or readily retrievable from ordinary business records. An electronic system
 * satisfies both as long as the C2s are distinguishable and can be pulled on their own, quickly,
 * with nobody sorting through anything.
 *
 * So each invoice gets a row saying what schedule it carries, the document is filed under a
 * category that matches, and the file itself is written to its own folder. What an inspector asks
 * for — every Schedule II invoice, this date to that date — is then one query and one export.
 *
 * "unknown" is a real and important state. An invoice nobody could read is not filed as
 * non-controlled: it waits in a review queue, because a C2 invoice quietly landing in the general
 * pile is exactly the failure this table exists to prevent.
 */
export const INVOICE_SCHEDULES = ["schedule_2", "schedule_3_5", "none", "unknown"] as const;
export type InvoiceSchedule = (typeof INVOICE_SCHEDULES)[number];

/**
 * The wholesalers this pharmacy buys from.
 *
 * This began as a line of free text in the email settings — "a fragment, an equals sign, a
 * name" — which was enough to route a file and nothing else. A supplier is not a routing rule.
 * It is a party the pharmacy has a DEA-registered relationship with, whose invoices are records
 * the pharmacy is required to keep, and whose silence is itself reportable. All of that needs
 * somewhere to live.
 *
 * The addresses they send from are the load-bearing part: an invoice only files itself if the
 * sender is recognised, so a wholesaler who changes their billing address quietly stops being
 * recorded. Keeping them here rather than in a settings blob means the site can say which
 * supplier has gone quiet, and by name.
 */
export const suppliers = sqliteTable(
  "suppliers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Every address they send invoices from, one per line. Matched against the sender. */
    senderEmails: text("sender_emails").notNull().default(""),
    /** The pharmacy's account number with them, as it appears on the invoice. */
    accountNumber: text("account_number"),
    /** Their DEA registration, printed on any invoice carrying controlled substances. */
    deaNumber: text("dea_number"),
    phone: text("phone"),
    website: text("website"),
    /**
     * The name the PioneerRx catalogue export uses for them: "McKesson", "IPD", "IPC", "ParMed".
     *
     * The catalogue names its supplier inside the file and the invoice names its supplier on the
     * page, and neither is obliged to spell it the way the register does. This is the join: a
     * catalogue section whose name matches it is filed against this row, so prices, invoices,
     * rebate terms and return terms all hang off one supplier rather than three spellings of one.
     * Blank means "match on the register name alone".
     */
    catalogName: text("catalog_name"),
    /**
     * What they are expected to ship, as the pharmacy states it.
     *
     * Never used to classify anything — used the other way round, to notice when a supplier sends
     * something they never send. Used as a classifier it would suppress the one event most worth
     * catching.
     */
    expectedSchedule: text("expected_schedule", { enum: INVOICE_SCHEDULES }),
    /**
     * The last rebate settlement read from this supplier's own report, as JSON.
     *
     * Against the supplier rather than in a setting, because it belongs to them: the achieved
     * compliance rate, the purchases it was earned on and the arithmetic that checked it are facts
     * about one trading relationship. Held in a global setting it was McKesson's by assumption —
     * the page that showed it tested the supplier's name with a regular expression — and a second
     * supplier sending a rebate report would have overwritten the first one's figures.
     */
    rebateStatementJson: text("rebate_statement_json"),
    /**
     * That this supplier pays no rebates at all, said by the pharmacy rather than assumed.
     *
     * Without it there is no way to tell a supplier whose terms nobody has typed in from one that
     * genuinely has none, and the two want opposite things: the first is a gap to fill, the second
     * is an answer. IPC and IPD pay nothing here, and every screen kept reporting their absent
     * schedule as something outstanding.
     *
     * It changes no arithmetic — a supplier with no ladder is already compared at gross. It changes
     * what the site says about them, which is the difference between a list that can be finished
     * and one that cannot.
     */
    noRebates: integer("no_rebates", { mode: "boolean" }).notNull().default(false),
    noRebatesBy: text("no_rebates_by"),
    noRebatesAt: text("no_rebates_at"),
    /**
     * The order value they will not ship under, in cents.
     *
     * A secondary wholesaler is often cheaper on a handful of items and will not take the order
     * unless it reaches a number — five hundred dollars at this pharmacy's secondaries. Without it
     * on file the site recommends a basket the supplier refuses, which is worse than no
     * recommendation: the buying is done, the saving is not, and the pharmacist finds out at their
     * website. Null means they have no minimum, which is a different thing from not knowing.
     */
    minimumOrderCents: integer("minimum_order_cents"),
    /** Above this they ship free; below it `freightCents` is added to the comparison. */
    freeFreightCents: integer("free_freight_cents"),
    freightCents: integer("freight_cents"),
    /** Days from order to shelf. Part of how much cover an order has to buy, not a footnote. */
    leadTimeDays: integer("lead_time_days"),
    /**
     * Days after the invoice date the wholesaler is paid, from the supply agreement.
     *
     * The cash account's cost of goods is what left the bank, and the site is rarely told the day
     * each invoice was paid. The terms are the next best fact the documents supply: McKesson drafts
     * on its stated terms, so an invoice dated the 3rd on seven-day terms is the 10th's money. Null
     * means not known, and an invoice with no paid date is then counted on its own date and said
     * to be. Never the same thing as "paid": a recorded payment date wins over this every time.
     */
    paymentTermsDays: integer("payment_terms_days"),
    /**
     * The wholesaler whose compliance ratio moving spend away from costs a rebate band.
     *
     * Exactly one supplier is the primary. It is not inferred from spend: the pharmacy's contract
     * says which relationship carries the ladder, and a month where a secondary happened to be
     * larger would otherwise silently move the ratio arithmetic to the wrong supplier.
     */
    primarySupplier: integer("primary_supplier", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at"),
  },
  (t) => [index("suppliers_name_idx").on(t.name)],
);


/**
 * What was actually bought, line by line, off the invoices the pharmacy is already keeping.
 *
 * The invoices were being filed and searched as text, which answers "when did we last buy
 * oxycodone" and nothing else. This is the same document read as figures: the NDC, what was paid
 * for it, how many, and — on a McKesson invoice, from the K it prints — whether that line earned
 * the generics contract rebate. It is the only record of what this pharmacy *actually* paid, as
 * against what a catalogue lists, and every question about margin, returns and where to buy runs
 * through it.
 *
 * Lines are only stored where the invoice reconciles: the extended amounts must add to the total
 * printed on its face. A partial read is the dangerous outcome, because the figures that were read
 * look perfectly good on their own and the product whose line was dropped simply appears cheaper
 * than it was.
 */
export const invoiceLines = sqliteTable(
  "invoice_lines",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").notNull().references(() => supplierInvoices.id, { onDelete: "cascade" }),
    supplier: text("supplier"),
    /** The date on the invoice, copied here so a price can be placed in time without a join. */
    invoiceDate: text("invoice_date"),
    ndc11: text("ndc11").notNull(),
    description: text("description"),
    itemNumber: text("item_number"),
    quantity: integer("quantity").notNull(),
    unitOfMeasure: text("unit_of_measure"),
    /** What was paid for one unit of the pack, in cents, as printed. Before any rebate. */
    unitCostCents: integer("unit_cost_cents").notNull(),
    extendedCents: integer("extended_cents").notNull(),
    awpCents: integer("awp_cents"),
    /** The supplier's own class letter: R legend, X Schedule II, B/D/E Schedule III-V. */
    itemClass: text("item_class"),
    /**
     * Whether the line was marked as earning the supplier's contract rebate.
     *
     * True where the invoice printed the mark, false where the invoice prints marks and this line
     * had none, and null where the invoice prints no such mark at all — which is not the same as
     * "not rebated", and treating it as such would strip a discount off a price in every
     * comparison that followed.
     */
    rebated: integer("rebated", { mode: "boolean" }),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("invoice_lines_invoice_idx").on(t.invoiceId),
    index("invoice_lines_ndc_idx").on(t.ndc11),
    index("invoice_lines_supplier_idx").on(t.supplier),
  ],
);

export const supplierInvoices = sqliteTable(
  "supplier_invoices",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    supplier: text("supplier"),
    invoiceNumber: text("invoice_number"),
    /** The date on the invoice, not the date it arrived. */
    invoiceDate: text("invoice_date"),
    schedule: text("schedule", { enum: INVOICE_SCHEDULES }).notNull().default("unknown"),
    /** How the schedule was decided, so a filing can be defended or corrected. */
    basis: text("basis"),
    /** The controlled lines found, as read, so nobody has to reopen the PDF to check. */
    controlledItems: text("controlled_items").notNull().default(""),
    /**
     * Every item line, as printed, so the invoices can be searched by what is on them.
     *
     * Searching by invoice number answers a question nobody has. The questions people actually
     * have are "when did we last buy oxycodone", "which invoice had that NDC on it", and "what
     * did we get from them in March" — and none of those can be answered by a filing system that
     * only knows the number on the front of the document.
     */
    itemsText: text("items_text").notNull().default(""),
    /**
     * What the invoice came to, in cents, as printed on it.
     *
     * Kept because it is the first thing anybody looks for on a list of invoices and the only
     * figure that lets the pharmacy reconcile what it was billed against what it paid. Null where
     * the total could not be read rather than zero, because a zero here would be a lie that adds
     * up.
     */
    totalCents: integer("total_cents"),
    /**
     * How many item lines were read as numbers into supplier_invoice_lines, and how many carried
     * an NDC the reader could not place. Null on an invoice the line reader has not been run on,
     * which is different from zero lines read. See invoice-lines.ts.
     */
    linesRead: integer("lines_read"),
    linesUnread: integer("lines_unread"),
    /** The supplier record this came from, where one is known. */
    supplierId: text("supplier_id"),
    /** Set until a person has confirmed anything the reader was unsure about. */
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(true),
    reviewedBy: text("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    receivedFrom: text("received_from"),
    /**
     * That the goods actually arrived, and matched.
     *
     * The question this answers is whether the pharmacy can stop keeping paper. An emailed invoice
     * is the original record and there is no paper to keep — but the paper packing slip in the
     * tote often carries something the PDF does not: somebody's initials, the date it was checked
     * in, and a note where the count was short. Once anybody writes on that paper it stops being a
     * duplicate of the emailed invoice and becomes the record of receipt, which 21 CFR 1304.22(c)
     * asks for and which cannot then be thrown away.
     *
     * Recording it here is what makes the paper genuinely redundant: the electronic record carries
     * the same three facts, against the same invoice, signed by the same person.
     */
    receivedOn: text("received_on"),
    /**
     * The day the wholesaler was actually paid, which is a different question from the invoice date.
     *
     * A cash account records goods when the money leaves, and an accrual account records them when
     * they are dispensed. Without this the site had only the invoice date and was showing the same
     * cost of goods on both bases — which cannot be right on either, and is the flattering answer
     * on whichever one is wrong that month.
     */
    paidOn: text("paid_on"),
    receivedBy: text("received_by"),
    /** Anything that did not match — short counts, damage, a substitution. */
    receiptNote: text("receipt_note"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("supplier_invoices_schedule_idx").on(t.schedule),
    index("supplier_invoices_date_idx").on(t.invoiceDate),
    index("supplier_invoices_supplier_idx").on(t.supplier),
  ],
);

/*
 * The cloud branch's `supplierInvoiceLines` is deliberately absent.
 *
 * Both sessions built an invoice line reader in the same week. `invoiceLines` above is the one
 * kept: it reconciles each invoice against the total printed on its face before storing anything,
 * and it carries the K McKesson prints against a line bought on the generics contract — the single
 * fact that decides whether a price gets the tier rate taken off it. Two tables holding the same
 * lines would drift apart, and a comparison would read whichever it happened to be pointed at.
 */


/**
 * A supplier's rebate programme, as the pharmacy has recorded it.
 *
 * The number that decides whether a McKesson generic is cheaper than an Anda generic is not on
 * either catalogue: it is the tier the pharmacy's generic compliance ratio lands in this period,
 * and that lives in a rebate schedule nobody has typed in anywhere. So it is typed in here, per
 * supplier, with dates, and the terms are validated against a fixed shape before they are stored
 * (supplier-terms.ts) so a comparison can rely on them.
 *
 * Versioned by row. A new schedule is a new row with its own effective date; the old row is kept
 * with an end date, because a rebate paid last quarter was earned under last quarter's terms.
 */
export const supplierRebatePrograms = sqliteTable(
  "supplier_rebate_programs",
  {
    id: text("id").primaryKey(),
    supplierId: text("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    /** The programme as the supplier names it: "OneStop generics", "IPC quarterly rebate". */
    name: text("name").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    /** Null while current. Set when a later schedule replaces it. */
    effectiveTo: text("effective_to"),
    /** Which version of the terms shape validated this row, so an old row can be read later. */
    termsVersion: integer("terms_version").notNull().default(1),
    /** The validated terms, as JSON. Shape: RebateTerms in supplier-terms.ts. */
    termsJson: text("terms_json").notNull(),
    /** The agreement or schedule the numbers came from, where one is on file. */
    documentId: text("document_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at"),
  },
  (t) => [index("supplier_rebate_programs_supplier_idx").on(t.supplierId, t.effectiveFrom)],
);

/**
 * A supplier's return policy, versioned the same way.
 *
 * What a bottle on the shelf is worth depends on who sold it: how long before expiry it can go
 * back, whether it can go back after, what fraction is credited, what is never taken. None of
 * that is on an invoice. Shape: ReturnTerms in supplier-terms.ts.
 */
export const supplierReturnPolicies = sqliteTable(
  "supplier_return_policies",
  {
    id: text("id").primaryKey(),
    supplierId: text("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
    termsVersion: integer("terms_version").notNull().default(1),
    termsJson: text("terms_json").notNull(),
    documentId: text("document_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at"),
  },
  (t) => [index("supplier_return_policies_supplier_idx").on(t.supplierId, t.effectiveFrom)],
);

/**
 * Who was sent which invoices, and when.
 *
 * Forwarding a controlled substance record to an accountant or a lawyer is a disclosure, and the
 * pharmacy should be able to say exactly what left the building. It is also the ordinary
 * question — "did you send me August?" — that otherwise turns into a search of somebody's sent
 * mail. One row per send, listing every invoice in it.
 */
export const invoiceForwards = sqliteTable(
  "invoice_forwards",
  {
    id: text("id").primaryKey(),
    toAddress: text("to_address").notNull(),
    /** The invoice ids sent, newline separated, kept even if an invoice is later corrected. */
    invoiceIds: text("invoice_ids").notNull(),
    count: integer("count").notNull().default(0),
    /** Whether any Schedule II record was in the send, which is the part worth being able to see. */
    includedScheduleTwo: integer("included_schedule_two", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    sentBy: text("sent_by").notNull(),
    sentAt: text("sent_at").notNull().default(now()),
    error: text("error"),
  },
  (t) => [index("invoice_forwards_sent_idx").on(t.sentAt)],
);

/**
 * The driver's day, one row per weekday.
 *
 * The pharmacy's delivery driver is paid a flat rate for each run: every prescription delivery,
 * and the mail trip that happens on every weekday. He invoiced by keeping a spreadsheet, which
 * meant the count for a Tuesday three weeks ago existed only in somebody's memory by the time the
 * invoice was written.
 *
 * A row exists for a weekday once somebody has said what happened on it — including a day when
 * nothing happened, which is recorded as zero rather than left blank. That distinction is the
 * whole mechanism: a month is finished when every weekday has an answer, and "no answer yet" and
 * "no deliveries that day" must not look the same or the invoice goes out short.
 */
export const deliveryDays = sqliteTable(
  "delivery_days",
  {
    id: text("id").primaryKey(),
    /** The day itself, ISO. One row per date, enforced. */
    onDate: text("on_date").notNull().unique(),
    deliveries: integer("deliveries").notNull().default(0),
    /** Normally one per weekday, but a closed day has none and an odd day may have two. */
    mailTrips: integer("mail_trips").notNull().default(1),
    /** Why a day was zero — a holiday, snow, the pharmacy shut. Prints on nothing; explains later. */
    note: text("note"),
    enteredBy: text("entered_by").notNull(),
    enteredAt: text("entered_at").notNull().default(now()),
    updatedBy: text("updated_by"),
    updatedAt: text("updated_at"),
  },
  (t) => [index("delivery_days_date_idx").on(t.onDate)],
);

export const DRIVER_INVOICE_STATUS = ["draft", "sent", "failed", "superseded"] as const;
export type DriverInvoiceStatus = (typeof DRIVER_INVOICE_STATUS)[number];

/**
 * One invoice per month, kept for ever.
 *
 * Kept rather than regenerated, and that is deliberate. What was sent is a fact about a payment
 * somebody made, so the totals, the rate, the invoice number and the day-by-day breakdown are all
 * frozen into the row and the PDF is filed as a document. Regenerating it later from the day
 * rows would quietly rewrite history the first time a day was corrected.
 *
 * A month whose days change after the invoice went is not edited. The sent invoice is marked
 * superseded and a new one is raised, because that is what the person paying it needs to see.
 */
export const driverInvoices = sqliteTable(
  "driver_invoices",
  {
    id: text("id").primaryKey(),
    /** YYYY-MM. */
    month: text("month").notNull(),
    /** Random, unique, and fixed once issued. */
    invoiceNumber: text("invoice_number").notNull(),
    driverName: text("driver_name").notNull(),
    /** Frozen at issue: a rate change next year must not alter what was billed last year. */
    rateCents: integer("rate_cents").notNull(),
    deliveries: integer("deliveries").notNull().default(0),
    mailTrips: integer("mail_trips").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    /** The day-by-day breakdown as it stood, so the invoice can be reproduced exactly. */
    linesJson: text("lines_json").notNull().default("[]"),
    status: text("status", { enum: DRIVER_INVOICE_STATUS }).notNull().default("draft"),
    sentTo: text("sent_to"),
    sentAt: text("sent_at"),
    sendError: text("send_error"),
    /** The filed PDF, so what was sent can be produced rather than described. */
    documentId: text("document_id"),
    issuedBy: text("issued_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("driver_invoices_month_idx").on(t.month)],
);

/**
 * A record signed on screen rather than on paper.
 *
 * The pharmacy prints its own records — the workforce training file, the technician list, a
 * month of temperatures — and each ends with a line for the pharmacist-in-charge to sign. Printing
 * a document in order to sign it and scan it back is a photocopier standing in for a database, and
 * the unsigned printout in the drawer is the version an inspector finds.
 *
 * The ESIGN Act (15 U.S.C. 7001) and the Kansas UETA (K.S.A. 16-1601 et seq.) make an electronic
 * signature as good as ink, provided four things are true, and every one of them is a column here.
 *
 * Intent: the person did something deliberate that means "I am signing" — a ticked box and a
 * typed name, not a page they scrolled past.
 *
 * Attribution: the signature is attributable to that person, which is why the signed-in user, the
 * name they typed, the address they came from and the browser they used are all kept.
 *
 * Association: the signature is bound to the record it signs, not to a document that may since
 * have changed — so the exact wording signed is stored, together with a fingerprint of the record
 * as it stood at that moment.
 *
 * Retention: it can be produced later in a form that accurately reflects what was signed. That is
 * this row, and it is never edited.
 */
export const recordSignatures = sqliteTable(
  "record_signatures",
  {
    id: text("id").primaryKey(),
    /** Which kind of record — the workforce training file, a month of temperatures, and so on. */
    kind: text("kind").notNull(),
    /** Which one of that kind: a year, a month, an id. Together with kind it names the record. */
    recordKey: text("record_key").notNull(),
    /**
     * The statement, word for word, as it was on screen when it was signed.
     *
     * Stored rather than looked up. If the wording is improved next year, what this person put
     * their name to must not change with it — that is the difference between a record and an
     * assertion about a record.
     */
    statement: text("statement").notNull(),
    /** A fingerprint of the record's own content, so a later edit is detectable. */
    contentHash: text("content_hash"),
    signedName: text("signed_name").notNull(),
    signedByUserId: text("signed_by_user_id").notNull(),
    signedRole: text("signed_role"),
    signedAt: text("signed_at").notNull().default(now()),
    signedIp: text("signed_ip"),
    signedAgent: text("signed_agent"),
    /** Set only when a signature is withdrawn; the row itself is never deleted or altered. */
    revokedAt: text("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [index("record_signatures_record_idx").on(t.kind, t.recordKey)],
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

/**
 * The words inside each contract PDF, so the contracts can be searched.
 *
 * They were filed, matched to a checklist and never opened. That is a filing cabinet, not a
 * record: the question actually asked of a contract is "which one covers BIN 610011", and the
 * only way to answer it was to open twenty PDFs by hand — which is why eighteen BINs went unnamed
 * while the contracts naming them sat on the same disk.
 *
 * Keyed on the file rather than on a checklist row, so a contract that arrived before anybody
 * added it to the checklist is searchable too. The text is a copy of what is already on disk, so
 * it can be rebuilt at any time and nothing is lost if it is dropped.
 */
export const contractText = sqliteTable(
  "contract_text",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    /** The checklist row this file was matched to, where it was matched to one. */
    contractDocId: text("contract_doc_id"),
    sha256: text("sha256").notNull(),
    /** How many characters came out of the PDF's own text layer. Zero means a scan. */
    chars: integer("chars").notNull().default(0),
    body: text("body").notNull().default(""),
    /**
     * Where the body came from: "pdf" is the file's own text layer; "read" is the AI read written
     * back for a scan that has none, every line of it cited to a page. A search hit on a "read"
     * body is the reader's summary of the page, not the page.
     */
    source: text("source").notNull().default("pdf"),
    indexedAt: text("indexed_at").notNull().default(now()),
  },
  (t) => [index("contract_text_file_idx").on(t.fileName)],
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
    /**
     * How this document was tied to a payer. "read" is the contract naming its own counterparty,
     * which is the most reliable of the four: the other three infer it from a file name or a list.
     */
    matchedBy: text("matched_by", { enum: ["manifest", "filename", "manual", "read", "unmatched"] }),
    /** Whether this one is in the priority set worth extracting. */
    priority: integer("priority", { mode: "boolean" }).notNull().default(false),
    extractionState: text("extraction_state", { enum: ["none", "queued", "done", "failed"] }).notNull().default("none"),
    extractionJson: text("extraction_json"),
    extractionError: text("extraction_error"),
    /**
     * When that error was recorded, because a stored failure reads exactly like a live one.
     *
     * The refused contract reads sat on screen unchanged after the cause had been fixed and the
     * update installed — the message is the record of the last attempt, and nothing on it said so.
     * Shown with its date, it can never again be mistaken for the API refusing again.
     */
    extractionFailedAt: text("extraction_failed_at"),
    /**
     * What the cheap sort made of the document before the expensive read: contract, rate_sheet,
     * notice, manual, not_relevant or unsure (`contract-triage.ts`). The full read skips only
     * not_relevant. A person may overrule it; `triage_by` says who decided ("rule", "model", or
     * the person's name).
     */
    triage: text("triage"),
    triageWhy: text("triage_why"),
    triageBy: text("triage_by"),
    /** The batch the model sort is running in, until it is collected. */
    triageBatch: text("triage_batch"),
    /**
     * How many pages the file has, counted once when it is adopted or first read.
     *
     * The library used to open every PDF in the folder to count its pages on every page view —
     * three hundred and fifty files read from disk to show a list. Counted once and kept.
     */
    pages: integer("pages"),
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
    // Unique, so the loader can insert and let the database refuse a price it already holds:
    // no set of every key in memory, no lookup per row, and a file loaded twice adds nothing.
    uniqueIndex("nadac_ndc_eff_idx").on(t.ndc11, t.effectiveOn),
    index("nadac_file_idx").on(t.fileAsOf),
    /*
     * The index every price lookup actually needs.
     *
     * NADAC is the largest table here — every NDC the federal file carries, at every date it has
     * ever carried one, growing by a file a week. It was indexed only by the file it came from,
     * which is the one thing nothing queries by; asking for a drug's price meant reading all of it.
     * Keyed by NDC and date, "what did this cost on the day it was dispensed" is a seek.
     */
    index("nadac_ndc_idx").on(t.ndc11, t.effectiveOn),
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
    /**
     * The routing this rate line was printed against, comma separated, where the schedule printed
     * one against the line rather than once for the whole document.
     *
     * Without it, a document carrying a Commercial table and a Part D table leaves two rates and no
     * way to choose between them on a live claim — and two-thirds of this pharmacy's claims sit on
     * a BIN that carries more than one book. Empty means the line inherits the contract's routing.
     */
    bins: text("bins"),
    pcns: text("pcns"),
    groupIds: text("group_ids"),
    effectiveDate: text("effective_date"),
    /** The last day the rate applies, where the exhibit says; null while it runs. A claim after it is not priced on this row. */
    effectiveTo: text("effective_to"),
    /** null or "active" while in force; "superseded" once a later document names this one as replaced. */
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

/**
 * ── Running the pharmacy as a business ──────────────────────────────────────────
 *
 * Everything up to here answers "what did a prescription make". None of it answers "did the month".
 * A pharmacy can dispense at a healthy margin every day and still lose money, because the margin
 * pays for wages, rent, software, postage and a card processor before any of it is profit.
 *
 * Kept deliberately apart from supplier invoices. A drug purchase has NDCs, quantities, rebate flags
 * and a returns clock; a bill from Stamps.com has a date and an amount. Forcing one shape onto both
 * would wreck the part that already works.
 */

/**
 * What a cost is, for the purpose of a profit and loss account.
 *
 * The kind matters more than the name: it decides where a figure lands in the account, and getting
 * that wrong moves money between gross profit and net profit without changing either total, which
 * is the kind of error that looks like a rounding difference and is not.
 */
/**
 * Where a category's money goes on the account. `balance_sheet` is money that leaves the bank and
 * is not a cost: loan principal, owner draws, equipment bought outright, income tax. It shows on
 * the cash account below the line, so the cash change is the real one, and never on the accrual
 * account, where it would understate profit.
 */
export const EXPENSE_KINDS = ["operating", "cost_of_goods", "revenue_offset", "balance_sheet"] as const;

export const expenseCategories = sqliteTable(
  "expense_categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: EXPENSE_KINDS }).notNull().default("operating"),
    /** Where it sits on the account. Lower first, so the big lines lead. */
    sortOrder: integer("sort_order").notNull().default(100),
    /** Seeded categories cannot be deleted, only renamed — a category with history behind it. */
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    /** What belongs in it, so two people file the same bill the same way. */
    notes: text("notes"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("expense_categories_kind_idx").on(t.kind)],
);

/**
 * Somebody the pharmacy pays, and what to do with their email next time.
 *
 * The rule lives with the vendor rather than in a rules screen of its own: the thing a person wants
 * to say is "bills from Stamps.com are postage", and that is a fact about Stamps.com.
 */
export const vendors = sqliteTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Addresses their invoices arrive from, comma separated. The rule that files them on arrival. */
    senderEmails: text("sender_emails").notNull().default(""),
    /** Where their bills go unless somebody says otherwise. */
    categoryId: text("category_id").references(() => expenseCategories.id, { onDelete: "set null" }),
    /**
     * Whether a bill is expected every month, so a month it does not arrive is visible.
     *
     * A missing invoice does not announce itself: the month simply looks cheaper than it was, and
     * the profit figure is wrong in the flattering direction.
     */
    cadence: text("cadence", { enum: ["monthly", "quarterly", "annual", "irregular"] }).notNull().default("irregular"),
    /** Roughly what to expect, so a bill ten times its usual size is questioned rather than filed. */
    typicalCents: integer("typical_cents"),
    accountNumber: text("account_number"),
    website: text("website"),
    notes: text("notes"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("vendors_name_idx").on(t.name)],
);

/**
 * One bill.
 *
 * Two dates, because there are two honest answers to "when was this a cost". The invoice date is
 * when the pharmacy incurred it and is what an accrual account uses; the paid date is when the money
 * left the bank. A month's profit differs between the two, and both are true — so both are kept and
 * neither is derived from the other.
 */
export const expenses = sqliteTable(
  "expenses",
  {
    id: text("id").primaryKey(),
    vendorId: text("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    categoryId: text("category_id").references(() => expenseCategories.id, { onDelete: "set null" }),
    /** As the vendor wrote it, so a duplicate bill is recognisable. */
    invoiceNumber: text("invoice_number"),
    /** When it was incurred: the accrual date. */
    invoiceDate: text("invoice_date").notNull(),
    /** When the money actually left: the cash date. Null while it is still owed. */
    paidOn: text("paid_on"),
    amountCents: integer("amount_cents").notNull(),
    taxCents: integer("tax_cents"),
    description: text("description"),
    notes: text("notes"),
    /** The bill itself, so a figure on the account can always be opened. */
    documentId: text("document_id").references(() => documents.id, { onDelete: "set null" }),
    inboxItemId: text("inbox_item_id"),
    source: text("source", { enum: ["email", "manual", "recurring"] }).notNull().default("manual"),
    /**
     * A bill read from an email is a draft until somebody agrees with it.
     *
     * Reading an amount off a PDF is a guess with a number attached, and a guess that walks straight
     * into the month's profit is worse than no figure at all.
     */
    status: text("status", { enum: ["draft", "confirmed", "void"] }).notNull().default("draft"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("expenses_date_idx").on(t.invoiceDate),
    index("expenses_paid_idx").on(t.paidOn),
    index("expenses_category_idx").on(t.categoryId),
  ],
);

/**
 * Money that actually reached the bank in a month, which is not what was earned in it.
 *
 * A third party pays two to four weeks after the claim, so cash always lags accrual — and the gap
 * between them is the pharmacy's receivable, which is real money and worth watching on its own.
 * Entered by hand from the remittance statements, month by month.
 */
export const cashReceipts = sqliteTable(
  "cash_receipts",
  {
    id: text("id").primaryKey(),
    /** YYYY-MM: the month the money arrived, never the month it was earned. */
    month: text("month").notNull(),
    kind: text("kind", { enum: ["third_party", "patient", "retail", "rebate", "facilitator", "other"] }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    payer: text("payer"),
    notes: text("notes"),
    documentId: text("document_id").references(() => documents.id, { onDelete: "set null" }),
    /**
     * The identity of the payment in whatever report it came from, so it is banked once.
     *
     * A payer payment report is a date range, and a date range gets re-run — the same week with a
     * day added, or last month forwarded again. Every payment carries the payer's own number, and
     * that number keyed against the payer is what stops this file inflating revenue every time it
     * lands. Null for a receipt somebody typed in, which has no source to be identified by.
     */
    sourceKey: text("source_key").unique(),
    /** The day it reached the bank. The month above is derived from this where it is known. */
    receivedOn: text("received_on"),
    /** The payer's own payment number, shown so a deposit can be traced without opening the file. */
    reference: text("reference"),
    /** "EFT", "COPY", "CHECK", as the report writes it. */
    method: text("method"),
    /*
     * The report's own reconciliation figures, recorded and not yet used by anything.
     *
     * Whether a remittance advice was matched to the payment, what of it matched claims, and what
     * did not. These are the beginning of the 835 work rather than part of it. They are stored as
     * they arrive so that when that work happens the history is already here, and no figure on
     * this site is drawn from them until it is — a number used before its source is understood is
     * how a set of books goes quietly wrong.
     */
    remitMatched: integer("remit_matched", { mode: "boolean" }),
    claimMatchCents: integer("claim_match_cents"),
    noClaimMatchCents: integer("no_claim_match_cents"),
    adjustmentsCents: integer("adjustments_cents"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("cash_receipts_month_idx").on(t.month), index("cash_receipts_received_idx").on(t.receivedOn)],
);

/**
 * Every line read off a bank statement, remembered so the same statement read twice banks nothing
 * twice, and so a deposit or a payment can be traced back to the line that made it.
 */
export const bankLines = sqliteTable(
  "bank_lines",
  {
    id: text("id").primaryKey(),
    /** date | cents | hash of the description: the line's identity across re-uploads. */
    key: text("key").notNull().unique(),
    on: text("on").notNull(),
    description: text("description").notNull().default(""),
    /** Positive in, negative out. */
    amountCents: integer("amount_cents").notNull(),
    /** deposit, pays_bill, pays_invoice, unplaced. */
    placedAs: text("placed_as").notNull().default("unplaced"),
    why: text("why"),
    receiptId: text("receipt_id"),
    expenseId: text("expense_id"),
    invoiceId: text("invoice_id"),
    documentId: text("document_id"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("bank_lines_on_idx").on(t.on)],
);

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
  /*
   * The report's own bottom line for this file — the only figures here nobody computed.
   *
   * PioneerRx prints a grand total: what the pharmacy took, what the drugs cost, what it made.
   * Kept because it is the one check on our arithmetic that did not come from our arithmetic, and
   * because it is the only place total sales for a period exist as a single authoritative number.
   */
  reportSalesCents: integer("report_sales_cents"),
  reportAcquisitionCents: integer("report_acquisition_cents"),
  reportGrossProfitCents: integer("report_gross_profit_cents"),
  /*
   * The same figure added up from the rows this reader actually got out of the file.
   *
   * Set against the report's own total it answers a question nothing else can: did we read
   * everything? A row skipped for a status this reader does not know does not announce itself —
   * the file simply loads, looks fine, and is quietly short. This is what makes that visible.
   */
  readGrossProfitCents: integer("read_gross_profit_cents"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now()),
});

/**
 * A month's takings, from the System Sales Summary — the only report that carries the whole till.
 *
 * One row per month, replaced when a later copy of the same month arrives, because these are
 * restatements rather than additions: a month re-run after a correction is the same month, and
 * keeping both would double the pharmacy's revenue.
 *
 * Kept apart from claims on purpose. Claims are dispensings, drawn by the day a claim was
 * transmitted; this is money, drawn by the calendar month, and it includes the front of shop that
 * no claim will ever describe. Reconciling the two is worth doing; merging them is not.
 */
export const salesMonths = sqliteTable("sales_months", {
  /** YYYY-MM. The primary key, so a re-sent month replaces rather than repeats. */
  month: text("month").primaryKey(),
  periodFrom: text("period_from").notNull(),
  periodTo: text("period_to").notNull(),
  /** Over the counter — the part of the business no prescription report can see. */
  retailCents: integer("retail_cents"),
  /** Sales tax collected on retail in the month, from the report's Tax column. Owed to the state, never revenue. */
  retailTaxCents: integer("retail_tax_cents"),
  /** What patients paid at the till for prescriptions. */
  rxPatientCents: integer("rx_patient_cents"),
  /** What the plans remitted. */
  rxRemitCents: integer("rx_remit_cents"),
  rxCents: integer("rx_cents"),
  /** Everything: the figure to reconcile against the bank. */
  totalCents: integer("total_cents"),
  /** Every line as printed, so a figure on screen can always be traced to the page it came from. */
  rowsJson: text("rows_json").notNull().default("[]"),
  fileName: text("file_name"),
  printedOn: text("printed_on"),
  documentId: text("document_id"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now()),
  updatedAt: text("updated_at").notNull().default(now()),
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
    /**
     * What the patient was left owing after this adjudication — the report's "Total" column.
     *
     * Not the same as the copay, and the difference is money. On a fill where the plan pays nothing
     * and applies it to a deductible, the copay column reads $0.00 while the patient is left owing
     * the lot; taking the copay as the patient's payment then loses the whole of it. On one real
     * fill that was $115.57 on a $161.83 prescription, which turned $33.14 of margin into an
     * $82.43 loss on the screen.
     *
     * In a coordinated chain each adjudication leaves a smaller figure here, and the last one is
     * what the patient actually hands over.
     */
    patientTotalCents: integer("patient_total_cents"),
    awpCents: integer("awp_cents"),
    acquisitionCents: integer("acquisition_cents"),
    grossProfitCents: integer("gross_profit_cents"),
    /*
     * The facilitator payment the plan promised at adjudication, where the report carries one.
     *
     * PioneerRx knows a Part D fill has a manufacturer share coming because the plan's response
     * says so; the money follows weeks later from the Medicare Transaction Facilitator. Held here,
     * a fill that lost money on the day can say what it is still owed and by whom — and a promise
     * that never turns into a payment becomes chaseable instead of invisible.
     *
     * Null means the report said nothing, which is not the same as a promise of zero.
     */
    expectedFacilitatorCents: integer("expected_facilitator_cents"),
    /*
     * The pharmacy's own cash programme rather than a third party.
     *
     * These fills were dropped on import for months, which quietly deleted the margin on the only
     * business the pharmacy prices itself. They are kept now and counted in what the day made —
     * and excluded from every question that presumes an insurer: there is no floor for the state
     * to enforce on a price the pharmacy set, no contract to appeal under, and a low number is
     * simply what it charged.
     */
    cashPlan: integer("cash_plan", { mode: "boolean" }).notNull().default(false),
    ingredientPaidCents: integer("ingredient_paid_cents"),
    dispensingFeePaidCents: integer("dispensing_fee_paid_cents"),
    daw: text("daw"),

    /*
     * Whether the money on this row was kept.
     *
     * The transaction report carries a paid claim, its reversal and the resubmission as three
     * rows. A reversal does not delete the claim it cancels — the record stays, marked reversed,
     * with the date — so the floor check prices only what the pharmacy actually kept, and the
     * history still shows what was billed and taken back.
     */
    status: text("status", { enum: ["paid", "reversed"] }).notNull().default("paid"),
    /**
     * Billed to an account rather than collected at the counter: the report's "AR" status.
     *
     * Deliberately not a status. The status says what happened to the *dispensing* — it went out,
     * or it was reversed — and an account sale went out like any other: the drug left the shelf,
     * the acquisition cost is real, and PioneerRx counts it in its grand total. Setting these five
     * rows aside is exactly why this site's totals came to $2,849.76 less than the report's.
     *
     * What is different is only where the money is, so it rides alongside. Everything that should
     * include it — cost of goods, what moved, the report's own arithmetic — does so without
     * knowing this column exists; only the cash side has to ask.
     */
    onAccount: integer("on_account", { mode: "boolean" }).notNull().default(false),
    reversedOn: text("reversed_on"),
    /**
     * The day the fill was sold, as the transaction report had it.
     *
     * Null means the claim had been transmitted but not picked up when the report was drawn. The
     * report is drawn by transmission day, so this stays null unless a later file (a report run
     * over a window that reaches back) carries the same row with the date filled in. A claim never
     * picked up is not deleted; its reversal arrives in a later day's file and marks it reversed.
     */
    completedAt: text("completed_at"),
    /** Identifies one row of the transaction report, so a re-sent day is not loaded twice. */
    transactionKey: text("transaction_key"),
    /** The transaction-report row that reversed this claim, so a re-sent reversal is recognised too. */
    reversalKey: text("reversal_key"),
    /** Which report the row came from: "export" (one row per fill) or "transaction_report". */
    source: text("source").notNull().default("export"),

    /** Everything the export carried, kept verbatim so a later question needs no re-import. */
    rawJson: text("raw_json"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("claims_import_idx").on(t.importId),
    index("claims_txn_idx").on(t.transactionKey),
    index("claims_reversal_idx").on(t.reversalKey),
    index("claims_status_idx").on(t.status),
    index("claims_pbm_idx").on(t.pbmName),
    index("claims_bin_idx").on(t.bin),
    index("claims_date_idx").on(t.dateFilled),
    index("claims_rx_idx").on(t.rxNumber),
    /** The in-force NADAC query and every "paid claims since" read: status, then NDC, then date. */
    index("claims_paid_ndc_date_idx").on(t.status, t.ndc11, t.dateFilled),
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
  /*
   * A manufacturer copay or savings card, which is not a plan at all.
   *
   * Kept apart from a discount card, which it is constantly confused with, because the two behave
   * in opposite directions. A discount card *replaces* insurance and sets the price: a low payment
   * on one is the price, not a shortfall. A copay card sits *on top of* a plan and pays down what
   * the patient was left owing on a brand drug — so it arrives as a second claim on a fill that
   * already has a payer, and it pays a residual rather than a drug.
   *
   * Both are out of the Kansas floor's reach, and neither is a payer worth ranking. Ranked as one,
   * a copay card is the best payer in the pharmacy — it covers a hundred percent of whatever is put
   * to it — and the brand plan it is subsidising, which may be paying badly, is flattered by it.
   */
  "copay_card",
  "unknown",                  // not yet determined. Never files.
] as const;
export type PlanClass = (typeof PLAN_CLASSES)[number];

/**
 * A key seen on a claim, tied once to the payer and the contract behind it.
 *
 * The alternative is searching the contracts every time, which is what the site did first: it found
 * the answer, showed it, and forgot it, so the same twenty PDFs were read again on the next page
 * load and nobody's decision was ever recorded. A search finds a candidate; a person confirms it;
 * this is where that confirmation lives.
 *
 * Keyed on whatever the claim actually carried. A BIN alone identifies a processor, not a plan —
 * one BIN can front a dozen employers — so the group number and the network or contract id printed
 * on the claim are part of the key where they exist. A row with a null group matches any group,
 * which is the right answer for a processor that runs one contract.
 */
// ── What the site has told the owner to do, and what came of it ─────────
// A recommendation that is shown once and forgotten teaches nobody anything. Each row of the money
// list is remembered from the day it first appeared: how much it said, whether it was acted on,
// and what actually happened afterwards — so the site can say "the last twelve times it said
// switch NDC, the margin moved by this much", and stop repeating advice that was tried and did
// nothing. Appended by the site, judged by the claims; only `status` and `note` are typed by a
// person.
export const recommendationLog = sqliteTable(
  "recommendation_log",
  {
    id: text("id").primaryKey(),
    /** The money-list row key, e.g. "switch-ndc", plus the thing it was about where there is one. */
    key: text("key").notNull(),
    subject: text("subject"),
    says: text("says").notNull(),
    todo: text("todo").notNull(),
    amountCents: integer("amount_cents").notNull(),
    cadence: text("cadence").notNull(),
    confidence: text("confidence").notNull(),
    firstSeenOn: text("first_seen_on").notNull(),
    lastSeenOn: text("last_seen_on").notNull(),
    /** The day it stopped appearing, because it was done or because the facts moved. */
    resolvedOn: text("resolved_on"),
    /** open | acted | dismissed | resolved. A person marks acted or dismissed; the site marks resolved. */
    status: text("status").notNull().default("open"),
    /** What the claims showed afterwards, in cents, where the site could measure it. Null until it can. */
    outcomeCents: integer("outcome_cents"),
    outcomeBasis: text("outcome_basis"),
    measuredOn: text("measured_on"),
    note: text("note"),
  },
  (t) => [index("recommendation_log_key_idx").on(t.key), index("recommendation_log_status_idx").on(t.status)],
);

export const payerLinks = sqliteTable(
  "payer_links",
  {
    id: text("id").primaryKey(),
    bin: text("bin"),
    /** The processor control number, where the claim carried one. */
    pcn: text("pcn"),
    groupNumber: text("group_number"),
    /** The network reimbursement or contract id PioneerRx prints on the claim. */
    contractId: text("contract_id"),
    /** Who this is, settled. */
    pbmName: text("pbm_name").notNull(),
    /** The contract document this plan is priced under, where one is on file. */
    contractDocId: text("contract_doc_id"),
    /** The contract PDF's own file name, so the link survives a checklist rebuild. */
    contractFileName: text("contract_file_name"),
    /** Why this is the answer: the sentence from the contract, or who said so. */
    basis: text("basis"),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedOn: text("confirmed_on").notNull().default(now()),
  },
  (t) => [index("payer_links_bin_idx").on(t.bin), index("payer_links_pbm_idx").on(t.pbmName)],
);

/**
 * Money that reaches a claim after it was adjudicated.
 *
 * A claim's revenue is not settled on the day it is transmitted. A Medicare Transaction Facilitator
 * payment arrives later and has to be matched back to the fill it belongs to. So does a DIR
 * reconciliation, a copay card posted after the fact, or a secondary that adjudicated a week on.
 * Held only as what the daily report said on the day, every one of those is money the pharmacy
 * received and this system never counted — and a fill sits on the "dispensed at a loss" list
 * because of a payment that has since arrived.
 *
 * Kept as its own rows rather than added into the claim, so what was paid on the day stays
 * distinguishable from what arrived afterwards. That distinction is the whole point when a payer
 * is being judged: the plan paid what the plan paid, and a facilitator payment on top of it is not
 * the plan's money.
 */
export const claimPayments = sqliteTable(
  "claim_payments",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id").references(() => claims.id, { onDelete: "cascade" }),
    /** Where the fill can be found again when the claim row is not known: the natural key. */
    rxNumber: text("rx_number").notNull(),
    fillNumber: integer("fill_number"),
    dateFilled: text("date_filled"),
    ndc11: text("ndc11"),
    /** "mtf", "dir", "copay_card", "secondary", "manual". */
    source: text("source").notNull(),
    /** Who paid it, as the remittance names them. */
    payer: text("payer"),
    amountCents: integer("amount_cents").notNull(),
    /*
     * How much of this payment is money the claim did not already carry.
     *
     * Not every payment is new revenue. The RxRescue credit memo settles the copay assistance that
     * the ACR claim was already adjudicated for — the same money, arriving — while its top-off is
     * genuinely additional. Adding the whole credit would count the assistance twice: on one real
     * fill that is $1,096.91 counted as though the pharmacy had been paid it twice over.
     *
     * A facilitator remittance is the opposite: the claim's Amount never contained it, so all of it
     * is new. Defaults to the whole amount, which is right for every source but this one.
     */
    revenueCents: integer("revenue_cents"),
    /** When the money was received, not when the claim was filled. */
    receivedOn: text("received_on"),
    /** The remittance or file this came from, so it can be traced back. */
    reference: text("reference"),
    notes: text("notes"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("claim_payments_claim_idx").on(t.claimId), index("claim_payments_rx_idx").on(t.rxNumber), index("claim_payments_received_idx").on(t.receivedOn)],
);

export const planGroups = sqliteTable(
  "plan_groups",
  {
    id: text("id").primaryKey(),
    /** The natural key of a plan on a claim: who processes it and under which group. */
    bin: text("bin"),
    /**
     * The processor control number, which with the BIN says which processor and usually which line
     * of business. One BIN carries a commercial PCN and a Part D PCN side by side; a register keyed
     * on BIN and group alone classified them as one plan. Null on rows made before the PCN was kept:
     * those stand as a fallback for any PCN until a row for the PCN is decided.
     */
    pcn: text("pcn"),
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
  /** The register row the file's supplier name matched, so the catalogue hangs off the same supplier as the invoices. Null when nothing matched. */
  supplierId: text("supplier_id"),
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
    /** The register row this supplier name matched at import time. Null when nothing matched. */
    supplierId: text("supplier_id"),
    ndc11: text("ndc11").notNull(),
    /** The supplier's own item number for this line, as printed on their file: what an order is placed by. */
    itemNumber: text("item_number"),
    description: text("description"),
    /** Derived from the description so items can be compared across suppliers and against claims. */
    productKey: text("product_key"),
    manufacturer: text("manufacturer"),
    packSize: text("pack_size"),
    /** Cost per dispensing unit, in millionths of a dollar. */
    unitCostMicros: integer("unit_cost_micros"),
    /** Cost of the whole package, in cents. */
    packCostCents: integer("pack_cost_cents"),
    /**
     * Average Wholesale Price for the package, in cents, where the catalogue prints it.
     *
     * Never a cost and never a price the pharmacy pays or charges — it is the published list
     * figure, and it is here because a good many contracts and reimbursement formulas are still
     * quoted as a discount off it, so a margin cannot be argued without it.
     */
    awpCents: integer("awp_cents"),
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


/**
 * A correction to one catalogue row, kept apart from the catalogue itself.
 *
 * The catalogue is replaced every week by whatever the supplier sends. A pack size fixed by hand
 * on Monday would be gone by the following Monday, and the pharmacy would fix it again, and again,
 * and eventually stop trusting the screen. So the correction lives in its own table and is applied
 * over the top of each import: the supplier's file stays exactly as it arrived, and what the site
 * uses is the file with the pharmacy's own corrections on it.
 *
 * Keyed on supplier and NDC, because the same drug can be wrong at one wholesaler and right at
 * another, and correcting it everywhere on one supplier's mistake would be a second mistake.
 */
export const supplierItemFixes = sqliteTable(
  "supplier_item_fixes",
  {
    id: text("id").primaryKey(),
    supplier: text("supplier").notNull(),
    ndc11: text("ndc11").notNull(),
    /** The pack size as it should read — "180 EA". Null leaves the supplier's own. */
    packSize: text("pack_size"),
    /** Cost per dispensing unit in millionths, where the supplier's is wrong. Null leaves theirs. */
    unitCostMicros: integer("unit_cost_micros"),
    /** Why, in the pharmacy's words. It is the only record of what was checked against what. */
    note: text("note"),
    correctedBy: text("corrected_by").notNull(),
    correctedAt: text("corrected_at").notNull().default(now()),
  },
  (t) => [uniqueIndex("supplier_item_fixes_key_idx").on(t.supplier, t.ndc11)],
);

/**
 * What a package of this NDC actually holds, decided once by the pharmacy.
 *
 * An NDC names a package. Two wholesalers listing the same NDC at different pack sizes are not
 * describing two products — one of them is wrong — and the same is true when a wholesaler's file
 * disagrees with what PioneerRx counted off the shelf. The pharmacy is the only party that can
 * settle it, because the pharmacy has the bottle.
 *
 * So this is keyed on the NDC alone, not on the supplier. `supplier_item_fixes` corrects one
 * wholesaler's row; this says what the package is, everywhere, for everyone — which is what makes
 * a disagreement between suppliers fixable in one action rather than once per supplier, and what
 * makes the answer still right when a supplier the pharmacy has never bought from sends a file
 * next week.
 *
 * A supplier-specific fix still wins where one exists: it is the more specific statement, and it
 * is how a pharmacy records that one wholesaler genuinely ships a different configuration.
 */
export const ndcPackFixes = sqliteTable("ndc_pack_fixes", {
  id: text("id").primaryKey(),
  ndc11: text("ndc11").notNull().unique(),
  /** The pack size as it should read — "180 EA", "60 ML". */
  packSize: text("pack_size").notNull(),
  /** What it was checked against: the bottle, the invoice, the manufacturer's page. */
  note: text("note"),
  correctedBy: text("corrected_by").notNull(),
  correctedAt: text("corrected_at").notNull().default(now()),
});

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
    /**
     * Short code carried in the email subject, so a reply can be matched back to this assignment.
     *
     * Not a secret and not treated as one — matching a reply requires the code *and* the sending
     * address to be the person's own. It exists because "Re: your training" with no code is
     * unmatchable when someone has three trainings outstanding.
     */
    replyCode: text("reply_code"),
    assignedOn: text("assigned_on").notNull(),
    dueOn: text("due_on").notNull(),
    /** Where the material lives, if it is not being read on the page itself. */
    materialUrl: text("material_url"),
    /**
     * A document from the vault sent with the email.
     *
     * A link to a policy manual is a link somebody has to be on the pharmacy network to open. The
     * document itself, attached, is what proves the pharmacy provided the material rather than
     * merely pointed at it — the same distinction that made the course packets worth attaching.
     */
    materialDocumentId: text("material_document_id"),
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

    /**
     * The comprehension check.
     *
     * A record that someone read a page is weaker than one that says they answered questions
     * about it correctly, and the difference costs the person about ninety seconds. Stored as
     * the score rather than as a pass flag so the certificate can state it plainly.
     */
    quizCorrect: integer("quiz_correct"),
    quizTotal: integer("quiz_total"),
    /**
     * Bloodborne pathogens training requires an opportunity for interactive questions and
     * answers with a knowledgeable person — 29 CFR 1910.1030(g)(2)(vii). A web page is not that
     * person, so the page names the PIC and this records that the opportunity was given and
     * acknowledged. Without it the training does not meet the standard, however good the content.
     */
    liveQuestionsAcknowledged: integer("live_questions_acknowledged", { mode: "boolean" }).notNull().default(false),

    /**
     * How the completion arrived: signed on the page, or asserted in an email reply.
     *
     * These are not equally strong and the certificate says which. A signed page carries a typed
     * name, a timestamp, a device and a passed comprehension check; an email reply carries a
     * From header, which is asserted by the sender's mail system rather than proven. The reply
     * is worth accepting — it is how people actually respond — but recording it as though
     * somebody sat the course is how a training file stops being believed.
     */
    completedVia: text("completed_via", { enum: ["signed", "email_reply", "pic_recorded"] }),
    /** The reply itself, filed as evidence. */
    replyDocumentId: text("reply_document_id"),
    replyFromAddress: text("reply_from_address"),
    /**
     * The pharmacist-in-charge's attestation that the questions and answers happened.
     *
     * The half an email cannot carry. 29 CFR 1910.1030(g)(2)(vii)(N) asks for an opportunity for
     * interactive questions and answers with a person knowledgeable in the subject — the person's
     * reply evidences that they were given the material and read it, and this evidences the other
     * half. Together they are a complete record; either alone is not.
     *
     * Deliberately separate from liveQuestionsAcknowledged, which is the person ticking a box on
     * the course page. This is the trainer saying it, which is whose statement the standard wants.
     */
    qaAttestedOn: text("qa_attested_on"),
    qaAttestedBy: text("qa_attested_by"),
    /** What was gone through, in the trainer's words. */
    qaNote: text("qa_note"),
    /**
     * The trainer's attestation as an actual electronic signature, not a button press.
     *
     * Points at a row in record_signatures carrying the wording, the typed name, the deliberate
     * act of ticking to sign, the time, the address and the device. The two halves of this record
     * are then both signatures in the sense the ESIGN Act and the Kansas UETA mean — the
     * employee's made by replying from their own address with the code issued to them, the
     * trainer's made here — and the certificate can print both rather than describing them.
     */
    qaSignatureId: text("qa_signature_id"),
    /**
     * The version of the course material actually sent to this person.
     *
     * Stamped on the certificate. Without it a certificate says a person was trained and leaves
     * the pharmacy unable to say on what — and a course edited since is not the course they sat.
     */
    materialVersion: text("material_version"),
    materialSentAt: text("material_sent_at"),

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


// ── The shelf ────────────────────────────────────────────────────────
// What is physically here, counted rather than computed. Claims say what left and invoices say
// what arrived, and the difference between them is not what is on the shelf — short fills, partial
// bottles, returns, breakage and every count ever done sit in that gap. So it is read from a daily
// export and stored as a snapshot per day, never accumulated.

export const onHandImports = sqliteTable(
  "on_hand_imports",
  {
    id: text("id").primaryKey(),
    /** The date the count represents, not the date it was uploaded. One snapshot per date. */
    countedOn: text("counted_on").notNull(),
    fileName: text("file_name").notNull(),
    rowsRead: integer("rows_read").notNull().default(0),
    itemsKept: integer("items_kept").notNull().default(0),
    /** Reasons rows were dropped, as JSON, so a short read is visible rather than silent. */
    skipReasons: text("skip_reasons").notNull().default("{}"),
    /** Columns in the file this site had no meaning for. */
    unmappedColumns: text("unmapped_columns").notNull().default("[]"),
    unitsThousandths: integer("units_thousandths").notNull().default(0),
    /** The whole building's stock value, front shop included, where the file carried one. */
    valueCents: integer("value_cents"),
    /**
     * The dispensing shelf's share of it.
     *
     * The accounts check cost of goods as opening + purchases − closing against what the claims say
     * was dispensed, and that identity only holds if both sides count the same shelf. A month where
     * the front shop sold a hundred bottles of vitamins would otherwise show up as a hundred
     * bottles of unexplained drug cost.
     */
    rxValueCents: integer("rx_value_cents"),
    documentId: text("document_id"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [uniqueIndex("on_hand_imports_counted_idx").on(t.countedOn)],
);

export const onHand = sqliteTable(
  "on_hand",
  {
    id: text("id").primaryKey(),
    importId: text("import_id").notNull().references(() => onHandImports.id, { onDelete: "cascade" }),
    /** Copied from the import so a day's shelf is one query without a join. */
    countedOn: text("counted_on").notNull(),
    /**
     * The item's code as the pharmacy's own system carries it — an NDC for anything dispensed, a
     * UPC for a front-shop item. It is the key, because the front shop has no NDCs.
     */
    code: text("code").notNull(),
    codeKind: text("code_kind").notNull().default("ndc11"),
    /** The NDC where the code is one, and null for a barcode, so nothing joins a UPC to a drug. */
    ndc11: text("ndc11"),
    description: text("description"),
    itemNumber: text("item_number"),
    /** "Rx" or "Retail": which shelf, and so which tools should be looking at it. */
    inventoryGroup: text("inventory_group"),
    /** Units on the shelf, in thousandths, always dispensing units even where the file counted packs. */
    quantityThousandths: integer("quantity_thousandths").notNull(),
    /** Ordered and not yet arrived, dispensing units, so the buy list does not order it twice. */
    onOrderThousandths: integer("on_order_thousandths"),
    /** Units in one package, which is what turns "order 140" into "order two bottles". */
    packQty: integer("pack_qty"),
    /** True where the file counted packages and the reader multiplied them out. */
    countedInPackages: integer("counted_in_packages", { mode: "boolean" }).notNull().default(false),
    unit: text("unit"),
    unitCostMicros: integer("unit_cost_micros"),
    valueCents: integer("value_cents"),
  },
  (t) => [
    index("on_hand_counted_idx").on(t.countedOn),
    uniqueIndex("on_hand_counted_code_idx").on(t.countedOn, t.code),
    index("on_hand_ndc_idx").on(t.ndc11),
  ],
);


// ── Supplies ─────────────────────────────────────────────────────────
// Vials, bags, labels and receipt tape: the things the pharmacy cannot dispense without and which
// nothing in the building counts. There is no claims feed for a box of 30 dram vials — it is
// opened, used and thrown away without a record — so the only evidence of how fast they go is the
// difference between two counts, and the only way to get ahead of a stockout is to log those
// counts and let the site work out the rate.

export const supplyItems = sqliteTable(
  "supply_items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * What one of it is, and it is what the pharmacy counts rather than what it uses.
     *
     * Vials are kept and ordered by the box. Counting them as vials means counting to two thousand
     * on a shelf and reordering in units nobody buys in, so the unit of issue is the box and the
     * count of vials inside it is information, not arithmetic.
     */
    unit: text("unit").notNull().default("box"),
    /** Vials per box, labels per roll. Shown, never used to convert a count. */
    perUnit: integer("per_unit"),
    /** Who it is ordered from. */
    vendorId: text("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    /** Their code for it, so an order email says something the rep can act on without translating. */
    supplierCode: text("supplier_code"),
    /** Days from sending the order to it being on the shelf. */
    leadTimeDays: integer("lead_time_days").notNull().default(5),
    /** Cover held beyond the lead time, so a busy week is not a stockout. */
    safetyDays: integer("safety_days").notNull().default(7),
    /** How many days of stock an order should bring the shelf up to. */
    targetDays: integer("target_days").notNull().default(45),
    /** Ordered in whole cases where the supplier sells that way. */
    orderMultiple: integer("order_multiple"),
    notes: text("notes"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("supply_items_active_idx").on(t.active)],
);

export const supplyCounts = sqliteTable(
  "supply_counts",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => supplyItems.id, { onDelete: "cascade" }),
    /** The day the shelf was counted, which is not always the day it was typed in. */
    countedOn: text("counted_on").notNull(),
    quantity: real("quantity").notNull(),
    countedBy: text("counted_by"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [uniqueIndex("supply_counts_item_day_idx").on(t.itemId, t.countedOn)],
);

/**
 * An order placed with a rep, and what came of it.
 *
 * Kept because a delivery is half of the usage arithmetic. Two counts either side of an unlogged
 * delivery report a week where nothing was used, and every reorder date built on that is late by
 * exactly as much as the pharmacy orders — so the busiest items fail worst.
 */
export const supplyOrders = sqliteTable(
  "supply_orders",
  {
    id: text("id").primaryKey(),
    vendorId: text("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    vendorName: text("vendor_name").notNull(),
    /** Where the order was sent, kept as sent rather than looked up again later. */
    sentTo: text("sent_to"),
    placedOn: text("placed_on").notNull(),
    status: text("status", { enum: ["draft", "sent", "received", "cancelled"] }).notNull().default("draft"),
    /** The body of the email, exactly as it went, so there is no doubt what was asked for. */
    body: text("body"),
    sentAt: text("sent_at"),
    sendError: text("send_error"),
    receivedOn: text("received_on"),
    placedBy: text("placed_by").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("supply_orders_status_idx").on(t.status)],
);

export const supplyOrderLines = sqliteTable(
  "supply_order_lines",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => supplyOrders.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull().references(() => supplyItems.id, { onDelete: "cascade" }),
    /** What was asked for. */
    quantity: real("quantity").notNull(),
    /**
     * What actually turned up, which is not always what was asked for.
     *
     * The rate is worked out from what arrived, never from what was ordered — a short shipment
     * counted as a full one reports usage that never happened and brings the next order forward.
     * Null until the delivery is confirmed.
     */
    receivedQuantity: real("received_quantity"),
  },
  (t) => [index("supply_order_lines_order_idx").on(t.orderId), index("supply_order_lines_item_idx").on(t.itemId)],
);


// ── Appeals and complaints, as sent ──────────────────────────────────
/**
 * Every appeal or complaint the site prepared: what it asked for, where it went, when, and what
 * came back. The packet is kept as it stood when it was sent (`packet_json`), and the PDF is a
 * document, so what was claimed can be produced rather than described. An appeal is scored by the
 * next remittance, like a recommendation: `outcome_cents` is what the reprocessed claim paid over
 * the original.
 */
export const appeals = sqliteTable(
  "appeals",
  {
    id: text("id").primaryKey(),
    /** "mac_appeal" to the PBM, or "floor_complaint" to the Kansas Insurance Department. */
    kind: text("kind", { enum: ["mac_appeal", "floor_complaint"] }).notNull(),
    claimId: text("claim_id").references(() => claims.id, { onDelete: "set null" }),
    rxNumber: text("rx_number"),
    fillNumber: integer("fill_number"),
    dateFilled: text("date_filled"),
    ndc11: text("ndc11"),
    pbmName: text("pbm_name").notNull(),
    /** For a floor complaint: every claim it covers, as JSON ids. */
    claimIds: text("claim_ids"),
    shortfallCents: integer("shortfall_cents").notNull().default(0),
    deadline: text("deadline"),
    status: text("status", { enum: ["prepared", "sent", "answered", "won", "lost", "withdrawn"] }).notNull().default("prepared"),
    /** "email", "portal", "fax", "mail" — how it went, or is to go. */
    channel: text("channel"),
    target: text("target"),
    packetJson: text("packet_json").notNull(),
    documentId: text("document_id"),
    sentAt: text("sent_at"),
    sentBy: text("sent_by"),
    sendResult: text("send_result"),
    responseDueOn: text("response_due_on"),
    outcomeCents: integer("outcome_cents"),
    outcomeNote: text("outcome_note"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("appeals_claim_idx").on(t.claimId), index("appeals_pbm_idx").on(t.pbmName), index("appeals_status_idx").on(t.status)],
);

/**
 * Getting each PBM's 835 delivered to this site: the enrollment, per payer, with its state.
 *
 * The contract states the payment path; the change is an EFT/ERA enrollment on the PBM's portal
 * or form. The site's part is to hold the request, the delivery point and the dates, so the
 * checklist (requested, confirmed, first 835 received) is a record and not a memory.
 */
export const eraEnrollments = sqliteTable(
  "era_enrollments",
  {
    id: text("id").primaryKey(),
    pbmName: text("pbm_name").notNull(),
    status: text("status", { enum: ["not_started", "requested", "confirmed", "receiving", "declined"] }).notNull().default("not_started"),
    /** Where the 835 is to be delivered: the mailbox the site reads, or a clearinghouse/SFTP the site watches. */
    deliveryTarget: text("delivery_target"),
    requestedOn: text("requested_on"),
    requestedTo: text("requested_to"),
    confirmedOn: text("confirmed_on"),
    firstRemitOn: text("first_remit_on"),
    documentId: text("document_id"),
    notes: text("notes"),
    updatedBy: text("updated_by"),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("era_enrollments_pbm_idx").on(t.pbmName)],
);

/**
 * A cost that is the same every month and known before its bill arrives.
 *
 * Payroll, rent, the software, the loan. A month in progress carries the share of it the days so far
 * are owed — thirty thousand of payroll is ten thousand by the tenth — so the month-to-date account
 * is not flattered by bills that have not come yet. A finished month carries the whole amount. A
 * real bill entered for the same vendor in the same month replaces it, so nothing is counted twice.
 * Only what the owner typed a monthly figure for is treated this way; nothing is inferred from
 * history.
 */
export const standingCosts = sqliteTable(
  "standing_costs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    categoryId: text("category_id").references(() => expenseCategories.id),
    /** The vendor whose real bill, when it is entered for a month, takes this month's place. */
    vendorId: text("vendor_id").references(() => vendors.id),
    /** The whole month's figure, in cents. */
    amountCents: integer("amount_cents").notNull(),
    /**
     * The day of the month the money leaves the bank (1-31), for the cash account: payroll on the
     * 15th, rent on the 1st. Null where nobody has said, and then the cash account leaves the cost
     * out and names it; the accrual account carries it by the day either way.
     */
    paidDay: integer("paid_day"),
    /** First month it applies to, YYYY-MM. */
    fromMonth: text("from_month").notNull(),
    /** Last month it applies to, YYYY-MM, or null while it runs. */
    toMonth: text("to_month"),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [index("standing_costs_from_idx").on(t.fromMonth)],
);

// The FDA NDC Directory joined to the Orange Book: one row per package NDC, with the equivalence
// key (ingredients, strength, form, route) and the therapeutic equivalence code that together say
// which NDCs may be dispensed in place of one another. Read from the two free federal files, never
// inferred from a description; an NDC the directory does not cover has no row and is not grouped.
export const drugDirectory = sqliteTable(
  "drug_directory",
  {
    ndc11: text("ndc11").primaryKey(),
    productNdc: text("product_ndc").notNull(),
    brandName: text("brand_name"),
    genericName: text("generic_name").notNull(),
    substances: text("substances").notNull(),
    strength: text("strength").notNull(),
    form: text("form").notNull(),
    route: text("route").notNull(),
    labeler: text("labeler").notNull(),
    application: text("application"),
    marketingCategory: text("marketing_category").notNull(),
    deaSchedule: text("dea_schedule"),
    packageDescription: text("package_description").notNull(),
    equivalenceKey: text("equivalence_key").notNull(),
    teCode: text("te_code"),
    teWhy: text("te_why"),
    marketedTo: text("marketed_to"),
    excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
    loadedAt: text("loaded_at").notNull().default(now()),
  },
  (t) => [index("drug_directory_key_idx").on(t.equivalenceKey), index("drug_directory_product_idx").on(t.productNdc)],
);

// Each load of the two files: which, from where, how many rows, and the file's own date where it
// prints one. The feeds page judges the directory's age from the newest of these.
export const drugDirectoryLoads = sqliteTable("drug_directory_loads", {
  id: text("id").primaryKey(),
  /** "ndc_directory" or "orange_book". */
  source: text("source").notNull(),
  /** Where it came from: the FDA address, or the file name when loaded by hand. */
  origin: text("origin").notNull(),
  rows: integer("rows").notNull().default(0),
  /** The date inside the file where it carries one, ISO; null where it does not. */
  fileAsOf: text("file_as_of"),
  loadedBy: text("loaded_by"),
  loadedAt: text("loaded_at").notNull().default(now()),
});

/**
 * What the owner has said a sender's mail actually is.
 *
 * The inbox guesses; this is what happens when it guesses wrong. A correction on the inbox page is
 * kept here against the sending address, so the next file from the same place is placed without
 * anybody being asked twice — which is the whole of the request. A rule is either the whole sender
 * ("everything from this address is a NADAC file") or a sender narrowed by a fragment of the
 * subject or the file name ("mail from McKesson whose file is named like 'credits' is a credit
 * memo"), and the narrow form exists because a supplier sends invoices and catalogues from one
 * address and a broad rule would file the catalogue as an invoice.
 *
 * `note` is the owner's own words at the moment of correcting, kept unedited: months later the
 * reason a rule exists is worth more than the rule.
 */
export const intakeRules = sqliteTable(
  "intake_rules",
  {
    id: text("id").primaryKey(),
    /** A whole address or a domain, lowercased, matched as a fragment of the sender. */
    address: text("address").notNull(),
    /** A key from CATEGORIES in intake-recognise.ts. Text, not an enum: a new category is a row, not a migration. */
    category: text("category").notNull(),
    /** Optional fragments that narrow the rule. Null means the rule covers everything from the address. */
    subjectFragment: text("subject_fragment"),
    fileNameFragment: text("file_name_fragment"),
    /** What the recogniser had thought when it was corrected, so a bad rule can be traced back. */
    wasGuessedAs: text("was_guessed_as"),
    note: text("note"),
    taughtBy: text("taught_by"),
    taughtAt: text("taught_at").notNull().default(now()),
  },
  (t) => [index("intake_rules_address_idx").on(t.address)],
);
