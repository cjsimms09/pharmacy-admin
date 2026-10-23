import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { getSettings, setSetting } from "./settings";

/**
 * Refused reports are read again, by a button on the Inbox and by themselves after every update.
 *
 * On 23 October 2026 three reports sat on the Inbox as refused: IPD's statement, the USave rebate breakdown ($12,354.06 for
 * September) and a day's payment-type report. Each was refused for a layout the reader had not met, each was fixed within the
 * day, and each stayed refused because the only thing that read a stored document again was a person pressing "Read again with
 * today's rules", a button inside an "Other" fold that the owner could not find ("I have no way to have system reread rebate
 * statement"). The rebate was therefore booked nowhere, and the month it belonged to read as closed.
 *
 * Which rows: only the readers whose filing is keyed on the document's own identity, so reading twice cannot book twice (the
 * rebate on supplier and period, the IPD statement's payments and credits on their reference and memo, the payment-type report on
 * its date). Others are left to a person. Only rows the reader refused (`imported` false), and only recent ones.
 *
 * When: on a press, whenever he likes; and once per build by itself, because the reason a refused row might now read is that the
 * code changed. It is not tried on every half-hour sweep: each re-read writes to the books, and an audit event moves the
 * fingerprint every held reading in the site is keyed on. It uses no model and reaches nothing outside this computer.
 */
export const REREAD_KINDS = ["rebate_report", "ipd_statement", "sales_by_payment"] as const;
export const REREAD_WITHIN_DAYS = 60;

export type HeldRow = { id: string; routedAs: string; imported: boolean | null; documentId: string | null; receivedAt: string };

/** Which Inbox rows are tried again: refused by a reader that is safe to run twice, with a document to read, and recent. */
export function heldToReread(rows: HeldRow[], now: Date): HeldRow[] {
  const since = new Date(now.getTime() - REREAD_WITHIN_DAYS * 86_400_000).toISOString();
  return rows.filter((r) => (REREAD_KINDS as readonly string[]).includes(r.routedAs) && r.imported === false && !!r.documentId && r.receivedAt >= since);
}

/** The build the running site was made from, which changes whenever an update is installed. */
function currentBuild(): string | null {
  try {
    return fs.readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

const allRows = () =>
  db
    .select({ id: schema.inboxItems.id, routedAs: schema.inboxItems.routedAs, imported: schema.inboxItems.imported, documentId: schema.inboxItems.documentId, receivedAt: schema.inboxItems.receivedAt })
    .from(schema.inboxItems);

/** How many refused reports a press would read again, for the button's label. */
export async function heldCount(): Promise<number> {
  return heldToReread(await allRows(), new Date()).length;
}

export type RereadResult = { looked: number; booked: number; stillHeld: number; errors: number; said: string[] };

/** Reads every refused report again now. Nothing here decides whether it is time; the callers do. */
export async function rereadHeldNow(by: { userId: string | null; userName: string }): Promise<RereadResult> {
  const { rereadInboxItem } = await import("./mailbox");
  const rows = heldToReread(await allRows(), new Date());

  let errors = 0;
  const said: string[] = [];
  for (const r of rows) {
    try {
      said.push((await rereadInboxItem(r.id, { userId: by.userId ?? "automatic", userName: by.userName })).slice(0, 160));
    } catch (e) {
      errors++;
      said.push(`could not read again: ${e instanceof Error ? e.message.slice(0, 100) : "unknown"}`);
    }
  }
  /* Which of them are still refused is read back from the rows, not taken from what the reader said. */
  const ids = new Set(rows.map((r) => r.id));
  const after = rows.length ? await allRows() : [];
  const stillHeld = after.filter((r) => ids.has(r.id) && r.imported === false).length;
  const booked = Math.max(0, rows.length - stillHeld - errors);

  if (rows.length > 0) {
    await audit({ action: "inbox.reread_held", userId: by.userId, userName: by.userName, details: `${rows.length} read again; ${stillHeld} still refused. ${said.join(" | ").slice(0, 400)}` });
  }
  return { looked: rows.length, booked, stillHeld, errors, said };
}

/** Once per build, so a fix to a reader reaches what it was refused on without anybody pressing anything. */
export async function rereadHeldAfterUpdate(): Promise<{ build: string } & RereadResult | null> {
  const build = currentBuild();
  if (!build) return null;
  const s = await getSettings();
  if (s.held_reread_build === build) return null;

  const r = await rereadHeldNow({ userId: null, userName: "Automatic re-read after an update" });
  await setSetting("held_reread_build", build);
  await setSetting(
    "held_reread_result",
    `${new Date().toISOString()}: build ${build}: ${r.looked} refused report${r.looked === 1 ? "" : "s"} read again, ${r.booked} now filed, ${r.stillHeld} still refused${r.errors ? `, ${r.errors} could not be opened` : ""}`,
  );
  return { build, ...r };
}
