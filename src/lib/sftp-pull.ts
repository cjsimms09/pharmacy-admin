import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import { db, schema } from "@/db";
import { getSettings, setSetting } from "./settings";
import { readSecret } from "./connections";
import { newId } from "./crypto";
import { storeFile, MAX_FILE_BYTES } from "./files";
import { acceptableAttachment } from "./autoroute";
import { gateFile } from "./phi-gate";

/**
 * The pharmacy's SFTP mailbox, swept.
 *
 * RedSail, 8 September, on the copay-voucher remittances: "To do this automatically, we would need
 * a SFTP site to send them to." PBMs say the same of 835s: nobody emails a remittance, because it
 * carries patient identifiers, and portals are somebody's job to remember. So the pharmacy keeps
 * one SFTP host that the senders push to and this site pulls from, and a file that lands there is
 * handled exactly as one that arrived by email: filed as a document, put on the inbox with what it
 * was recognised as and what happened when it was loaded, and — for an 835 — read through the
 * remittance reader with its balance check.
 *
 * The host is not this computer. Pulled files leave the host as soon as they are stored here (the
 * remote is moved to done/, never deleted, so a sender can see what was collected), and the key
 * the site logs in with lives in data/sftp/, outside git, with a password as the fallback.
 */

export const SITE_KEY_FILE = path.join(process.cwd(), "data", "sftp", "pharmacy_ed25519");

export type SftpConfig = { host: string; port: number; user: string; folder: string; password: string | null; privateKey: string | null };

export async function sftpConfig(): Promise<SftpConfig | { missing: string[] }> {
  const s = await getSettings();
  const password = await readSecret("sftp");
  let privateKey: string | null = null;
  try {
    privateKey = await fs.readFile(SITE_KEY_FILE, "utf8");
  } catch {
    privateKey = null;
  }
  const missing: string[] = [];
  if (!s.sftp_host) missing.push("the host");
  if (!s.sftp_user) missing.push("the user");
  if (!password && !privateKey) missing.push("a password or the site's key (data/sftp/pharmacy_ed25519)");
  if (missing.length) return { missing };
  return { host: s.sftp_host.trim(), port: Number(s.sftp_port) || 22, user: s.sftp_user.trim(), folder: (s.sftp_folder || "/inbox").trim(), password, privateKey };
}

async function connect(c: SftpConfig): Promise<SftpClient> {
  const client = new SftpClient();
  await client.connect({
    host: c.host,
    port: c.port,
    username: c.user,
    ...(c.privateKey ? { privateKey: c.privateKey } : {}),
    ...(c.password ? { password: c.password } : {}),
    readyTimeout: 20_000,
  });
  return client;
}

/** Connects, lists the folder, records the answer either way. */
export async function testSftp(): Promise<{ ok: true; files: number; detail: string } | { ok: false; error: string }> {
  const c = await sftpConfig();
  if ("missing" in c) return { ok: false, error: `Not set up yet: ${c.missing.join(", ")}.` };
  let client: SftpClient | null = null;
  try {
    client = await connect(c);
    const list = await client.list(c.folder);
    const files = list.filter((f) => f.type === "-").length;
    const detail = `Connected to ${c.host} as ${c.user} with ${c.privateKey ? "the site's key" : "a password"}; ${files} file${files === 1 ? "" : "s"} waiting in ${c.folder}.`;
    await setSetting("sftp_last_result", `${new Date().toISOString()}: ${detail}`);
    return { ok: true, files, detail };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setSetting("sftp_last_result", `${new Date().toISOString()}: failed: ${error}`);
    return { ok: false, error };
  } finally {
    await client?.end().catch(() => undefined);
  }
}

export type PullResult = { pulled: number; stored: number; rejected: number; imported: number; errors: string[] };

/**
 * Every regular file in the folder: stored here, filed, routed, then moved to done/ on the host.
 *
 * Dedupe is by host, path, size and modified time, the same way the mail sweep keys on the message
 * id: a file collected once is not collected again even if the move to done/ failed.
 */
