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
  // List prices per million tokens, by family: Haiku 4.5 $1/$5, Sonnet 5 $2/$10, Opus 5 $5/$25.
  const inPerM = rates?.in ?? (model.includes("haiku") ? 1 : model.includes("sonnet") ? 2 : 5);
  const outPerM = rates?.out ?? (model.includes("haiku") ? 5 : model.includes("sonnet") ? 10 : 25);
  const batch = 0.5;
  const docs = Math.max(1, pages / 12);
  const lo = ((pages * 1500) / 1e6) * inPerM * batch + ((docs * 4000) / 1e6) * outPerM * batch;
  const hi = ((pages * 3000) / 1e6) * inPerM * batch + ((docs * 8000) / 1e6) * outPerM * batch;
  return { low: lo, high: hi };
}

/**
 * The limits a request and a batch must respect, so a run never fails on size.
 *
 * A PDF in one request may carry at most 32 MB, and a number of pages that depends on the model it
 * is going to — see `pdfPageLimit`. A batch may carry 100 MB of requests. A document over the page
 * limit is not sent and is named, because sending it would fail after the batch was paid for and
 * the failure would look like a bad read.
 */

/**
 * How many PDF pages may go to a given model in one request.
 *
 * The API's cap is 600 pages, but only for a request whose context window is a million tokens;
 * under that it is 100. Both numbers matter here, because this site sends PDFs to two different
 * models: a contract is read by Opus 5, which has a million-token window, and every scan is first
 * sorted by Haiku 4.5, which has two hundred thousand.
 *
 * A single shared limit therefore cannot be right. Raised to 300 for the reader, it also let a
 * 150-page agreement through to the sorter, where the API would refuse it at 100 pages and the
 * model would refuse it again at 450,000 tokens into a 200,000-token window — inside a batch that
 * had already been created and paid for, which is the exact failure this guard exists to prevent.
 *
 * ── The two numbers ──
 *
 * A PDF page is sent as text and as an image and costs up to 3,000 tokens. On a million-token
 * model, 300 pages is 900,000 at the worst case with room for the answer, and it is what lets a
 * 150-page agreement be read whole instead of split by hand. On a 200,000-token model, 50 pages is
 * 150,000 with the same room — and the API's own 100-page cap for that case sits above it, so the
 * window is what binds.
 *
 * ── Anything else ──
 *
 * The model is a free-text setting: the owner can type any name into Settings. An unrecognised one
 * gets the smaller limit, because being asked to split a long PDF is a minor annoyance and paying
 * for a batch that cannot succeed is not.
 */
const LONG_WINDOW_MODELS = /^claude-(opus-5|sonnet-5|fable-5|fable-5-1|opus-4-[678]|sonnet-4-6)/;
export const PDF_PAGE_LIMIT_LONG = 300;
export const PDF_PAGE_LIMIT_SHORT = 50;

export function pdfPageLimit(model: string): number {
  return LONG_WINDOW_MODELS.test(model.trim().toLowerCase()) ? PDF_PAGE_LIMIT_LONG : PDF_PAGE_LIMIT_SHORT;
}

/**
 * The limit where no model is named.
 *
 * Kept at the cautious figure: every caller that knows which model it is sending to should ask
 * `pdfPageLimit`, and one that does not should not be guessing upward.
 */
export const PDF_PAGE_LIMIT = PDF_PAGE_LIMIT_SHORT;
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

/**
 * The batch ids a run wrote into its audit line, newest first, each once.
 *
 * A refused read used to overwrite the batch id on the document with the word "errored", so the
 * only place the id survived was the audit line written when the run was queued. The API keeps a
 * batch's results for 29 days, so those ids are enough to go back and ask what the refusal was.
 */
export function batchIdsIn(details: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of details) {
    for (const m of (d ?? "").matchAll(/\bmsgbatch_[A-Za-z0-9]+\b/g)) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        out.push(m[0]);
      }
    }
  }
  return out;
}
