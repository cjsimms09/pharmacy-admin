import "server-only";
import { parseCsvRows } from "./reference";
import { readSheet } from "./xlsx";
import { classify, type RouteKind } from "./autoroute";
import { mapColumns } from "./claims";
import { mapSupplierColumns } from "./suppliers";

/**
 * Checking a report against what the site actually needs.
 *
 * A written specification tells you a column is missing. It cannot tell you a column is present
 * and empty, which is the failure that actually happened here: PioneerRx sends Dispensed
 * Quantity and Acquisition Cost on every export and populates neither, and no amount of re-reading
 * the spec would have caught it.
 *
 * So this reads a real file and reports three states per field, not two — absent, present but
 * unpopulated, and populated — with the fill rate measured over the rows that are actually there.
 * The output is meant to be handed straight back to whoever builds the report.
 */

export type FieldNeed = {
  /** What we call it. */
  name: string;
  /** The NCPDP field number, where one exists — the least ambiguous way to ask for it. */
  ncpdp?: string;
  /** Why we need it, in terms of what breaks without it. */
  blocks: string;
  /** Whether the site can do anything at all without it. */
  critical: boolean;
};

export type FieldResult = FieldNeed & {
  column: string | null;
  present: boolean;
  filled: number;
  rows: number;
  fillRate: number;
  state: "populated" | "empty" | "absent" | "partial";
};

export type ReportCheck = {
  kind: RouteKind;
  why: string;
  rows: number;
  headers: string[];
  results: FieldResult[];
  extraColumns: string[];
  /** A paragraph to send back to the report writer, listing only what is wrong. */
  askBack: string;
};

/** What a claims export has to carry, and what each field is load-bearing for. */
export const CLAIM_NEEDS: (FieldNeed & { field: string })[] = [
  { field: "rxNumber", name: "Rx number", blocks: "Nothing can be identified or joined to a payment.", critical: true },
  { field: "fillNumber", name: "Fill / refill number", ncpdp: "403-D3", blocks: "One fill cannot be told from another on the same prescription.", critical: false },
  { field: "dateFilled", name: "Date filled", ncpdp: "401-D1", blocks: "The NADAC in force cannot be chosen, and scope by date cannot be judged.", critical: true },
  { field: "ndc11", name: "Dispensed NDC", ncpdp: "407-D7", blocks: "No benchmark price can be looked up.", critical: true },
  { field: "quantity", name: "Quantity dispensed", ncpdp: "442-E7", blocks: "Nothing can be priced at all — every formula multiplies by it.", critical: true },
  { field: "quantityUnit", name: "Quantity unit of measure", ncpdp: "600-28", blocks: "NADAC prices per unit; comparing across units is wrong by orders of magnitude.", critical: true },
  { field: "daysSupply", name: "Days supply", ncpdp: "405-D5", blocks: "The rate band inside a network cannot be chosen — a 30-day rate is not a 90-day rate.", critical: true },
  { field: "bin", name: "BIN", ncpdp: "101-A1", blocks: "The payer cannot be identified.", critical: true },
  { field: "pcn", name: "PCN", ncpdp: "104-A4", blocks: "BINs shared by several PBMs cannot be resolved.", critical: true },
  { field: "groupNumber", name: "Group number", ncpdp: "301-C1", blocks: "Plan funding type cannot be established, so nothing is filable.", critical: true },
  { field: "networkId", name: "Network reimbursement ID", ncpdp: "545-2F", blocks: "The rate schedule that priced the claim cannot be identified.", critical: true },
  { field: "planId", name: "Plan ID", ncpdp: "524-FO", blocks: "A second way to resolve the plan is lost.", critical: false },
  { field: "planType", name: "Plan type", blocks: "Medicare and commercial cannot be separated at a glance.", critical: false },
  { field: "pharmacyServiceType", name: "Pharmacy service type", ncpdp: "147-U7", blocks: "Retail, mail and long-term-care schedules cannot be told apart.", critical: false },
  { field: "basisOfReimbursement", name: "Basis of reimbursement", ncpdp: "522-FM", blocks: "Which pricing leg the PBM used is unknown, so an appeal cannot be aimed.", critical: true },
  { field: "basisOfCostDetermination", name: "Basis of cost determination", ncpdp: "423-DN", blocks: "How our submitted cost was derived is unknown.", critical: false },
  { field: "remit", name: "Amount paid", ncpdp: "509-F9", blocks: "There is no figure to compare against anything.", critical: true },
  { field: "copay", name: "Patient pay amount", ncpdp: "505-F5", blocks: "Total received is understated, so shortfalls read larger than they are.", critical: true },
  { field: "ingredientPaid", name: "Ingredient cost paid", ncpdp: "506-F6", blocks: "A short payment cannot be attributed to the ingredient or the fee — two different appeals.", critical: true },
  { field: "dispensingFeePaid", name: "Dispensing fee paid", ncpdp: "507-F7", blocks: "The other half of the split. A contract paying MAC plus a fee cannot be checked against one combined number.", critical: true },
  { field: "acquisition", name: "Acquisition cost", blocks: "Margin per claim, below-cost detection and every purchasing comparison.", critical: true },
  { field: "awp", name: "AWP at time of fill", blocks: "Contracts priced as AWP minus a discount cannot be checked.", critical: false },
  { field: "grossProfit", name: "Gross profit", blocks: "The only way to derive acquisition cost while that column is empty.", critical: false },
  { field: "daw", name: "DAW", ncpdp: "408-D8", blocks: "Brand-over-generic dispensing cannot be explained.", critical: false },
];

