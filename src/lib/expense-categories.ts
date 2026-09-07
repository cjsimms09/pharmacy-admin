/**
 * A pharmacy's costs, in the order they matter.
 *
 * Seeded rather than left blank, because an empty chart of accounts gets filled in badly: bills go
 * into "other" for three months and the account that comes out cannot answer the only question
 * worth asking, which is where the money went. These are the lines an independent pharmacy actually
 * has, and the ones an accountant will expect to see.
 *
 * The kind matters more than the name. It decides where a figure lands, and putting a cost on the
 * wrong side of gross profit moves money between two totals without changing either — which reads
 * like a rounding difference and is not.
 *
 *   cost_of_goods   what the drugs cost, and anything that changes that
 *   revenue_offset  money taken back out of revenue after the fact: DIR fees, price concessions
 *   operating       everything it costs to keep the doors open
 */

export type SeedCategory = { name: string; kind: "operating" | "cost_of_goods" | "revenue_offset" | "balance_sheet"; sortOrder: number; notes: string };

export const SEED_CATEGORIES: SeedCategory[] = [
  // ── What the goods cost ──────────────────────────────────────────────────────
  {
    name: "Drug purchases",
    kind: "cost_of_goods",
    sortOrder: 10,
    notes:
      "Wholesaler invoices — McKesson, IPD, IPC, Parmed. These come in as supplier invoices already and are counted from those, so a bill filed here as well would count the same money twice.",
  },
  {
    name: "Returns and credits",
    kind: "cost_of_goods",
    sortOrder: 20,
    notes: "Credit for stock returned to the wholesaler. Entered negative: it reduces what the goods cost.",
  },
  {
    name: "Wholesaler rebates",
    kind: "cost_of_goods",
    sortOrder: 30,
    notes:
      "The compliance and purchase-ratio rebates, entered negative. They are not revenue — they are a reduction in what the generics cost, and putting them in revenue overstates both sales and cost of goods.",
  },

  // ── Money taken back out of revenue ──────────────────────────────────────────
  {
    name: "DIR fees and price concessions",
    kind: "revenue_offset",
    sortOrder: 40,
    notes:
      "Clawed back by a plan after the claim was paid. Not an operating cost: it is revenue the pharmacy was told it had and then did not. Kept apart so the dispensing margin is not quietly flattered by it. If the plan took it out of a remittance, leave the paid date blank: the cash account already sees it in the smaller deposit, and a paid date would count it twice there.",
  },
  {
    name: "Chargebacks and audit recoveries",
    kind: "revenue_offset",
    sortOrder: 45,
    notes: "Money recovered by a payer after an audit. Same reasoning as DIR: it comes out of revenue, not out of overheads.",
  },

  // ── Keeping the doors open ───────────────────────────────────────────────────
  {
    name: "Wages and salaries",
    kind: "operating",
    sortOrder: 100,
    notes:
      "Almost always the largest line in a pharmacy — commonly more than half of gross profit. A profit and loss account without it is not wrong by a little, it is fiction.",
  },
  { name: "Payroll taxes and benefits", kind: "operating", sortOrder: 110, notes: "Employer taxes, insurance contributions, retirement." },
  { name: "Rent and occupancy", kind: "operating", sortOrder: 120, notes: "Rent, common charges, property taxes if the pharmacy pays them." },
  { name: "Utilities", kind: "operating", sortOrder: 130, notes: "Power, water, waste. The fridge runs whatever the month does." },
  { name: "Telephone and internet", kind: "operating", sortOrder: 140, notes: "Lines, fax, broadband." },
  {
    name: "Software and systems",
    kind: "operating",
    sortOrder: 150,
    notes: "PioneerRx, e-prescribing, claims switching, temperature monitoring, backup. Mostly monthly, so a month one does not arrive is worth noticing.",
  },
  { name: "Postage and shipping", kind: "operating", sortOrder: 160, notes: "Stamps.com, couriers, packaging for mailed prescriptions." },
  { name: "Delivery", kind: "operating", sortOrder: 170, notes: "Drivers, mileage, vehicle costs for the delivery round." },
  { name: "Pharmacy supplies", kind: "operating", sortOrder: 180, notes: "Vials, caps, labels, bags, unit-dose packaging, refrigerant." },
  { name: "Office and store supplies", kind: "operating", sortOrder: 190, notes: "Paper, printing, cleaning, front-of-shop consumables." },
  {
    name: "Card processing and bank fees",
    kind: "operating",
    sortOrder: 200,
    notes:
      "Two to three per cent of everything taken on a card, which on a pharmacy's turnover is a serious line and one that is routinely forgotten because nobody sends an invoice for it.",
  },
  { name: "Insurance", kind: "operating", sortOrder: 210, notes: "Professional liability, property, business interruption, cyber." },
  { name: "Professional fees", kind: "operating", sortOrder: 220, notes: "Accountant, lawyer, consultants." },
  {
    name: "Licences and registrations",
    kind: "operating",
    sortOrder: 230,
    notes: "DEA, state board, NPI, controlled substance registration. Annual, and already tracked on the compliance calendar.",
  },
  { name: "Accreditation and compliance", kind: "operating", sortOrder: 240, notes: "Accreditation bodies, required training, credentialing." },
  { name: "Marketing and advertising", kind: "operating", sortOrder: 250, notes: "Signage, print, digital, sponsorship." },
  { name: "Repairs and maintenance", kind: "operating", sortOrder: 260, notes: "Fridges, robots, counters, the building." },
  { name: "Continuing education", kind: "operating", sortOrder: 270, notes: "CE for the pharmacists; technician CE is not the pharmacy's to pay." },
  { name: "Equipment and depreciation", kind: "operating", sortOrder: 280, notes: "Capital items written down over their life. Enter each month's depreciation with no paid date: no cash leaves, so the cash account must not see it. The purchase itself goes under Equipment and improvements bought." },
  { name: "Bad debt", kind: "operating", sortOrder: 290, notes: "Patient accounts written off." },
  { name: "Interest and finance charges", kind: "operating", sortOrder: 300, notes: "The interest on loans and lines of credit, and late fees. The principal is not a cost: it goes under Loan principal." },

  // ── Money that leaves the bank and is not a cost ─────────────────────────────
  {
    name: "Loan principal",
    kind: "balance_sheet",
    sortOrder: 400,
    notes: "The part of a loan payment that repays what was borrowed. It leaves the bank and it is not a cost — the cost was whatever the loan bought, and the interest. On the cash account it is below the line; on the accrual account it does not appear.",
  },
  {
    name: "Owner draws and distributions",
    kind: "balance_sheet",
    sortOrder: 410,
    notes: "Money taken out by the owner. Not a cost of running the pharmacy; it is what the profit was for. Cash account only, below the line.",
  },
  {
    name: "Equipment and improvements bought",
    kind: "balance_sheet",
    sortOrder: 420,
    notes: "A fridge, a robot, a counter, paid for in the month. The cash leaves now; the cost is spread over the years it serves as depreciation, under Equipment and depreciation. Cash account only.",
  },
  {
    name: "Income tax payments",
    kind: "balance_sheet",
    sortOrder: 430,
    notes: "Estimated and final income tax paid. The pharmacy's profit is before tax, so this is below the line on the cash account and absent from the accrual one.",
  },
  { name: "Other", kind: "operating", sortOrder: 900, notes: "Where a bill goes while somebody decides. A month with much in here is a chart of accounts that needs a line adding." },
];
