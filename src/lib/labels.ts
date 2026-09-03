import type { CredentialType, DocumentCategory, IncidentType, PersonRole, TrainingType } from "@/db/schema";

export const PERSON_ROLE_LABEL: Record<PersonRole, string> = {
  pharmacist: "Pharmacist",
  technician: "Pharmacy technician",
  intern: "Pharmacist intern",
  other: "Other staff",
};

export const CREDENTIAL_LABEL: Record<CredentialType, string> = {
  pharmacist_license: "Kansas pharmacist license",
  technician_registration: "Kansas technician registration",
  intern_registration: "Kansas intern registration",
  cpr: "CPR certification",
  immunization_protocol: "Immunization protocol",
  immunization_training: "Immunization training (ACPE / Board-approved)",
  controlled_substance_poa: "DEA power of attorney",
  pharmacy_registration: "Kansas pharmacy registration",
  dea_registration: "DEA registration",
  csos_certificate: "CSOS certificate",
  kmap_enrollment: "KMAP (Medicaid) enrollment",
  npi: "NPI",
  ncpdp: "NCPDP",
  liability_insurance: "Professional liability insurance",
  property_insurance: "Property / comprehensive insurance",
  workers_comp_insurance: "Workers' compensation insurance",
  cyber_insurance: "Cyber liability insurance",
  business_license: "Business license",
  sales_tax_permit: "Sales tax permit",
  psao_agreement: "PSAO agreement",
  wholesaler_account: "Wholesaler account / agreement",
  other: "Other document",
};

/** Which credential types make sense per person role (used for the add form). */
export const CREDENTIAL_TYPES_FOR_PERSON: CredentialType[] = [
  "pharmacist_license",
  "technician_registration",
  "intern_registration",
  "cpr",
  "immunization_training",
  // The signed protocol each immunizer works under. It was missing from this list, which meant
  // the dashboard demanded it of every immunizer and the staff page offered no way to record it —
  // an alert with no possible action behind it, which is worse than no alert.
  "immunization_protocol",
  "controlled_substance_poa",
  "npi",
  "other",
];

/**
 * What each role must hold, and what only applies to people who immunize.
 *
 * Kept here rather than derived on each screen so the staff page, the dashboard grid and the due
 * list cannot disagree about what somebody needs — which is how a requirement ends up chased in
 * one place and invisible in another.
 */
export function requiredCredentials(role: PersonRole, administersVaccines: boolean): CredentialType[] {
  const licence: CredentialType =
    role === "pharmacist" ? "pharmacist_license" : role === "technician" ? "technician_registration" : "intern_registration";
  return administersVaccines ? [licence, "cpr", "immunization_training", "immunization_protocol"] : [licence];
}
export const CREDENTIAL_TYPES_FOR_PHARMACY: CredentialType[] = [
  "pharmacy_registration",
  "dea_registration",
  "csos_certificate",
  "kmap_enrollment",
  "liability_insurance",
  "property_insurance",
  "workers_comp_insurance",
  "cyber_insurance",
  "business_license",
  "sales_tax_permit",
  "psao_agreement",
  "wholesaler_account",
  "npi",
  "ncpdp",
  "other",
];

/** Kansas renewal notes, shown as helper text. */
export const CREDENTIAL_HINT: Partial<Record<CredentialType, string>> = {
  pharmacist_license: "Renews every two years by June 30. 30 CE hours per biennium including the 1-hour Board course. No grace period.",
  technician_registration: "Renews every two years by October 31. 20 CE hours per period. No grace period.",
  intern_registration: "Expires six years from issuance.",
  cpr: "Required for anyone administering vaccines (K.S.A. 65-1635a). Track the card's expiration.",
  immunization_training: "ACPE or Board-approved immunization training. Does not expire — tick \"this does not expire\" and attach the certificate.",
  immunization_protocol: "The physician-signed protocol this person immunizes under. Reviewed and re-signed annually; record the date it was signed and the date it runs to.",
  controlled_substance_poa: "DEA power of attorney to sign 222 forms and order controlled substances.",
  pharmacy_registration: "Renews annually by June 30.",
  dea_registration: "Renews every three years. The CSOS certificate expires with it.",
  csos_certificate: "Expires with the DEA registration; a new key pair is required on renewal.",
  kmap_enrollment: "Revalidation every five years.",
  liability_insurance: "Track the policy expiration; renewals are usually annual.",
  property_insurance: "Track the policy expiration.",
  workers_comp_insurance: "Track the policy expiration.",
  business_license: "City or county licenses usually renew annually.",
};

export const DOCUMENT_CATEGORY_LABEL: Record<DocumentCategory, string> = {
  license: "License / registration",
  cpr_card: "CPR card",
  immunization_training: "Immunization training certificate",
  immunization_protocol: "Immunization protocol (physician-signed)",
  pharmacy_registration: "Pharmacy registration",
  dea_registration: "DEA registration",
  controlled_substance_poa: "DEA power of attorney",
  cs_inventory: "Controlled substance inventory",
  cs_discrepancy: "Inventory discrepancy",
  insurance: "Insurance policy / certificate",
  agreement: "Agreement / contract",
  cqi_summary: "CQI bimonthly summary (C-550)",
  cqi_incident: "CQI incident report / evaluation (C-650)",
  ce_certificate: "CE certificate",
  training_record: "Training record / attestation",
  policy: "Policy / procedure",
  report: "Report received by email",
  other: "Other",
};

export const INCIDENT_TYPE_LABEL: Record<IncidentType, string> = {
  wrong_drug: "Wrong drug",
  incorrect_strength: "Incorrect drug strength",
  incorrect_dosage_form: "Incorrect dosage form",
  wrong_patient: "Wrong patient",
  packaging_labeling_directions: "Inadequate or incorrect packaging, labeling, or directions",
  serious_harm: "Actual or potential serious harm to patient",
  other: "Other",
};

/**
 * Column-heading versions of the training names.
 *
 * Separate from the full labels because a grid has ten columns and a heading that wraps to three
 * lines, or gets machine-truncated to "The pharmacy's", tells the reader nothing. The full name
 * is still there on hover and everywhere there is room for it.
 */
export const TRAINING_SHORT: Record<TrainingType, string> = {
  fwa_general_compliance: "FWA",
  hipaa_privacy_security: "HIPAA",
  osha_bloodborne: "BBP",
  osha_hazard_communication: "HazCom",
  controlled_substance_diversion: "Diversion",
  immunization_protocol_review: "Protocol",
  cqi_program_review: "CQI",
  other: "Other",
};

export const TRAINING_LABEL: Record<TrainingType, string> = {
  fwa_general_compliance: "Fraud, waste & abuse + general compliance (annual)",
  hipaa_privacy_security: "HIPAA privacy & security",
  osha_bloodborne: "OSHA bloodborne pathogens",
  osha_hazard_communication: "OSHA hazard communication",
  controlled_substance_diversion: "Controlled substance diversion awareness",
  immunization_protocol_review: "Immunization protocol review",
  cqi_program_review: "CQI program review",
  other: "Other training",
};
