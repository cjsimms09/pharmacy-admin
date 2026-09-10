import type { PlanClass } from "@/db/schema";

/**
 * What the payer's own published pharmacy payer sheet says a BIN and PCN is.
 *
 * This is the primary source, and until now the site had none. Everything else it reads is an
 * intermediary's summary: the BIN listing is a third party's index, PioneerRx's plan file is a
 * software vendor's reference, the PCN is a code somebody has to interpret. A payer sheet is the
 * payer stating, in a document it publishes for pharmacies and stands behind, which BIN and PCN
 * carries which line of business. When Prime Therapeutics' commercial payer sheet prints
 * "61Ø455 … BCBS of Kansas BCBSKS" under the heading "For Prime Therapeutics Commercial Clients",
 * that is the end of the argument about whether those 158 claims are Medicare.
 *
 * ── Why it is a checked-in table and not a scrape ──
 *
 * These sheets are PDFs on a dozen different websites, revised on the payers' own schedules, behind
 * no API. Nothing here could reliably fetch and parse them, and a parser that got one wrong would
 * be the worst possible failure — a fabricated quote attached to a real URL. So each row was read
 * by hand from the named document, and each carries the sentence it was read from and the address
 * it was read at, so that anybody can open the document and check. A row nobody could verify is
 * absent rather than approximate: two of the routings this pharmacy bills are deliberately not here
 * for exactly that reason, and they stay on the owner's list.
 *
 * ── The line this file does not cross ──
 *
 * A payer sheet says "commercial". It does not say whether the employer behind a particular group
 * bought insurance from a state-regulated carrier or funds its own plan under ERISA, and that is the
 * only question the Kansas floor turns on. So a commercial entry classifies nothing. What it does
 * is turn the owner's question from "what on earth is BIN 610455 PCN BCBSKS" into "this is Blue
 * Cross Blue Shield of Kansas commercial — is this employer group insured or self-funded", which is
 * a question he can answer about his own patients' employers in a sitting. That is the whole point.
 *
 * Pure. No network, no database.
 */

/**
 * What a document can say, which is finer than the register's classes.
 *
 * The register has one `medicare`, correctly: Part D and Medicare Advantage are both federally
 * governed and the Kansas floor reaches neither, so they price identically. But the owner asked
 * which, and a document that says "H-contract, MA-PD" knows the answer, so it is kept.
 *
 * `commercial` and `federal_employee` map to no class at all — see below.
 */
export type LineOfBusiness =
  | "part_d"
  | "ma_pd"
  | "medicare_other"
  | "medicaid"
  | "commercial"
  | "federal_employee"
  | "workers_comp"
  | "discount_card"
  | "copay_card";

export const LOB_CLASS: Record<LineOfBusiness, PlanClass | null> = {
  part_d: "medicare",
  ma_pd: "medicare",
  medicare_other: "medicare",
  medicaid: "medicaid",
  workers_comp: "workers_comp",
  discount_card: "discount_card",
  copay_card: "copay_card",
  /*
   * Commercial is not an answer, and this null is the most important value in the file.
   *
   * A commercial payer sheet establishes the payer and the line of business and stops exactly where
   * the Kansas question begins. Mapping it to `commercial_fully_insured` would be a one-click ERISA
   * determination made from a document that does not address ERISA — the precise failure `plans.ts`
   * refuses, and the one that collapses a filing when somebody asks how it was established.
   */
  commercial: null,
  /*
   * A federal employee plan, which looks like the easiest call here and is the hardest.
   *
   * The BCBS Federal Employee Program is a Federal Employees Health Benefits plan. A governmental
   * plan is excluded from ERISA by definition, so the register's `governmental` class fits by the
   * letter — and `governmental` is in scope, which would put these claims inside the Kansas floor.
   * But FEHB is not governed by ERISA *or* by state law: 5 U.S.C. §8902(m)(1) preempts state law
   * relating to the benefits of an FEHB plan, and that preemption is at least as broad as the one
   * that takes self-funded employers out. Reading "not ERISA" as "therefore in scope" would file a
   * claim under a statute that does not reach it.
   *
   * That is a legal question about a federal preemption clause, not a fact about a BIN, so it is
   * the owner's to answer with advice — and the payer sheet is recorded so he starts from a fact.
   */
  federal_employee: null,
};

export const LOB_LABEL: Record<LineOfBusiness, string> = {
  part_d: "Medicare Part D (standalone PDP)",
  ma_pd: "Medicare Advantage (MA-PD)",
  medicare_other: "Medicare (federal, outside Part D)",
  medicaid: "Medicaid",
  commercial: "Commercial",
  federal_employee: "Federal employee health benefits (FEHB)",
  workers_comp: "Workers' compensation",
  discount_card: "Discount / cash card",
  copay_card: "Manufacturer copay or savings card",
};

export type PayerSheetEntry = {
  bin: string;
  /** Empty string where the document gives no PCN for the routing. */
  pcn: string;
  lineOfBusiness: LineOfBusiness;
  /** The plan or programme as the document names it. */
  name: string;
  /** Who published the document. Never an aggregator, never a forum. */
  publisher: string;
  url: string;
  /** The words the document uses. Quoted so anybody can open it and check. */
  quote: string;
  /**
   * What limits this row.
   *
   * Mostly one thing: a shared PCN where the RxGroup on the card, not the PCN, is what selects the
   * plan. Recorded rather than smoothed over, because a caveat nobody wrote down becomes a fact.
   */
  caveat?: string;
  checkedOn: string;
};

