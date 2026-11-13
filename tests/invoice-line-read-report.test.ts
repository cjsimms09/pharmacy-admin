import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { textPdf } from "../src/lib/pdf";

/*
 * The counts behind the "Read the lines off the invoices" press, counted from invoices that really are on file: a PDF with lines that
 * add up, one with a line the reader cannot read, the same one with no total printed anywhere, a scan, a prose page, and a file that
 * is not there, and one whose document is not on file at all. The press is run with the model switched off, which is also what is being pinned: nothing is sent to Claude, so
 * nothing is charged. Every figure is invented.
 */
let backfillInvoiceLines: typeof import("../src/lib/invoices").backfillInvoiceLines;
let saidAboutLineRead: typeof import("../src/lib/invoice-lines-said").saidAboutLineRead;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;
let filesDir = "";
let before_files: string | undefined;
let report: Awaited<ReturnType<typeof backfillInvoiceLines>>;

const controlledHalf = ["99999888801 1 0EACH 1,077.40  0  1,077.40", "OXYCODONE HCL 5MG TAB 100", "CII Subtotal:$1,077.40"];
const otherHalf = [
  "99999888802 1 0EACH 15.99  0  15.99",
  "IBUPROFEN 200MG TAB 100",
  "99999888803 1 0EACH 17.55  0  17.55",
  "CETIRIZINE 10MG TAB 30",
  "99999888804 3 0EACH 28.99  0  86.97",
  "AMOXICILLIN 500MG CAP 30",
  "99999888805 1 0EACH 1.80  0  1.80",
  "FAMOTIDINE 20MG TAB 30",
  "99999888806 3 0EACH 36.99  0  110.97",
  "LORATADINE 10MG TAB 30",
  "Non-CII Subtotal:$233.28",
];
const page = (lines: string[]) =>
  [
    "Independent Pharmacy Distributor",
    "Invoice 9000001  Ship Date 09/15/2026",
    "Product Product Name Quantity B/O UOM Price Discount Extension",
    ...lines,
    "Invoice Total:$1,310.68",
    "Remit to: PO Box 1000, Testtown KS 60000. Questions: (555) 555-0100. Terms net 30. Thank you for your order.",
  ];
const pdf = (lines: string[]) => textPdf("invoice", lines.map((text) => ({ text })));
const dropsALine = (l: string) => l.replace("99999888806 3 0EACH 36.99  0  110.97", "99999888806 3 0EACH ??.??  0 %");
const noTotalPrinted = (l: string) => !l.startsWith("Invoice Total:");
const prose = [
  "Statement of account for September 2026, prepared for West Testtown Pharmacy.",
  "This page lists no item lines. It is a covering letter that says the invoices follow under separate cover and gives the remittance address, the terms and a telephone number for questions about the account.",
];

async function add(label: string, file: Buffer | null, totalCents: number | null) {
  const key = `report-test/${label}.pdf`;
  if (file) {
    fs.mkdirSync(path.dirname(path.join(filesDir, key)), { recursive: true });
    fs.writeFileSync(path.join(filesDir, key), file);
  }
  await db.insert(schema.documents).values({ id: `doc-${label}`, category: "invoice", title: "test", fileName: `${label}.pdf`, mimeType: "application/pdf", sizeBytes: file?.length ?? 1, sha256: `sha-${label}`, storageKey: key, uploadedBy: "test" } as never);
  await db.insert(schema.supplierInvoices).values({ id: `inv-${label}`, documentId: `doc-${label}`, supplier: "IPD", invoiceNumber: label, invoiceDate: "2026-09-15", totalCents } as never);
}
async function addWithoutItsDocument(label: string, totalCents: number | null) {
  await db.insert(schema.supplierInvoices).values({ id: `inv-${label}`, documentId: `doc-missing-${label}`, supplier: "IPD", invoiceNumber: label, invoiceDate: "2026-09-15", totalCents } as never);
}
const row = (label: string) => db.query.supplierInvoices.findFirst({ where: (t, { eq }) => eq(t.id, `inv-${label}`), columns: { linesRead: true, linesUnread: true, linesShortCents: true } });

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  before_files = process.env.FILES_DIR;
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmacy-admin-report-files-"));
  process.env.FILES_DIR = filesDir;
  ({ backfillInvoiceLines } = await import("../src/lib/invoices"));
  ({ saidAboutLineRead } = await import("../src/lib/invoice-lines-said"));
  ({ db, schema } = await import("../src/db"));
  await add("good", pdf(page([...controlledHalf, ...otherHalf])), 131_068);
  await add("short", pdf(page([...controlledHalf, ...otherHalf]).map(dropsALine)), 131_068);
  await add("nototal", pdf(page([...controlledHalf, ...otherHalf]).filter(noTotalPrinted).map(dropsALine)), null);
  await add("scan", pdf(["Scanned page"]), 131_068);
  await add("prose", pdf(prose), 131_068);
  await add("gone", null, 131_068);
  await addWithoutItsDocument("orphan", 131_068);
  report = await backfillInvoiceLines({ allowModel: false });
});

