import "server-only";
import { parseCsvRows } from "./reference";
import { readSheet } from "./xlsx";
import { mapColumns } from "./claims";
import { mapSupplierColumns } from "./suppliers";
import { looksLikePioneerCatalog } from "./pioneer-catalog";
import { looksLikeRxTransactions } from "./rx-transactions";
import { pdfText } from "./pdf-text";
import { looksLikeRebateReport } from "./rebate-report";
import { ALLOWED_MIME } from "./files";

/**
 * Working out what an emailed report actually is, and loading it.
 *
 * The point of this is that a scheduled report should arrive and be usable without anyone
 * touching it. The risk is the mirror image: a file loaded as the wrong kind of thing writes
 * wrong data into the tables everything else reads, and does it unattended, overnight, with
 * nobody watching.
 *
 * So recognition is done by reading the file's own header row rather than trusting its name.
 * A supplier can call a file anything; only the columns say what it holds. And every rule below
 * requires positive evidence — a file that merely lacks the markers of one kind is never assumed
 * to be another. Anything unrecognised is filed as a document exactly as before, which is the
 * behaviour we already had and is never wrong, only unhelpful.
 */

export type RouteKind = "claims" | "rx_transactions" | "supplier_catalog" | "pioneer_catalog" | "rebate_report" | "purchase_drilldown" | "return_policy" | "nadac" | "unrecognised";

