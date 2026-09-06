/**
 * The arithmetic of a contract run: what it costs, what fits in a request, what fits in a batch.
 *
 * Kept apart from the reader so it can be tested without a database or a key. Every limit here
 * is the API's, and a run that respects them cannot fail on size after the money is committed.
 *
 * Pure.
 */

/**
 * Roughly what a run will cost, so nothing starts without the number on screen.
 *
 * Rates come from Settings → Claude where they were typed, else the defaults, and the Batch API
 * halves them. A contract page runs 1,500–3,000 tokens in; the answer, with the map and every
 * cited term, runs 4,000–8,000 tokens out per document.
 */
export function estimateCost(pages: number, model: string, rates?: { in: number; out: number }): { low: number; high: number } {
  const inPerM = rates?.in ?? (model.includes("sonnet") ? 3 : 15);
  const outPerM = rates?.out ?? (model.includes("sonnet") ? 15 : 75);
  const batch = 0.5;
  const docs = Math.max(1, pages / 12);
  const lo = ((pages * 1500) / 1e6) * inPerM * batch + ((docs * 4000) / 1e6) * outPerM * batch;
  const hi = ((pages * 3000) / 1e6) * inPerM * batch + ((docs * 8000) / 1e6) * outPerM * batch;
  return { low: lo, high: hi };
}

/**
 * The limits a request and a batch must respect, so a run never fails on size.
 *
 * A PDF in one request may carry at most 100 pages by the API's rule and 50 by this site's (see below), and 32 MB; a batch at most 256 MB of requests.
 * A document over the page limit is not sent and is named, because sending it would fail after
 * the batch was paid for and the failure would look like a bad read.
 */
/*
 * Fifty, not the API's hundred.
 *
 * A PDF page is sent as text and as an image and costs up to 3,000 tokens; a hundred scanned pages
 * is 300,000, and a model with a 200,000-token window refuses the whole request. That refusal is
 * free but it is also a read that never happens, and it was the first thing the live folder hit.
 * Fifty pages at the worst case is 150,000 with room for the answer.
 */
export const PDF_PAGE_LIMIT = 50;
export const PDF_BYTES_LIMIT = 32 * 1024 * 1024;
export const BATCH_BYTES_LIMIT = 100 * 1024 * 1024;
export const BATCH_REQUEST_LIMIT = 100;

/** Rough page count from the PDF itself, for the estimate and the page limit. */
export function pdfPageCount(buf: { toString(enc: "latin1"): string }): number {
  return Math.max(1, (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length);
}

/**
 * Splits requests into batches under the size and count limits, in order. Pure, so it is tested.
 * `sizes` are the base64 lengths, which is what the API counts.
 */
export function planBatches<T>(items: { item: T; bytes: number }[], limits = { bytes: BATCH_BYTES_LIMIT, count: BATCH_REQUEST_LIMIT }): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const { item, bytes } of items) {
    if (cur.length > 0 && (curBytes + bytes > limits.bytes || cur.length >= limits.count)) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(item);
    curBytes += bytes;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}


/**
 * What a scanned contract can be searched by, once it has been read.
 *
 * Ninety-nine of this pharmacy's hundred-odd contracts are scans with no text layer, so the
 * search box on Payers could not see inside them: a BIN typed there found nothing, while the
 * agreement naming it sat on the same disk. The reader does read scans, page by page as images,
 * and everything it keeps is cited to a page. So the read is written back as the searchable text
 * of the file: every identifier, name, contact, definition and section, each on its own line with
 * its page where one was given. It is not the document — nothing quoted here is more than the
 * reader kept — and a hit says so by naming the page to open.
 */
export function searchBodyFromTerms(t: {
  counterparty: string;
  documentTitle: string;
  contractType: string;
  documentRole: string;
  parentAgreement: string | null;
  amendmentNumber: string | null;
  supersedes: string[];
  bins: string[];
  pcns: string[];
  groupIds: string[];
  chainCodes: string[];
  networkNames: string[];
  networkReimbursementIds: string[];
  pharmacyNcpdps: string[];
  pharmacyNpis?: string[];
  contacts: { purpose: string; name: string | null; organisation: string | null; phone: string | null; fax: string | null; email: string | null; portalUrl: string | null; postalAddress: string | null; citation?: { page: number | null } | null }[];
  macAppealSubmissionTarget: string | null;
  keyDefinitions: { term: string; definition: string; citation?: { page?: number | null } | null }[];
  sections: { title: string; pageFrom: number | null; pageTo: number | null; gist: string }[];
  incorporatesByReference: string[];
  unclearOrMissing: string[];
}): string {
  const lines: string[] = [];
  const list = (label: string, xs: string[]) => {
    const kept = xs.map((x) => x.trim()).filter(Boolean);
    if (kept.length) lines.push(`${label}: ${kept.join(", ")}`);
  };
  lines.push(`[From the read, not the scan. Open the page it names.]`);
  lines.push(`${t.documentTitle} — ${t.counterparty} (${t.contractType}, ${t.documentRole}${t.amendmentNumber ? `, amendment ${t.amendmentNumber}` : ""})`);
  if (t.parentAgreement) lines.push(`Attaches to: ${t.parentAgreement}`);
  list("Supersedes", t.supersedes);
  list("BIN", t.bins);
  list("PCN", t.pcns);
  list("Group", t.groupIds);
  list("Chain code", t.chainCodes);
  list("Network", t.networkNames);
  list("Network reimbursement id", t.networkReimbursementIds);
  list("Pharmacy NCPDP", t.pharmacyNcpdps);
  list("Pharmacy NPI", t.pharmacyNpis ?? []);
  for (const c of t.contacts) {
    const parts = [c.name, c.organisation, c.phone, c.fax ? `fax ${c.fax}` : null, c.email, c.portalUrl, c.postalAddress].filter((x): x is string => Boolean(x && x.trim()));
    if (parts.length) lines.push(`Contact for ${c.purpose.replace(/_/g, " ")}${c.citation?.page ? ` (page ${c.citation.page})` : ""}: ${parts.join(", ")}`);
  }
  if (t.macAppealSubmissionTarget) lines.push(`MAC appeals go to: ${t.macAppealSubmissionTarget}`);
  for (const d of t.keyDefinitions) lines.push(`Defines ${d.term}${d.citation?.page ? ` (page ${d.citation.page})` : ""}: ${d.definition}`);
  list("Incorporates by reference", t.incorporatesByReference);
  for (const s of t.sections) {
    const pages = s.pageFrom ? (s.pageTo && s.pageTo !== s.pageFrom ? `pages ${s.pageFrom}–${s.pageTo}` : `page ${s.pageFrom}`) : "page not given";
    lines.push(`Section ${s.title} (${pages}): ${s.gist}`);
  }
  list("Not read or not stated", t.unclearOrMissing);
  return lines.join("\n");
}