const CMS_BIN_PCN = "https://www.cms.gov/medicare/coverage/prescription-drug-coverage/part-d-information-pharmaceutical-manufacturers";
const KDHE = "https://www.kdhe.ks.gov/205/Managed-Care-Organization-Fee-For-Servic";
const CAREMARK_COMM = "https://www.caremark.com/content/dam/enterprise/caremark/pdfs/payer-sheets/caremark_payer_sheet_d.0_com.pdf";
const CAREMARK_MED = "https://www.caremark.com/content/dam/enterprise/caremark/pdfs/payer-sheets/caremark_payer_sheet_d.0_medicare.pdf";
const CAREMARK_MCAID = "https://www.caremark.com/content/dam/enterprise/caremark/pdfs/payer-sheets/caremark_payer_sheet_d.0_medicaid_ac.pdf";
const ESI_COMM = "https://www.express-scripts.com/files/hub/art/prc/NCPDP_vD0_Commercial_Combined_Payer_Sheet.pdf";
const ESI_MCAID = "https://www.express-scripts.com/art/prc/NCPDP_vD0_MEDICAID_Payer_Sheet.pdf";
const PRIME_COMM = "https://www.primetherapeutics.com/documents/9647575/9694006/Commercial-D.0-Payer-Sheet-FINAL-1.1.24.pdf";
const OPTUM_COMM_MCAID = "https://business.optum.com/content/dam/optum3/professional-optumrx/resources/payer-sheets/d-0-payer-sheet-2025-commercial-v01012025.pdf";

const ON = "2026-09-10";

/**
 * The routings this pharmacy actually bills, as the payers themselves describe them.
 *
 * ── What is deliberately NOT here ──
 *
 * BIN 024284 PCN ACR. The PCN belongs to Apollo Care's manufacturer-copay programme, but every
 * document that prints it puts it on BIN 610020, not 024284. Nothing published ties 024284 to
 * anything. It stays unestablished and stays on the owner's list; one call to the Apollo Care help
 * desk closes it.
 *
 * BIN 028249 PCN RXLOCAL. This is the pharmacy's own PharmD Loyalty cash plan, and RedSail publishes
 * no BIN anywhere — its own pages say "RedSail cash BIN" without printing the number. The only hits
 * are provenance-free BIN-lookup sites, which are not sources. It needs no public source: the site
 * already holds it in `cash_plans`, on the owner's own word, which for his own plan is the best
 * evidence there is.
 */