after(() => {
  if (before_files === undefined) delete process.env.FILES_DIR;
  else process.env.FILES_DIR = before_files;
  try {
    fs.rmSync(filesDir, { recursive: true, force: true });
  } catch {
    // A scratch folder that will not delete is not worth failing a test over.
  }
  cleanUpDb?.();
});

describe("what the press counts from invoices on file", () => {
  test("the four invoices with text were read, and the three with nothing to read were not", () => {
    assert.equal(report.invoices, 4, "good, short, nototal and prose had text; the scan, the missing file and the missing document did not");
  });

  test("lines are counted where they were kept, including the ones on an invoice that fell short", () => {
    assert.equal(report.linesRead, 16, "six on the one that adds up, five on each of the two that do not");
    assert.equal(report.withLines, 3, "the prose page has no lines");
  });

  test("an invoice that falls short keeps its lines and carries the shortfall on its row, and the one that adds up carries none", async () => {
    const short = await row("short");
    assert.equal(short?.linesRead, 5);
    assert.equal(short?.linesShortCents, 11_097);
    const good = await row("good");
    assert.equal(good?.linesRead, 6);
    assert.equal(good?.linesShortCents, null);
  });

  test("an invoice with no total printed anywhere is still short, because a half of it is, though the reader's whole-invoice flag has nothing to say", async () => {
    const { parseInvoiceLines } = await import("../src/lib/invoice-lines");
    const { readGoodsSubtotalCents } = await import("../src/lib/invoices");
    const text = page([...controlledHalf, ...otherHalf]).filter(noTotalPrinted).map(dropsALine).join("\n");
    assert.equal(parseInvoiceLines(text, readGoodsSubtotalCents(text) ?? null).reconciles, null, "no total printed and none on file, so the flag is null");
    const nototal = await row("nototal");
    assert.equal(nototal?.linesRead, 5);
    assert.equal(nototal?.linesShortCents, 11_097, "the row records the shortfall of its half all the same");
  });

  test("both are counted short, and the one that adds up is not", () => {
    assert.equal(report.short, 2, "short and nototal; counted from the rows, so the null flag on nototal does not hide it");
  });

  test("a scan, a missing file and an invoice with no document are all unreadable, and only the last two are failures", async () => {
    assert.equal(report.unreadable, 3);
    assert.equal(report.failed, 2, "an invoice whose document is not on file is counted as one that would not open, not dropped");
    const orphan = await row("orphan");
    assert.equal(orphan?.linesRead, null, "and it is left exactly as it was");
    const scan = await row("scan");
    assert.equal(scan?.linesRead, 0, "a scan is marked as looked at");
    assert.equal(scan?.linesUnread, 0);
    const gone = await row("gone");
    assert.equal(gone?.linesRead, null, "a file that would not open is left exactly as it was");
  });

  test("with the model off nothing was sent to Claude, nothing was refused, and no line came from Claude", () => {
    assert.equal(report.byModel, 0);
    assert.deepEqual(report.model, { sent: 0, keptUnchecked: 0, refused: 0, whyNotKept: null, whyRefused: null });
  });
});

describe("and what it then tells him", () => {
  test("it names the shortfall, the scan and the failure, and is red because of the failure", () => {
    const r = saidAboutLineRead(report);
    assert.match(r.says, /^16 item lines read, on 3 of the 4 invoices that had text to read\./);
    assert.match(r.says, /2 invoices were read but did not add up to the amount printed on them\. The lines are kept, and each row shows what it is short by\./);
    assert.match(r.says, /1 is a scan with no text to read/);
    assert.match(r.says, /2 could not be read at all, and were left as they were\.$/);
    assert.doesNotMatch(r.says, /Claude/);
    assert.equal(r.trouble, true);
  });
});
