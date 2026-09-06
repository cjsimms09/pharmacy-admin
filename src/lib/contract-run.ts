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
 * A PDF in one request may carry at most 100 pages and 32 MB; a batch at most 256 MB of requests.
 * A document over the page limit is not sent and is named, because sending it would fail after
 * the batch was paid for and the failure would look like a bad read.
 */
export const PDF_PAGE_LIMIT = 100;
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

