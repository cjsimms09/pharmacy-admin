import "server-only";
import { isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings } from "./settings";

/**
 * Can this pharmacy actually send an email, and did the last attempt work?
 *
 * The parts to answer that already existed and none of them were anywhere useful. Whether sending
 * is configured was inferrable from two settings; the outcome of the last attempt was a string on
 * a settings sub-page; and the reason a particular person never got their training was on the
 * assignment row, visible only if you went looking at that person. So "I do not think the training
 * emails are sending" was a reasonable thing to believe and there was no one place that would
 * confirm or deny it.
 *
 * The distinction that matters, and that nothing captured: configured is not the same as working.
 * A pharmacy that has typed its Gmail address and its ordinary account password is configured and
 * cannot send a thing — Google wants an app password — and every screen said it was set up.
 */

export type MailHealth = {
  /** Credentials are present. Says nothing about whether they are accepted. */
  configured: boolean;
  /** The last send attempt succeeded. Null when nothing has ever been attempted. */
  lastOk: boolean | null;
  lastAt: string | null;
  lastDetail: string | null;
  /** Assignments carrying a delivery error right now — people who owe training and were not told. */
  failed: { personId: string; type: string; error: string }[];
  /** Outstanding assignments nobody has managed to send at all. */
  neverSent: number;
  /** One sentence, in the words the PIC needs. */
  summary: string;
  state: "off" | "failing" | "unproven" | "ok";
};

export async function mailHealth(): Promise<MailHealth> {
  const [s, open] = await Promise.all([
    getSettings(),
    db.query.trainingAssignments.findMany({ where: isNull(schema.trainingAssignments.completedAt) }),
  ]);

  const configured = Boolean(s.mail_user && s.mail_password_enc);
  const raw = (s.mail_last_send_result ?? "").trim();
  const lastAt = raw ? raw.slice(0, raw.indexOf(" —") > 0 ? raw.indexOf(" —") : 0) || null : null;
  const lastOk = raw ? !/FAILED/i.test(raw) : null;
  const lastDetail = raw || null;

  const failed = open
    .filter((a) => a.sendError)
    .map((a) => ({ personId: a.personId, type: a.type as string, error: a.sendError as string }));
  const neverSent = open.filter((a) => !a.sentAt).length;

  const state: MailHealth["state"] = !configured
    ? "off"
    : lastOk === false || failed.length > 0
      ? "failing"
      : lastOk === null
        ? "unproven"
        : "ok";

  const summary =
    state === "off"
      ? "Nothing can be emailed: no sending account is set up, so every training has to be handed over in person."
      : state === "failing"
        ? `Email is set up but the last attempt did not get through${failed.length ? `, and ${failed.length} assignment${failed.length === 1 ? "" : "s"} ${failed.length === 1 ? "is" : "are"} sitting undelivered` : ""}.`
        : state === "unproven"
          ? "Email is set up but nothing has been sent yet, so it has never been proved. Send yourself a test before you rely on it."
          : "Email is set up and the last message got through.";

  return { configured, lastOk, lastAt, lastDetail, failed, neverSent, summary, state };
}

/** Kept out of the type above so callers cannot accidentally treat "configured" as "working". */
export function mailTone(state: MailHealth["state"]): "ok" | "warn" | "crit" {
  return state === "ok" ? "ok" : state === "unproven" ? "warn" : "crit";
}