export const SUPPLIER_NEEDS: (FieldNeed & { field: string })[] = [
  { field: "ndc", name: "NDC", blocks: "Nothing can be matched to what we dispense.", critical: true },
  { field: "description", name: "Item description", blocks: "Equivalent products cannot be grouped, so no comparison is possible.", critical: true },
  { field: "packCost", name: "Pack or net cost", blocks: "There is no price to compare.", critical: true },
  { field: "units", name: "Units per pack", blocks: "A pack cost cannot be turned into a unit cost.", critical: true },
  { field: "unitCost", name: "Unit cost", blocks: "Nothing — this is derived from pack cost and count when absent.", critical: false },
  { field: "manufacturer", name: "Manufacturer", blocks: "Which labeler a price belongs to is unclear.", critical: false },
  { field: "packSize", name: "Pack size", blocks: "Package differences cannot be shown.", critical: false },
  { field: "contractFlag", name: "Contract indicator", blocks: "Whether a line sits on the purchasing agreement is unknown, and buying off it can cost a rebate tier.", critical: false },
  { field: "availability", name: "Availability", blocks: "A cheaper source that cannot supply is still recommended.", critical: false },
];

function readRows(fileName: string, buf: Buffer): string[][] {
  if (/\.(csv|txt)$/i.test(fileName)) return parseCsvRows(buf.toString("utf8"));
  return readSheet(buf);
}

/**
 * Reads a report and says what it can and cannot support.
 *
 * Fill rate is measured over the data rows present. A column that is entirely empty is called
 * out separately from one that is missing, because they need different things said to the person
 * who builds the report: one is "add this", the other is "this comes through blank".
 */
export function checkReport(fileName: string, buf: Buffer): ReportCheck {
  const cls = classify(fileName, buf);
  const rows = readRows(fileName, buf).filter((r) => r.some((c) => c.trim() !== ""));
  const [head, ...body] = rows;
  const headers = (head ?? []).map((h) => h.trim());

  const needs = cls.kind === "supplier_catalog" ? SUPPLIER_NEEDS : CLAIM_NEEDS;
  const map = cls.kind === "supplier_catalog" ? mapSupplierColumns(headers).map : mapColumns(headers).map;
  const mapped = map as Record<string, string | undefined>;

  const indexOf = new Map(headers.map((h, i) => [h, i]));
  const results: FieldResult[] = needs.map((n) => {
    const column = mapped[n.field] ?? null;
    if (!column) {
      return { ...n, column: null, present: false, filled: 0, rows: body.length, fillRate: 0, state: "absent" as const };
    }
    const i = indexOf.get(column) ?? -1;
    const filled = i < 0 ? 0 : body.filter((r) => (r[i] ?? "").trim() !== "").length;
    const fillRate = body.length === 0 ? 0 : filled / body.length;
    const state = filled === 0 ? "empty" : fillRate >= 0.99 ? "populated" : "partial";
    return { ...n, column, present: true, filled, rows: body.length, fillRate, state };
  });

  const used = new Set(Object.values(mapped).filter(Boolean) as string[]);
  const extraColumns = headers.filter((h) => !used.has(h));

  return { kind: cls.kind, why: cls.why, rows: body.length, headers, results, extraColumns, askBack: buildAsk(results) };
}

/** The paragraph to send back, naming only what is actually wrong. */
function buildAsk(results: FieldResult[]): string {
  const empty = results.filter((r) => r.state === "empty");
  const partial = results.filter((r) => r.state === "partial" && r.critical);
  const absentCritical = results.filter((r) => r.state === "absent" && r.critical);
  const absentOther = results.filter((r) => r.state === "absent" && !r.critical);

  const label = (r: FieldResult) => (r.ncpdp ? `${r.name} (NCPDP ${r.ncpdp})` : r.name);
  const parts: string[] = [];

  if (empty.length) {
    parts.push(
      `These columns are on the report but come through blank on every row — the data is on the ` +
        `prescription record, so this looks like a report configuration issue rather than missing data: ` +
        `${empty.map((r) => r.column).join(", ")}.`,
    );
  }
  if (partial.length) {
    parts.push(
      `These are populated on only some rows: ` +
        `${partial.map((r) => `${r.column} (${Math.round(r.fillRate * 100)}%)`).join(", ")}.`,
    );
  }
  if (absentCritical.length) {
    parts.push(`Please add these columns — without them the report cannot be used: ${absentCritical.map(label).join(", ")}.`);
  }
  if (absentOther.length) {
    parts.push(`These would also help but are not blocking: ${absentOther.map(label).join(", ")}.`);
  }
  if (parts.length === 0) return "Everything needed is present and populated. Nothing further required.";
  return parts.join("\n\n");
}