export const PAYER_SHEETS: PayerSheetEntry[] = [
  // ── Blue Cross Blue Shield of Kansas: three routings on one BIN, and they are three different laws ──
  {
    bin: "610455",
    pcn: "KSPDP",
    lineOfBusiness: "part_d",
    name: "BCBSKS Blue MedicareRx (contract S5726)",
    publisher: "CMS, Part D contract/plan BIN-PCN file (CY2026)",
    url: CMS_BIN_PCN,
    quote: 'The CMS BIN/PCN file lists "S5726 … 610455 KSPDP". An S-prefix contract is a standalone prescription drug plan. BCBSKS\'s own 2026 Summary of Benefits: "Blue Cross and Blue Shield of Kansas (BCBSKS) is a PDP plan with a Medicare contract."',
    checkedOn: ON,
  },
  {
    bin: "610455",
    pcn: "BCBSKS",
    lineOfBusiness: "commercial",
    name: "Blue Cross Blue Shield of Kansas, commercial",
    publisher: "Prime Therapeutics, commercial D.0 payer sheet",
    url: PRIME_COMM,
    quote: '"Payer Specification Sheet For Prime Therapeutics Commercial Clients … 61Ø455 … BCBS of Kansas KSBCS / BCBS of Kansas BCBSKS". It does not appear in the CMS Part D BIN/PCN file at all.',
    checkedOn: ON,
  },
  {
    bin: "610455",
    pcn: "KSPARTD",
    lineOfBusiness: "ma_pd",
    name: "BCBSKS Blue Medicare Advantage PPO (contract H7063)",
    publisher: "CMS, Part D contract/plan BIN-PCN file (CY2026)",
    url: CMS_BIN_PCN,
    quote: 'CMS lists "H7063 … 610455 KSPARTD" and nothing else on this pair — an H-prefix contract is a local Medicare Advantage plan, not a standalone PDP. BCBSKS: "Blue Cross and Blue Shield of Kansas is a PPO plan with a Medicare contract" (material ID H7063_Medicareweb7_C).',
    caveat: 'PioneerRx\'s plan file calls this "Bc/bs Kansas Pdp", which is wrong about which kind of Medicare it is. Both are federally governed and out of the Kansas floor\'s reach, so the class is unaffected.',
    checkedOn: ON,
  },
  {
    bin: "610455",
    pcn: "MPPPKS",
    lineOfBusiness: "part_d",
    name: "BCBSKS Medicare Prescription Payment Plan (M3P)",
    publisher: "CMS, Part D contract/plan BIN-PCN file (CY2026)",
    url: CMS_BIN_PCN,
    quote: 'MPPPKS appears only in the file\'s M3P columns — "m3p_bin_or_iin 610455 / m3p_pcn MPPPKS" — against contracts S5726 and H7063. It is the same Part D benefit billed under the Inflation Reduction Act\'s monthly payment programme, not a separate plan and not a copay card.',
    checkedOn: ON,
  },

  // ── Caremark ──
  {
    bin: "004336",
    pcn: "ADV",
    lineOfBusiness: "commercial",
    name: "CVS Caremark commercial",
    publisher: "CVS Caremark, commercial D.0 payer sheet",
    url: CAREMARK_COMM,
    quote: 'Appendix A, "Primary BIN and PCN Values": "ØØ4336, Ø21338 | ADV RXSADV DCADV".',
    caveat: "The same pair also appears on Caremark's Medicare sheet as a Part B route. It is not Part D on any sheet, and PioneerRx's plan file lists thirteen different plans on it — Amerigroup, Molina, Oklahoma State Employees among them — so the group number is what identifies the plan.",
    checkedOn: ON,
  },
  {
    bin: "004336",
    pcn: "MEDDADV",
    lineOfBusiness: "part_d",
    name: "CVS Caremark Medicare Part D",
    publisher: "CVS Caremark, Medicare D.0 payer sheet",
    url: CAREMARK_MED,
    quote: '"APPENDIX A: BIN/PCN COMBINATIONS … Medicare Part D Primary BIN and PCN Values … ØØ4336 / 61Ø591 MEDDADV". CMS lists 135 contracts on the pair, 127 of them MA-PD.',
    checkedOn: ON,
  },
  {
    bin: "610502",
    pcn: "MEDDAET",
    lineOfBusiness: "ma_pd",
    name: "Aetna Medicare Advantage",
    publisher: "CVS Caremark, Medicare D.0 payer sheet, with the CMS BIN-PCN file",
    url: CAREMARK_MED,
    quote: '"Medicare Part D Primary BIN and PCN Values … 610502 MEDDAET". CMS lists 45 contracts on the pair: 44 H-prefix and one regional, and no standalone PDP at all.',
    checkedOn: ON,
  },
  {
    bin: "610502",
    pcn: "00670000",
    lineOfBusiness: "commercial",
    name: "Aetna commercial",
    publisher: "CVS Caremark, commercial D.0 payer sheet",
    url: CAREMARK_COMM,
    quote: 'Appendix A: "610502 | 00670000 | AETCRXC". The help-desk table labels BIN 610502 "Aetna".',
    checkedOn: ON,
  },
  {
    bin: "610239",
    pcn: "FEPRX",
    lineOfBusiness: "federal_employee",
    name: "Blue Cross Blue Shield Federal Employee Program (FEHB)",
    publisher: "CVS Caremark, commercial D.0 payer sheet, with fepblue.org",
    url: CAREMARK_COMM,
    quote: 'Appendix A: "61Ø239 | FEPRX | Rx Group 65ØØ65ØØ", and the help-desk table labels BIN 61Ø239 "FEP". fepblue.org carries "Prescription Drug Coverage for FEHB". It is on Caremark\'s commercial sheet, not the Medicare one.',
    checkedOn: ON,
  },
  {
    bin: "020099",
    pcn: "WG",
    lineOfBusiness: "commercial",
    name: "CarelonRx commercial",
    publisher: "CVS Caremark, commercial D.0 payer sheet",
    url: CAREMARK_COMM,
    quote: 'Appendix A: "020099 | AC CH WG FC WK WP IS CS", and Part 1: "CarelonRx — 020099, 020123". Absent from the CMS Part D file.',
    checkedOn: ON,
  },
  {
    bin: "020107",
    pcn: "IN",
    lineOfBusiness: "medicaid",
    name: "CarelonRx Medicaid — Indiana",
    publisher: "CVS Caremark, Medicaid D.0 payer sheet",
    url: CAREMARK_MCAID,
    quote: '"APPENDIX A: BIN/PCN COMBINATIONS — Medicaid Primary BIN and PCN Values … 020107 | AC CH CM CS FC FG FM HL IN IRXKS KS KY LA NC NE NS NY QN SC WG WK WP". The PCNs on this BIN are state codes.',
    caveat: "IN is Indiana. Kansas's Healthy Blue KanCare plan is the same BIN with PCN IRXKS and RxGroup RX8481 (KDHE). Eight claims routing to another state's Medicaid programme is worth a look on its own account.",
    checkedOn: ON,
  },
  {
    bin: "020115",
    pcn: "IS",
    lineOfBusiness: "part_d",
    name: "CarelonRx / Anthem MediBlue Rx Medicare Part D",
    publisher: "CVS Caremark, Medicare D.0 payer sheet",
    url: CAREMARK_MED,
    quote: '"Medicare Part D Primary BIN and PCN Values … 020115 IS". CMS lists 49 contracts on the pair.',
    checkedOn: ON,
  },

  // ── Express Scripts ──
  {
    bin: "003858",
    pcn: "A4",
    lineOfBusiness: "commercial",
    name: "Legacy Express Scripts commercial",
    publisher: "Express Scripts, commercial combined D.0 payer sheet",
    url: ESI_COMM,
    quote: '"BIN/PCN Table … Legacy ESI Commercial — ØØ3858 — A4 (or as assigned by ESI)".',
    caveat: "A4 also appears on Express Scripts' Medicaid sheet under Legacy ESI Medicaid, and one MA-PD employer contract uses it. The RxGroup is what decides, so the fourteen group numbers on these 94 claims may not all be the same answer.",
    checkedOn: ON,
  },
  {
    bin: "003858",
    pcn: "MA",
    lineOfBusiness: "medicaid",
    name: "Sunflower Health Plan — KanCare (Kansas Medicaid)",
    publisher: "Kansas Department of Health and Environment",
    url: KDHE,
    quote: 'KDHE\'s MCO and fee-for-service billing code table: "Sunflower Health Plan (ESI - PBM) … RXBIN 003858 / PCN MA / RXGROUP 2ELA". Sunflower\'s own ID card bulletin prints the same three.',
    caveat: "KDHE: \"The claim requires the BIN, PCN, and Group number for each specific MCO for correct processing.\" Confirm the RxGroup on these claims reads 2ELA.",
    checkedOn: ON,
  },
  {
    bin: "003858",
    pcn: "SC",
    lineOfBusiness: "part_d",
    name: "Express Scripts — secondary where Medicare Part D is primary",
    publisher: "Express Scripts, commercial and Medicaid D.0 payer sheets",
    url: ESI_COMM,
    quote: 'Commercial sheet: "SC (When secondary to Medicare Part D only)". Medicaid sheet: "SC (Use when secondary to Medicare Part D only)".',
    caveat: "This is the wrap claim, not the Part D claim: another plan paying the balance a Part D plan left. PioneerRx's plan file calls it \"Champus Ok/tricare Pdp\", which is a different thing again. Two claims, $15.55 — worth knowing, not worth chasing.",
    checkedOn: ON,
  },
  {
    bin: "003858",
    pcn: "WC",
    lineOfBusiness: "workers_comp",
    name: "myMatrixx by Evernorth (Express Scripts workers' compensation)",
    publisher: "myMatrixx by Evernorth",
    url: "https://www.mymatrixx.com/first-fill-information-wc_trust",
    quote: '"BIN: 003858 / PCN: WC / Rx Group Number: ESR3050", on a first-fill page that asks for the injured worker\'s date of injury.',
    checkedOn: ON,
  },
  {
    bin: "610014",
    pcn: "",
    lineOfBusiness: "commercial",
    name: "Legacy Medco commercial",
    publisher: "Express Scripts, commercial combined D.0 payer sheet",
    url: ESI_COMM,
    quote: '"Legacy Medco Commercial — 61ØØ14 — Provided on card or anything but zeros". Every 610014 PCN in the CMS Part D file is a MEDD-style value, and these claims carry none.',
    caveat: "Express Scripts expects a non-zero PCN on this BIN, so 59 claims arriving with the PCN blank may mean the import is not storing it rather than that the claims carried none. Worth checking against a remit before relying on it.",
    checkedOn: ON,
  },
  {
    bin: "610014",
    pcn: "MEDDPRIME",
    lineOfBusiness: "part_d",
    name: "Medco / Express Scripts Medicare Part D",
    publisher: "CMS, Part D contract/plan BIN-PCN file (CY2026)",
    url: CMS_BIN_PCN,
    quote: "123 Part D contracts route on this pair — 116 MA-PD and 7 standalone PDP.",
    checkedOn: ON,
  },
  {
    bin: "017010",
    pcn: "0215COMM",
    lineOfBusiness: "commercial",
    name: "Cigna commercial",
    publisher: "Express Scripts, Cigna commercial network notice",
    url: "https://www.express-scripts.com/art/prc/CignaCommercialPharmacyNetworkUpgradeReminder.pdf",
    quote: '"Cigna Commercial Pharmacy Plans continue moving to Express Scripts… This applies to plans with BIN 017010 and PCNs 0215COMM and 0518GWH." Cigna\'s own member ID card guide shows "RxBIN 017010 RxPCN 0215COMM" on HMO and PPO cards.',
    checkedOn: ON,
  },
  {
    bin: "017010",
    pcn: "0518GWH",
    lineOfBusiness: "commercial",
    name: "Cigna Great-West commercial",
    publisher: "Express Scripts, Cigna commercial network notice",
    url: "https://www.express-scripts.com/art/prc/CignaCommercialPharmacyNetworkUpgradeReminder.pdf",
    quote: '"…BIN 017010 and PCNs 0215COMM and 0518GWH." Cigna\'s ID card guide shows GWH cards reading "RxBIN 017010 RxPCN 0518GWH".',
    checkedOn: ON,
  },
  {
    bin: "017010",
    pcn: "CIMCARE",
    lineOfBusiness: "part_d",
    name: "Cigna Healthspring Medicare Part D",
    publisher: "CMS, Part D contract/plan BIN-PCN file (CY2026)",
    url: CMS_BIN_PCN,
    quote: "16 Part D contracts on this pair, and CIMCARE is the only Part D PCN on BIN 017010.",
    checkedOn: ON,
  },
  {
    bin: "025706",
    pcn: "IFX",
    lineOfBusiness: "commercial",
    name: "Infinity Rx",
    publisher: "PioneerRx plan file, corroborated against the Express Scripts commercial sheet",
    url: ESI_COMM,
    quote: "PioneerRx's plan file names BIN 025706 \"Infinity Rx\", processor Express Scripts. No Part D contract routes on it in the CMS file.",
    caveat: "The weakest row here: Infinity Rx publishes no payer sheet this could be read from, so the line of business is inferred from the absence of any Medicare or Medicaid routing rather than stated. One claim, $239.23.",
    checkedOn: ON,
  },

  // ── OptumRx ──
  {
    bin: "610279",
    pcn: "9999",
    lineOfBusiness: "commercial",
    name: "UnitedHealthcare Employer & Individual",
    publisher: "OptumRx, D.0 payer sheet for BIN 610279 (effective 01/01/2026)",
    url: "https://business.optum.com/content/dam/noindex-resources/business/support-documents/payer-sheets/d-0-payer-sheet-uhc-bin-610279-010126.pdf",
    quote: '"This Payer Sheet applies to BIN 610279 Only … United Healthcare Employer and Individual — BIN: 610279 PCN: 9999". The word "Medicare" does not appear in the document, and the BIN is absent from the CMS Part D file.',
    checkedOn: ON,
  },
  {
    bin: "610097",
    pcn: "9999",
    lineOfBusiness: "ma_pd",
    name: "UnitedHealthcare / AARP Medicare",
    publisher: "CMS, Part D contract/plan BIN-PCN file (CY2026)",
    url: CMS_BIN_PCN,
    quote: "71 Part D contracts route on this pair: 60 local MA-PD, 7 regional MA-PD, 3 standalone PDP and one employer plan. PioneerRx's plan file names it \"Aarp Medicare Pdp\".",
    caveat: "Predominantly Medicare Advantage but not exclusively — three standalone PDP contracts also use it. Out of the Kansas floor's reach either way.",
    checkedOn: ON,
  },
  {
    bin: "610494",
    pcn: "9999",
    lineOfBusiness: "medicaid",
    name: "UnitedHealthcare Community Plan of Kansas — KanCare (Kansas Medicaid)",
    publisher: "Kansas Department of Health and Environment, with the OptumRx commercial and Medicaid payer sheet",
    url: KDHE,
    quote: 'KDHE: "United Healthcare Community Plan of Kansas (Optum Rx - PBM) … RXBIN 610494 / PCN 9999 / RXGROUP ACUKS". Optum\'s sheet is titled "COMMERCIAL AND MEDICAID" and reads "Commercial, Medicaid and MA Only — BIN: 610494 PCN: 9999" — no standalone Part D, and the BIN is absent from the CMS Part D file.',
    caveat: "A shared Optum routing: the RxGroup, not the PCN, is what proves it is KanCare. Confirm these 22 claims carry ACUKS before treating them as Medicaid.",
    checkedOn: ON,
  },
  {
    bin: "610011",
    pcn: "IRX",
    lineOfBusiness: "commercial",
    name: "OptumRx employer group (PioneerRx names this one CWA)",
    publisher: "OptumRx, with the CMS Part D BIN-PCN file as the negative check",
    url: OPTUM_COMM_MCAID,
    quote: "In the CMS Part D file BIN 610011 appears only with PCNs CORMCARE, CTRXMEDD and CTRXPDP — never IRX. Blue KC's member ID card guide shows the sibling routing as employer-group commercial: \"RXBIN: 021825 PCN: IRX GRP: BLUEKC … PLAN: PPO\".",
    caveat: "IRX is a shared Optum PCN and the group code is the real discriminator; there are eleven group numbers on these 93 claims. Established as not-Medicare rather than as one commercial plan.",
    checkedOn: ON,
  },
  {
    bin: "021825",
    pcn: "IRX",
    lineOfBusiness: "commercial",
    name: "Blue Cross Blue Shield Kansas City employer group",
    publisher: "Blue KC, member ID card guide",
    url: "https://www.bluekc.com/blueprint/wp-content/uploads/sites/3/2025/04/Member-ID-Card.pdf",
    quote: '"RXBIN: 021825 PCN: IRX GRP: BLUEKC … PLAN: PPO". BIN 021825 does not appear in the CMS Part D file at all.',
    checkedOn: ON,
  },
  {
    bin: "610548",
    pcn: "SERVU",
    lineOfBusiness: "commercial",
    name: "Serve You Rx",
    publisher: "Serve You Rx, BIN payer sheet",
    url: "https://serveyourx.com/wp-content/uploads/2023/09/Serve-You-Rx-Bin-Payer-Sheet.pdf",
    quote: '"Plan Name/Group Name: All Serve You Rx Commercial Clients — BIN: 610548 PCN: SERVU — Processor: OptumRx".',
    checkedOn: ON,
  },

  // ── Humana ──
  {
    bin: "015581",
    pcn: "03200000",
    lineOfBusiness: "part_d",
    name: "Humana Part D (MA-PD and PDP)",
    publisher: "Humana, D.0 Medicare pharmacy payer sheet (19 November 2025)",
    url: "https://assets.humana.com/is/content/humana/D.0%20Pharmacy%20Medicare%20payer%20sheetpdf",
    quote: '"Plan Name/Group Name: Humana Part D plans (MAPD and PDP), Humana Dual Fully Integrated (HMO D-SNP)… BIN: 015581 PCN: 03200000". CMS lists 42 contracts on the pair.',
    checkedOn: ON,
  },

  // ── Prime Therapeutics / the HCSC Blues ──
  {
    bin: "011552",
    pcn: "ILDR",
    lineOfBusiness: "commercial",
    name: "Blue Cross Blue Shield of Illinois",
    publisher: "Prime Therapeutics, commercial D.0 payer sheet",
    url: PRIME_COMM,
    quote: 'The BIN Ø11552 block: "BCBS of Illinois ILDR / BCBS of Oklahoma (Drug Card) 1215 / BCBS of Texas BCTX / HCSC Collective Health HCCH". None of the four appears among BIN 011552\'s Part D PCNs in the CMS file.',
    checkedOn: ON,
  },
  {
    bin: "011552",
    pcn: "HCCH",
    lineOfBusiness: "commercial",
    name: "HCSC Collective Health",
    publisher: "Prime Therapeutics, commercial D.0 payer sheet",
    url: PRIME_COMM,
    quote: '"BCBS of Illinois ILDR / BCBS of Oklahoma (Drug Card) 1215 / BCBS of Texas BCTX / HCSC Collective Health HCCH", under the heading "For Prime Therapeutics Commercial Clients".',
    checkedOn: ON,
  },
  {
    bin: "011552",
    pcn: "BCTX",
    lineOfBusiness: "commercial",
    name: "Blue Cross Blue Shield of Texas",
    publisher: "Prime Therapeutics, commercial D.0 payer sheet",
    url: PRIME_COMM,
    quote: '"BCBS of Texas BCTX", under "Payer Specification Sheet For Prime Therapeutics Commercial Clients".',
    checkedOn: ON,
  },
  {
    bin: "011552",
    pcn: "1215",
    lineOfBusiness: "commercial",
    name: "Blue Cross Blue Shield of Oklahoma drug card",
    publisher: "Prime Therapeutics, commercial D.0 payer sheet",
    url: PRIME_COMM,
    quote: '"BCBS of Oklahoma (Drug Card) 1215", under "Payer Specification Sheet For Prime Therapeutics Commercial Clients".',
    checkedOn: ON,
  },

  // ── The federal programme that looks like a coupon and is not ──
  {
    bin: "028918",
    pcn: "MEDDGLP1BR",
    lineOfBusiness: "medicare_other",
    name: "Medicare GLP-1 Bridge (CMS, administered by Humana)",
    publisher: "CMS, Medicare GLP-1 Bridge — Information for Pharmacies",
    url: "https://www.cms.gov/medicare/coverage/prescription-drug-coverage/medicare-glp-1-bridge/information-pharmacies",
    quote: '"CMS has established a Bank Identification Number (BIN) and Processor Control Number (PCN) that is specific to the Medicare GLP-1 Bridge (028918 MEDDGLP1BR)" … "eligible GLP-1 drugs furnished under the Medicare GLP-1 Bridge are provided outside of the Part D benefit payment flow and coverage" … "$50 copay".',
    caveat: 'A federal Medicare programme run outside the Part D benefit, using Humana as central processor. Not a manufacturer bridge card, and PioneerRx\'s "Part D" is close but not right. Federally governed either way, so the Kansas floor does not reach it — and at $752 a claim across 11 claims it is worth knowing exactly what it is.',
    checkedOn: ON,
  },

  // ── Cards: the two kinds, which behave in opposite directions ──
  {
    bin: "019158",
    pcn: "CNRX",
    lineOfBusiness: "copay_card",
    name: "SS&C Health manufacturer copay / savings cards (formerly DST, Argus)",
    publisher: "Manufacturer copay card documents naming the routing; NovoCare pharmacist instructions",
    url: "https://www.novocare.com/eligibility/diabetes-savings-card.html",
    quote: 'A Twirla patient savings card prints "Powered by: SS&C / BIN# 019158 / PCN# CNRX / GRP# AC11923002 … Offer not valid for patients enrolled in Medicare, Medicaid". NovoCare instructs pharmacies to "submit the remaining out-of-pocket balance to SS&C Health as the secondary payer … with an other coverage code 08".',
    caveat: "The largest single item on the unclassified list at $35,476 across 28 claims, and it is not a payer at all — it pays down what a plan left the patient owing on a brand drug. Ranked as a payer it would look like the best in the pharmacy; the brand plan underneath it is the one paying badly.",
    checkedOn: ON,
  },
  {
    bin: "610524",
    pcn: "LOYALTY",
    lineOfBusiness: "copay_card",
    name: "McKesson LoyaltyScript manufacturer copay programme",
    publisher: "Manufacturer copay cards naming the routing (Mission Pharmacal Uribel)",
    url: "https://missionpharmacal.com/wp-content/uploads/2020/10/uribel-coupon_0.pdf",
    quote: '"RxBin: 610524 RxPCN: Loyalty … Submit this claim information to McKesson Corporation … as secondary coverage … subject to the LoyaltyScript® program."',
    checkedOn: ON,
  },
  {
    bin: "610524",
    pcn: "1016",
    lineOfBusiness: "copay_card",
    name: "McKesson LoyaltyScript manufacturer copay programme (GSK)",
    publisher: "GSK Trelegy savings card",
    url: "https://gskpro.com/content/dam/global/hcpportal/en_US/img/trelegy/coupon.generate.pdf",
    quote: '"BIN#: 610524 GRP#: 5077-7866 PCN#: 1016 … This offer is not health insurance" — administered by McKesson on GSK\'s behalf, and excluding Medicare and Medicaid.',
    checkedOn: ON,
  },
  {
    bin: "637765",
    pcn: "CRX",
    lineOfBusiness: "copay_card",
    name: "MedOne coupon / voucher programme",
    publisher: "MedOne, coupon/voucher payer sheet",
    url: "https://medone-rx.com/uploads/pr-resources/MEDONE_PAYER_COUPON_RXL_2025V1.pdf",
    quote: '"MEDONE PAYER SHEET — COUPON/VOUCHER PROGRAM"; revision history "Effective 03/01/2024 … Addition- BIN 637765". The BIN is on neither MedOne\'s commercial nor its discount sheet.',
    checkedOn: ON,
  },
  {
    bin: "006053",
    pcn: "MSC",
    lineOfBusiness: "discount_card",
    name: "ScriptSave WellRx (Medical Security Card Company)",
    publisher: "ScriptSave, savings card",
    url: "https://www.scriptsave.com/",
    quote: '"DISCOUNT ONLY - NOT INSURANCE — Administered by Medical Security Card Company, LLC, Tucson, AZ — RxBIN: 006053 RxPCN: MSC … Cannot be used in conjunction with insurance."',
    checkedOn: ON,
  },
  {
    bin: "019876",
    pcn: "CHIPPO",
    lineOfBusiness: "discount_card",
    name: "Hippo savings card",
    publisher: "Hippo",
    url: "https://hellohippo.com/card",
    quote: '"BIN: 019876, PCN: CHIPPO, Group: PRTPD" with "THIS CARD IS NOT INSURANCE. IT CANNOT BE USED IN CONJUNCTION WITH ANY FEDERAL OR STATE FUNDED PROGRAM, SUCH AS MEDICARE OR MEDICAID."',
    checkedOn: ON,
  },
  {
    bin: "015995",
    pcn: "",
    lineOfBusiness: "discount_card",
    name: "GoodRx",
    publisher: "GoodRx savings card; NCPA",
    url: "https://www.ncpa.co/pdf/2026/advocacy/trumprx-one-pager.pdf",
    quote: 'GoodRx\'s printable savings card: "BIN 015995 / PCN GDC … GoodRx is NOT insurance". NCPA: "GoodRx administers, via PDMI, the coupons on TrumpRx … BIN: 015995, PCN: GDC, Group: MAHA."',
    caveat: "These two claims carry no PCN and group MAHA, which is the TrumpRx routing. Cash either way — there is no plan to regulate and no payer to owe a floor.",
    checkedOn: ON,
  },

  // ── The rest of the commercial book ──
  {
    bin: "610852",
    pcn: "CHM",
    lineOfBusiness: "commercial",
    name: "Capital Rx",
    publisher: "Capital Rx, commercial payer sheet",
    url: "https://www.judi.health/capital-rx-pharmacists",
    quote: '"Payer Name: Capital Rx / Commercial … Effective 01/01/2024  610852 CHM". CHM is not on Capital Rx\'s Medicare sheet.',
    checkedOn: ON,
  },
  {
    bin: "024921",
    pcn: "TRX",
    lineOfBusiness: "commercial",
    name: "Oread Rx (processed by RxSense)",
    publisher: "RxSense, payer specifications — commercial primary",
    url: "https://pharmacy.rxsense.com/documents/quickresources/RxSense_PayerSheet.pdf",
    quote: '§3.1 BIN/PCN combinations: "Oread Rx | 024921 | TRX | Live as of 4/1/2022", on a sheet scoped to "pharmacy drug claims to RxSense Commercial plans".',
    checkedOn: ON,
  },
  {
    bin: "023575",
    pcn: "9999",
    lineOfBusiness: "commercial",
    name: "ProAct (processed by RxSense)",
    publisher: "RxSense, payer specifications — commercial primary",
    url: "https://pharmacy.rxsense.com/documents/quickresources/RxSense_PayerSheet.pdf",
    quote: '§3.1: "ProAct … 023575 9999 Live as of 7/1/2021", on the commercial primary sheet rather than RxSense\'s separate discount sheet.',
    checkedOn: ON,
  },
  {
    bin: "610020",
    pcn: "PDMI",
    lineOfBusiness: "commercial",
    name: "Universal Rx prescription insurance",
    publisher: "Universal Rx, member services",
    url: "https://universalrx.com/member-services/",
    quote: '"BIN: 610020 / Universal Rx Prescription Insurance PCN: PDM or PDMI / Discount Drug Card PCN: URX001". One BIN, and the PCN decides: PDMI is insurance, URX001 is a discount card, ACR is a manufacturer copay.',
    checkedOn: ON,
  },
  {
    bin: "800004",
    pcn: "008126",
    lineOfBusiness: "commercial",
    name: "MedTrak / Elixir employer group",
    publisher: "City of Springfield, Illinois — prescription benefit summary",
    url: "https://ess.springfield.il.us/Documents/HR/Prescription/2016MedTrakPrescription2016SummaryOfBenefits.pdf",
    quote: '"Rx BIN: 800004 / Rx PCN: 008126 / Rx Group#: 10002694", on an employer prescription benefit. Elixir\'s Part D sheet names only BINs 012312, 015185 and 009890, so this is not Part D.',
    caveat: "The only document naming this PCN is a 2016 employer summary. The line of business is not in doubt; the currency of the routing is unconfirmed.",
    checkedOn: ON,
  },
  {
    bin: "024368",
    pcn: "3207",
    lineOfBusiness: "commercial",
    name: "SmithRx",
    publisher: "SmithRx, commercial payer sheet",
    url: "https://smithrx.com/pharmacy-forms/payer-sheet",
    quote: '"SmithRx Commercial Payer Sheet … Plan Name/Group Name: Commercial - All Plans", with 024368 in the BIN/PCN table. SmithRx publishes no Medicare or Medicaid payer sheet.',
    checkedOn: ON,
  },
  {
    bin: "028025",
    pcn: "4002",
    lineOfBusiness: "commercial",
    name: "SmithRx",
    publisher: "SmithRx, commercial payer sheet",
    url: "https://smithrx.com/pharmacy-forms/payer-sheet",
    quote: '"SmithRx Commercial Payer Sheet … Plan Name/Group Name: Commercial - All Plans", with 028025 in the BIN/PCN table.',
    checkedOn: ON,
  },
  {
    bin: "025945",
    pcn: "SSN",
    lineOfBusiness: "commercial",
    name: "Liviniti (formerly Southern Scripts) — self-insured employers",
    publisher: "Liviniti, pharmacy services manual (15 August 2025)",
    url: "https://liviniti.com/wp-content/uploads/2025/08/Liviniti-Pharmacy-Manual-8-15-2025.pdf",
    quote: '"Payer Sheet General Information — Payer Name: Liviniti … BIN: 015433, 025242, 025945, 027159, 027167  PCN: SSN". The manual has no Part D or Medicaid section, and Liviniti\'s employer page describes its clients as self-insured employers.',
    caveat: "\"Self-insured employers\" points at ERISA preemption, which would put these out of the Kansas floor's reach — but a PBM's marketing copy is not a Form 5500 and does not establish it for a particular group.",
    checkedOn: ON,
  },
  {
    bin: "015433",
    pcn: "SSN",
    lineOfBusiness: "commercial",
    name: "Liviniti (formerly Southern Scripts) — self-insured employers",
    publisher: "Liviniti, pharmacy services manual (15 August 2025)",
    url: "https://liviniti.com/wp-content/uploads/2025/08/Liviniti-Pharmacy-Manual-8-15-2025.pdf",
    quote: '"BIN: 015433, 025242, 025945, 027159, 027167  PCN: SSN".',
    checkedOn: ON,
  },
  {
    bin: "025242",
    pcn: "SSN",
    lineOfBusiness: "commercial",
    name: "Liviniti (formerly Southern Scripts) — self-insured employers",
    publisher: "Liviniti, pharmacy services manual (15 August 2025)",
    url: "https://liviniti.com/wp-content/uploads/2025/08/Liviniti-Pharmacy-Manual-8-15-2025.pdf",
    quote: '"BIN: 015433, 025242, 025945, 027159, 027167  PCN: SSN".',
    checkedOn: ON,
  },
  {
    bin: "005377",
    pcn: "10000019",
    lineOfBusiness: "commercial",
    name: "MaxorPlus self-funded public-employer group",
    publisher: "Hometown Health, pharmacy information",
    url: "https://www.hometownhealth.com/wp-content/uploads/2021/12/2022-Pharmacy-Information.pdf",
    quote: '"Self-Funded Groups — Washoe County, City of Sparks, City of Reno… powered by Maxor / Rx BIN: 005377 / Rx PCN: 10000019".',
    caveat:
      'PioneerRx has these claims labelled "City of Wichita", and that label is doubtful: the City of Wichita\'s own 2026 benefits guide says "RxBenefits is the administrative component of the Optum Rx prescription drug plan" — not Maxor. The Wichita public employer actually on MaxorPlus is USD 259, Wichita Public Schools. Which it is matters a great deal: a city or school district plan is a governmental plan, excluded from ERISA by definition, and therefore IN reach of the Kansas floor.',
    checkedOn: ON,
  },
  {
    bin: "610127",
    pcn: "01960000",
    lineOfBusiness: "commercial",
    name: "OptumRx (commercial or Medicaid — the sheet does not separate them)",
    publisher: "OptumRx, commercial and Medicaid D.0 payer sheet",
    url: OPTUM_COMM_MCAID,
    quote: '"OptumRx BIN: 610127 PCN: 02330000 01960000 01990000 02330088 COSF GASF…", on the sheet titled "COMMERCIAL AND MEDICAID". The BIN is absent from Optum\'s Medicare-only sheet and from the CMS Part D file.',
    caveat: "Established as not-Medicare and no further: Optum groups its commercial and Medicaid business on one sheet, and no published document splits this PCN. Only the help desk can.",
    checkedOn: ON,
  },
  {
    bin: "022096",
    pcn: "",
    lineOfBusiness: "commercial",
    name: "Cerpass Rx",
    publisher: "PioneerRx plan file",
    url: "https://www.cerpassrx.com/",
    quote: "PioneerRx's plan file names BIN 022096 \"Cerpass Rx\". No Part D contract routes on it in the CMS file.",
    caveat: "Named rather than sourced from a payer sheet — Cerpass publishes none this could be read from. One claim, $3.44.",
    checkedOn: ON,
  },
];

const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/**
 * The published entry for a BIN and PCN, where there is one.
 *
 * The exact pair first. A blank-PCN entry stands for the whole BIN — that is how GoodRx and Legacy
 * Medco are recorded — but only where nothing more specific exists, so a general entry can never
 * overrule a document that named the PCN.
 */
export function payerSheetFor(bin: string | null, pcn: string | null): PayerSheetEntry | null {
  const b = norm(bin);
  if (!b) return null;
  const p = norm(pcn);
  const mine = PAYER_SHEETS.filter((s) => norm(s.bin) === b);
  return mine.find((s) => norm(s.pcn) === p) ?? mine.find((s) => norm(s.pcn) === "") ?? null;
}