export type Classification = {
  kind: RouteKind;
  /** What in the file led here, so a wrong guess can be diagnosed from the inbox. */
  why: string;
  /** Headers found, for the same reason. */
  headers: string[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether a PDF is McKesson's daily Purchase Drill Down, before anything is spent reading it.
 *
 * The extracted text comes back with its columns interleaved and its words split across fragments,
 * so only the most robust markers are worth testing. These two labels appear on no other report
 * the pharmacy receives.
 */
export function looksLikeDrillDown(text: string, fileName = ""): boolean {
  if (/purchase[_\s-]*drill[_\s-]*down/i.test(fileName)) return true;
  return /GCR/.test(text) && /OS\/Rx/.test(text);
}

/** Reads just the header row, whatever the format. Returns [] for anything unreadable. */
export function headersOf(fileName: string, buf: Buffer): string[] {
  try {
    if (/\.(csv|txt)$/i.test(fileName)) {
      // Read the header row itself rather than going through the object parser: a report whose
      // period happened to be empty still has to be recognised, and the object parser has no
      // rows to take keys from.
      const rows = parseCsvRows(buf.toString("utf8"));
      const head = rows.find((r) => r.some((c) => c.trim() !== ""));
      return head ? head.map((h) => h.trim()).filter(Boolean) : [];
    }
    if (/\.xlsx$/i.test(fileName)) {
      const rows = readSheet(buf);
      const head = rows.find((r) => r.some((c) => c.trim() !== ""));
      return head ? head.map((h) => h.trim()).filter(Boolean) : [];
    }
  } catch {
    // A file we cannot parse is simply not one we can route.
  }
  return [];
}

/**
 * Decides what a file is from its columns.
 *
 * Order matters. NADAC is checked first because its marker column is unambiguous. Claims are
 * checked before supplier catalogues because a claims export also carries an NDC and a cost, and
 * would otherwise match the looser catalogue rule.
 */
export function classify(fileName: string, buf: Buffer): Classification {
  /*
   * A PDF, which is the one shape here that is not text at all.
   *
   * McKesson's monthly rebate breakdown is the document that carries the tier ladder and the rate
   * actually earned. It arrives as a generated PDF, so its words have to be pulled out before
   * anything can be told about it — and it is worth the trouble, because the alternative is
   * somebody typing eleven bands of a contract into a form and one of them being wrong.
   */
  if (/^%PDF/.test(buf.subarray(0, 8).toString("latin1"))) {
    /*
     * A returned goods policy, known by its name rather than its words.
     *
     * The two real ones yield almost nothing to the extractor — twenty-seven characters of
     * fragments out of McKesson's — so there is no content rule to write. The file name is what
     * there is, and it is enough: nothing else a wholesaler sends is called a returns policy.
     */
    if (/return(ed)?[_\s-]*goods|returns?[_\s-]*polic/i.test(fileName)) {
      return { kind: "return_policy", why: "Named as a returned goods policy. Read against the supplier it came from.", headers: [] };
    }
    try {
      const text = pdfText(buf);
      if (looksLikeRebateReport(text)) {
        return {
          kind: "rebate_report",
          why: "A McKesson rebate breakdown: it carries the tier table and the compliance rate the month was paid at.",
          headers: [],
        };
      }
      /*
       * The daily Purchase Drill Down, which carries the ratio every rebate band turns on.
       *
       * Recognised here, read by the model later: the extractor pulls its text out but returns the
       * columns interleaved — eleven percentages in a row with nothing saying which month each
       * belongs to. Enough to know what the document is; not enough to read a figure off it that
       * a purchasing decision will be made on.
       */
      if (looksLikeDrillDown(text, fileName)) {
        return { kind: "purchase_drilldown", why: "McKesson's Purchase Drill Down: it carries the compliance ratio and the OneStop share, month by month.", headers: [] };
      }
    } catch {
      // Not readable as text — a scan. It is filed as a document like anything else.
    }
    if (/purchase[_\s-]*drill[_\s-]*down/i.test(fileName)) {
      return { kind: "purchase_drilldown", why: "Named as a Purchase Drill Down.", headers: [] };
    }
    return { kind: "unrecognised", why: "A PDF this does not recognise. Filed as a document.", headers: [] };
  }
  /*
   * The daily "Rx Transaction Details By Submission Type" report — the claims feed — is, like the
   * catalogue, a printed report whose first line is its title, so it is known by that title.
   */
  if (looksLikeRxTransactions(buf.subarray(0, 8192).toString("utf8"))) {
    return {
      kind: "rx_transactions",
      why: "Begins with PioneerRx's \"Rx Transaction Details By Submission Type\" title; one row per claim transaction.",
      headers: ["Rx Number", "Status", "Amount", "Group", "Ntw Reim. Id", "Copay", "Dispensing Fee", "Completed Date", "Date Filled", "BIN", "QTY", "Acq. Inv. Cost", "PCN", "NDC", "GrossProfit"],
    };
  }
  /*
   * PioneerRx's supplier catalogue export, checked before anything that reads a header row.
   *
   * Its first line is a report title, not a header, so headersOf() would return the title as a
   * one-column header and the file would fall through as unrecognised — which is what happened to
   * the first one. It is also the one report here that names its own supplier, in a section line
   * inside the file, so unlike a generic price list it needs no sender rule to be filed correctly.
   *
   * Recognised by content alone, whatever the name ends in. The scheduled file is named
   * Supplier + run date by the pharmacy and PioneerRx decides the extension, if any; a rule that
   * needed ".txt" would have filed the first Sunday's files as unrecognised for want of four letters.
   */
  if (looksLikePioneerCatalog(buf.subarray(0, 8192).toString("utf8"))) {
    return {
      kind: "pioneer_catalog",
      why: "Begins with PioneerRx's \"Supplier Catalog Item Search Results\" header; the supplier is named inside the file.",
      headers: ["Supplier Item Number", "Name", "NDC", "Order By Constant", "Cost Per Unit"],
    };
  }

  const headers = headersOf(fileName, buf);
  if (headers.length === 0) return { kind: "unrecognised", why: "No header row could be read.", headers };
  const set = new Set(headers.map(norm));
  const has = (...names: string[]) => names.some((n) => set.has(norm(n)));

  if (has("nadac per unit") && has("ndc") && has("effective date")) {
    return { kind: "nadac", why: "Carries a NADAC Per Unit column alongside NDC and Effective Date.", headers };
  }

  // A claims export is identified by the prescription and its routing, not by money — a supplier
  // file has money too, and a claims file without a prescription number is not usable anyway.
  const { map } = mapColumns(headers);
  if (map.rxNumber && map.dateFilled && (map.bin || map.pcn)) {
    return { kind: "claims", why: `Carries ${map.rxNumber}, ${map.dateFilled} and ${map.bin ?? map.pcn}.`, headers };
  }

  const { map: sup } = mapSupplierColumns(headers);
  if (sup.ndc && (sup.unitCost || sup.packCost) && !map.rxNumber) {
    return {
      kind: "supplier_catalog",
      why: `Carries ${sup.ndc} and ${sup.unitCost ?? sup.packCost} with no prescription number.`,
      headers,
    };
  }

  return { kind: "unrecognised", why: `Columns did not match any known report: ${headers.slice(0, 8).join(", ")}.`, headers };
}

/**
 * Which supplier a catalogue came from, per rules the pharmacy writes.
 *
 * Free text, one rule per line, "fragment = Supplier Name" — matched against the sender address
 * and the subject. A catalogue with no matching rule is not loaded: filing prices under the
 * wrong supplier would make the purchasing comparison quietly wrong, and there is no way to
 * infer a supplier from a spreadsheet.
 */
export function parseSupplierRules(raw: string): { pattern: string; supplier: string }[] {
  return (raw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      if (i < 0) return null;
      const pattern = l.slice(0, i).trim().toLowerCase();
      const supplier = l.slice(i + 1).trim();
      return pattern && supplier ? { pattern, supplier } : null;
    })
    .filter((x): x is { pattern: string; supplier: string } => x !== null);
}

export function supplierFor(rules: { pattern: string; supplier: string }[], from: string, subject: string): string | null {
  const hay = `${from} ${subject}`.toLowerCase();
  return rules.find((r) => hay.includes(r.pattern))?.supplier ?? null;
}

/*
 * The attachment types the mailbox reads. Mirrors the list in files.ts plus the text and
 * spreadsheet types reports come as; kept here so the acceptance rule can be tested without a
 * mailbox.
 */
const REPORT_EXT = /\.(pdf|csv|tsv|txt|xls|xlsx|jpg|jpeg|png)$/i;
const REPORT_MIME = new Set([
  ...ALLOWED_MIME,
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);
const TEXT_MIME = new Set(["text/plain", "text/csv", "text/tab-separated-values", "application/octet-stream"]);

/**
 * Whether an attachment is one this reads, and if not, why not — in words for the inbox line.
 *
 * The scheduled catalogue is named Supplier + run date by the pharmacy, and whether PioneerRx
 * puts ".txt" on the end is PioneerRx's business. A rule that needed the extension would have
 * left the first Sunday's files unread, recorded as "no report attachment", which is not what
 * happened. So a file with no extension is accepted when its type is text or its first lines are
 * the catalogue's own title; everything else still needs a known extension and a known type.
 */
export function acceptableAttachment(att: { filename?: string | null; contentType?: string | null; content?: Buffer | Uint8Array | null }): { ok: true } | { ok: false; why: string } {
  const name = att.filename ?? "";
  const type = att.contentType ?? "";
  if (!name) return { ok: false, why: "an attachment with no name" };
  const hasExt = /\.[A-Za-z0-9]{1,5}$/.test(name);
  if (hasExt) {
    if (!REPORT_EXT.test(name)) return { ok: false, why: `${name} (not a type this reads)` };
    if (!REPORT_MIME.has(type)) return { ok: false, why: `${name} (sent as ${type || "an unknown type"})` };
    return { ok: true };
  }
  if (TEXT_MIME.has(type)) {
    if (type !== "application/octet-stream") return { ok: true };
    const head = att.content ? Buffer.from(att.content.subarray(0, 8192)).toString("utf8") : "";
    if (looksLikePioneerCatalog(head)) return { ok: true };
  }
  return { ok: false, why: `${name} (no file extension, sent as ${type || "an unknown type"})` };
}