export async function pullSftp(ctx: { userId: string | null; userName: string | null }): Promise<PullResult> {
  const result: PullResult = { pulled: 0, stored: 0, rejected: 0, imported: 0, errors: [] };
  const c = await sftpConfig();
  if ("missing" in c) return result;
  const s = await getSettings();
  let client: SftpClient | null = null;
  try {
    client = await connect(c);
    const list = (await client.list(c.folder)).filter((f) => f.type === "-");
    for (const f of list) {
      const remote = `${c.folder.replace(/\/$/, "")}/${f.name}`;
      const messageId = `sftp:${c.host}:${remote}:${f.size}:${f.modifyTime}`;
      const already = await db.query.inboxItems.findFirst({ where: (t, { eq }) => eq(t.messageId, messageId) });
      if (already) continue;
      result.pulled++;
      const receivedAt = new Date(f.modifyTime || Date.now()).toISOString();
      const from = `sftp://${c.host}${c.folder}`;
      const itemId = newId();
      try {
        if (f.size > MAX_FILE_BYTES) {
          await db.insert(schema.inboxItems).values({ id: itemId, messageId, receivedAt, fromAddress: from, subject: f.name, fileName: f.name, status: "rejected", routedAs: "rejected", reason: "File is larger than 20 MB." });
          result.rejected++;
          continue;
        }
        const buf = (await client.get(remote)) as Buffer;
        /*
         * A file on an SFTP host has no content type, so one is given from what it is: an X12
         * envelope ("ISA*…") is a remittance whatever it is named, text is text, and anything
         * else is a plain stream, which the acceptance rule lets through when the name is known.
         */
        const head = buf.subarray(0, 4).toString("latin1");
        const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(f.name)?.[1] ?? "").toLowerCase();
        const contentType = head === "ISA*" ? "application/octet-stream" : ext === "csv" ? "text/csv" : ext === "txt" || ext === "tsv" ? "text/plain" : ext === "pdf" ? "application/pdf" : "application/octet-stream";
        const verdict = acceptableAttachment({ filename: f.name, contentType, content: buf });
        if (!verdict.ok) {
          await db.insert(schema.inboxItems).values({ id: itemId, messageId, receivedAt, fromAddress: from, subject: f.name, fileName: f.name, status: "rejected", routedAs: "rejected", reason: verdict.why });
          result.rejected++;
          await client.rename(remote, `${c.folder.replace(/\/$/, "")}/done/${f.name}`).catch(() => undefined);
          continue;
        }
        // The same gate every emailed file passes: a document that names a patient where none should is held, not loaded.
        const gate = gateFile(f.name, buf);
        if (!gate.ok) {
          await db.insert(schema.inboxItems).values({ id: itemId, messageId, receivedAt, fromAddress: from, subject: f.name, fileName: f.name, status: "rejected", routedAs: "rejected", reason: gate.reason });
          result.rejected++;
          await client.rename(remote, `${c.folder.replace(/\/$/, "")}/done/${f.name}`).catch(() => undefined);
          continue;
        }
        const file = new File([new Uint8Array(buf)], f.name, { type: contentType });
        const stored = await storeFile(file, { allowReportTypes: true });
        const docId = newId();
        await db.insert(schema.documents).values({
          id: docId,
          category: "report",
          title: f.name,
          fileName: f.name,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageKey: stored.storageKey,
          inboxItemId: itemId,
          notes: `Collected from ${from}`,
          uploadedBy: ctx.userId ?? "sftp-pull",
        });
        let routedAs = "unrecognised"; // stated, never absent — see inbox_items.routedAs
        let routeResult: string | null = null;
        if ((s.mail_auto_import ?? "").toLowerCase() !== "yes") {
          routeResult = "Filed only: automatic loading is switched off under Settings → Email.";
        } else {
          const { importDropped } = await import("./mailbox");
          const r = await importDropped(buf, f.name, ctx, docId);
          routedAs = r.routedAs;
          routeResult = r.recognised ? r.routeResult : `Filed, not loaded: ${r.routeResult ?? "not a file this site reads"}.`;
          if (r.imported) result.imported++;
        }
        await db.insert(schema.inboxItems).values({
          id: itemId,
          messageId,
          receivedAt,
          fromAddress: from,
          subject: f.name,
          fileName: f.name,
          documentId: docId,
          status: "stored",
          scanned: gate.scanned,
          reason: gate.note ?? null,
          routedAs,
          routeResult,
        });
        result.stored++;
        await client.mkdir(`${c.folder.replace(/\/$/, "")}/done`, true).catch(() => undefined);
        await client.rename(remote, `${c.folder.replace(/\/$/, "")}/done/${f.name}`).catch((e: unknown) => {
          result.errors.push(`${f.name} was collected but could not be moved to done/ on the host: ${e instanceof Error ? e.message : String(e)}`);
        });
      } catch (e) {
        result.errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await setSetting("sftp_last_pull", new Date().toISOString());
    await setSetting("sftp_last_result", `${new Date().toISOString()}: ${result.pulled} collected, ${result.stored} filed, ${result.imported} loaded, ${result.rejected} rejected${result.errors.length ? `; ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}: ${result.errors[0]}` : ""}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    result.errors.push(error);
    await setSetting("sftp_last_result", `${new Date().toISOString()}: failed: ${error}`);
  } finally {
    await client?.end().catch(() => undefined);
  }
  return result;
}
