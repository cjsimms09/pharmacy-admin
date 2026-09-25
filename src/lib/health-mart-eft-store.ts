import "server-only";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { storeFile } from "./files";
import { audit } from "./audit";
import { getSettings } from "./settings";
import { readEftNotice } from "./health-mart-eft";
import { bankPayerPayments } from "./payer-payments-store";

/**
 * Banks a Health Mart Atlas EFT notice, and keeps the notice.
 *
 * The reading is `health-mart-eft.ts`; this is the side that touches the database, so the mail sweep
 * needs one call and no knowledge of how a deposit becomes a cash receipt.
 *
 * Three things, in order:
 *
 *   1. The notice's own text is filed as a document. It is the pharmacy's only record of the transfer
 *      until the portal's report is pulled, and a receipt nobody can trace to a page is a figure
 *      somebody has to take on trust. Before this, the email was dropped with nothing kept.
 *   2. Its payments are banked through `bankPayerPayments` — the same gate and the same
 *      `payer-payment|health mart atlas|EFT-…` key the portal report uses — so one deposit is banked
 *      once whichever document arrives first.
 *   3. What happened is said in one sentence, including a deposit already held and a deposit whose
 *      held figure differs from this notice's.
 *
 * Null where the message is not a notice at all, so the sweep can carry on to its other readers.
 */
export async function bankEftNotice(
  input: { subject: string; text: string; from: string; messageId: string; receivedAt: string },
  by: { userId: string | null; userName: string },
): Promise<{ says: string; banked: number; bankedCents: number } | null> {
  const s = await getSettings();
  const notice = readEftNotice(input.subject, input.text, s.pharmacy_ncpdp || null);
  if (!notice) return null;

  const fileName = `Health Mart Atlas EFT ${notice.transferOn}.txt`;
  const body = `From: ${input.from}\nSubject: ${input.subject}\nReceived: ${input.receivedAt}\nMessage-ID: ${input.messageId}\n\n${input.text}`;
  const file = new File([new TextEncoder().encode(body)], fileName, { type: "text/plain" });
  const stored = await storeFile(file, { allowReportTypes: true });
  /*
   * One notice, one document. The sweep never reads a message twice, but a notice re-run by hand
   * would otherwise file the same page again beside the first — and the deposit itself is already
   * protected by its key, so the document is the only thing that could double.
   */
  const existing = await db.query.documents.findFirst({ where: (d, { eq }) => eq(d.sha256, stored.sha256), columns: { id: true } });
  const documentId = existing?.id ?? newId();
  if (!existing) await db.insert(schema.documents).values({
    id: documentId,
    category: "report",
    title: `Health Mart Atlas EFT completed — ${notice.transferOn}`,
    fileName,
    mimeType: "text/plain",
    sizeBytes: body.length,
    storageKey: stored.storageKey,
    sha256: stored.sha256,
    notes: `Received by email from ${input.from}`,
    uploadedBy: "mailbox-sweep",
  });

  const b = await bankPayerPayments(notice.payments, { ...by, documentId });

  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const parts = [notice.says];
  if (b.banked) parts.push(`${b.banked} deposit${b.banked === 1 ? "" : "s"}, ${money(b.bankedCents)}, banked as cash received on ${notice.transferOn}.`);
  /*
   * "Already on file", and deliberately not "from the portal's report": the key is shared, so the held
   * row may have come from the report or from this same notice read before. The first wording named
   * the report and was false the first time it printed.
   */
  if (b.alreadyHeld) parts.push(`${b.alreadyHeld} already on file under ${b.alreadyHeld === 1 ? "its EFT number" : "their EFT numbers"}, so not banked again.`);
  if (b.refused.length) parts.push(`Refused as already banked by another feed: ${b.refused.join("; ")}.`);
  if (b.disagree.length) parts.push(`Disagrees with what is held: ${b.disagree.join("; ")}.`);
  const says = parts.join(" ");

  await audit({
    action: "cash.eft_notice_read",
    userId: by.userId,
    userName: by.userName,
    entity: "document",
    entityId: documentId,
    details: says,
  });
  return { says, banked: b.banked, bankedCents: b.bankedCents };
}
