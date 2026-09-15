import "server-only";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { storeFile } from "./files";
import { audit } from "./audit";
import { addCashReceipt } from "./expenses";
import { cellsOf, looksLikeCardBatch, readCardBatch } from "./card-batch";

/**
 * Banks a credit card batch report as the counter takings it records, and keeps the summary.
 *
 * The reading is `card-batch.ts`; this is the side that touches the database. Null where the message
 * is not a card batch report, so the mail sweep can carry on to its other readers.
 *
 * Banked as a `patient` cash receipt, keyed `card-batch|<batch id>` so a report forwarded twice banks
 * once, on the day the batch closed, through `addCashReceipt` and so through the deposit gate. When the
 * bank statement is read its deposit line confirms this receipt rather than adding one — see
 * `matchHeldDeposit`. Nothing here touches the accrual account, which already has this revenue from the
 * claims and the till.
 */
export async function bankCardBatch(
  input: { subject: string; from: string; messageId: string; receivedAt: string; attachments: { filename?: string | null; content: Buffer }[] },
  by: { userName: string },
): Promise<{ says: string; banked: boolean; refused: boolean } | null> {
  if (!looksLikeCardBatch(input.subject)) return null;
  const summary = input.attachments.find((a) => /summary/i.test(a.filename ?? "") && /\.html?$/i.test(a.filename ?? ""));
  if (!summary) {
    return { says: `A card batch report arrived with no summary attached (${input.subject}). Nothing was banked; it needs the Summary Report.`, banked: false, refused: true };
  }

  const read = readCardBatch(input.subject, summary.content.toString("utf8"));
  if (!read.ok) return { says: read.why, banked: false, refused: true };
  const b = read.batch;

  /*
   * Kept as the table text rather than the HTML. The file store refuses HTML — rightly, a web page is
   * a thing that can run — and the figures are the evidence: every cell of the summary is in it, in
   * order, so the batch can be audited against the page without the page being stored.
   */
  const fileName = `Batch ${b.batchId} Summary Report.txt`;
  const text = [
    `Subject: ${input.subject}`,
    `From: ${input.from}`,
    `Received: ${input.receivedAt}`,
    `Original attachment: ${summary.filename ?? "(unnamed)"}`,
    "",
    ...cellsOf(summary.content.toString("utf8")),
    "",
  ].join("\n");
  const file = new File([new TextEncoder().encode(text)], fileName, { type: "text/plain" });
  const stored = await storeFile(file, { allowReportTypes: true });
  const existing = await db.query.documents.findFirst({ where: (d, { eq }) => eq(d.sha256, stored.sha256), columns: { id: true } });
  const documentId = existing?.id ?? newId();
  if (!existing) {
    await db.insert(schema.documents).values({
      id: documentId,
      category: "report",
      title: `Card batch ${b.batchId} — ${b.closedOn}`,
      fileName,
      mimeType: "text/plain",
      sizeBytes: text.length,
      storageKey: stored.storageKey,
      sha256: stored.sha256,
      notes: `Received by email from ${input.from}`,
      uploadedBy: "mailbox-sweep",
    });
  }

  const r = await addCashReceipt({
    month: b.closedOn.slice(0, 7),
    kind: "patient",
    amountCents: b.totalCents,
    payer: "Card batch",
    notes: `Card takings at the counter — copays and front of shop together; the batch does not split them. ${b.byCard.map((c) => `${c.card} ${c.count}`).join(", ")}.`,
    documentId,
    sourceKey: `card-batch|${b.batchId}`,
    receivedOn: b.closedOn,
    reference: b.batchId,
    createdBy: by.userName,
  });

  const says = r.duplicate ? `${b.says} Already on file, so not banked again: ${r.why}.` : `${b.says} Banked as counter takings received on ${b.closedOn}.`;
  await audit({ action: "cash.card_batch_read", userName: by.userName, entity: "document", entityId: documentId, details: says });
  return { says, banked: !r.duplicate, refused: false };
}
