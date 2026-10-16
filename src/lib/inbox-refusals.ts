/**
 * Which messages the site turned away are still worth telling somebody about.
 *
 * A refusal is the one failure in the whole feed chain where the fault is certainly here: somebody
 * outside did their part and this building dropped it. Nobody outside can fix it and nobody outside
 * will chase it, which is why it earns an alert at all.
 *
 * ── The two things that are not refusals ──
 *
 * The first version of this alert counted every message that was not stored and opened with "7
 * messages arrived and were turned away". Five of the seven were ordinary email with nothing
 * attached — a shipment notification, a login, two postage confirmations, a training reply. Nothing
 * was offered and nothing was refused; there was simply nothing to file, which is what most mail is.
 * An alert that calls that a fault is an alert about the pharmacy having an inbox.
 *
 * The other two were Veridikal's, and they had been superseded hours earlier: the owner forwarded
 * both reports, they were read, and the money is on the site. A fault that has been fixed must stop
 * being reported the moment it is fixed, or the list stops being a list of things to do and becomes
 * a diary.
 *
 * Superseded is tested on the subject as well as the sender, and Veridikal is why: their reports
 * were refused from their own address, and what fixed it was a forward from the owner's. Nothing
 * from Veridikal had been stored at all, so a sender-keyed test alone would have gone on reporting a
 * fault that was fixed and paid. A forward carries the original subject, so that is the thread
 * between them.
 *
 * Pure, so what it would say can be checked against the real mailbox before anybody is told it.
 */

export type SweptMessage = {
  fromAddress: string;
  subject: string;
  receivedAt: string;
  reason?: string | null;
  status?: string | null;
};

/**
 * A subject shorter than this is not evidence that two messages are the same document.
 *
 * "Invoice", "Report", "Statement" would each match half the mailbox, and a false supersede is the
 * worse error of the two — it hides a real refusal.
 */
export const MIN_SUBJECT_MATCH = 12;

/** Whether something was actually offered and declined, rather than nothing having been attached. */
export function wasDeclined(m: SweptMessage): boolean {
  if (m.status === "rejected") return true;
  return /type this reads|too large|refused/i.test(m.reason ?? "");
}

export function refusalsWorthReporting(turnedAway: SweptMessage[], stored: SweptMessage[]): SweptMessage[] {
  const latestBySender = new Map<string, string>();
  for (const s of stored) {
    const k = s.fromAddress.trim().toLowerCase();
    if (!latestBySender.has(k) || s.receivedAt > latestBySender.get(k)!) latestBySender.set(k, s.receivedAt);
  }
  const supersededBySubject = (m: SweptMessage): boolean => {
    const subject = m.subject.trim().toLowerCase();
    if (subject.length < MIN_SUBJECT_MATCH) return false;
    return stored.some((x) => x.receivedAt >= m.receivedAt && x.subject.trim().toLowerCase().includes(subject));
  };
  return turnedAway.filter((m) => {
    /* A bounce is the mail system talking about our own outgoing post, not a sender being refused. */
    if (/mailer-daemon|postmaster/i.test(m.fromAddress)) return false;
    if (!wasDeclined(m)) return false;
    const fromSender = latestBySender.get(m.fromAddress.trim().toLowerCase());
    if (fromSender && fromSender > m.receivedAt) return false;
    return !supersededBySubject(m);
  });
}
