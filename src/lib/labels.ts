import type { CredentialType, DocumentCategory, IncidentType, PersonRole } from "@/db/schema";

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
  "controlled_substance_poa",
  "npi",
  "other",
];
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
  immunization_training: "ACPE or Board-approved immunization training; keep the certificate on file. The pharmacy's physician-signed protocol goes under Documents.",
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
  insurance: "Insurance policy / certificate",
  agreement: "Agreement / contract",
  cqi_summary: "CQI bimonthly summary (C-550)",
  cqi_incident: "CQI incident report / evaluation (C-650)",
  ce_certificate: "CE certificate",
  policy: "Policy / procedure",
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
