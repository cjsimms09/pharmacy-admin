import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";

/**
 * Taking a line off the Inbox list, without making the site forget it has seen the email.
 *
 * "Take off this list" deleted the row. The row is also the only record that the message was already dealt with: the mail sweep
 * looks at everything unread and at the last thirty days of read mail, and skips what is on file by message id. With the row
 * gone, the next sweep found the message again and filed it as a new arrival. On 23 October 2026 the owner cleared
 * `image001.png`, `PL-Sept 26.pdf` and `PL-Oct 2026.pdf` at 2:57 pm and again at 4:17 pm, and each came back at the 4:22 sweep:
 * 8 of his 21 cleared lines returned. "The inbox keeps pulling up things I told it to ignore."
 *
 * So the line is kept and marked as passed over on purpose. It leaves the list of what needs him (the page counts only refused,
 * unrecognised and held lines there), stays under "Show them" with the reason, and the message id stays on file so the sweep
 * never takes it again. A stored document is untouched, as before.
 */
export async function dismissInboxItem(id: string, by: { id: string; name: string }): Promise<{ found: boolean; hadDocument: boolean; label: string }> {
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, id) });
  if (!item) return { found: false, hadDocument: false, label: "" };
  const label = item.fileName ?? item.subject;
  const said = `Taken off the list by ${by.name} on ${new Date().toISOString().slice(0, 10)}. It stays on file so it is not taken again.`;
  await db
    .update(schema.inboxItems)
    .set({ status: "ignored", routedAs: "not_for_filing", routeResult: said, reason: said, imported: null })
    .where(eq(schema.inboxItems.id, id));
  await audit({
    action: "inbox.clear",
    userId: by.id,
    userName: by.name,
    entity: "inbox_item",
    entityId: id,
    details: `${label}${item.documentId ? " — the stored document was kept" : ""}`,
  });
  return { found: true, hadDocument: Boolean(item.documentId), label };
}
