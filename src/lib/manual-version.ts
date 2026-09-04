import type { Section } from "./manual-store";

/**
 * Which manual somebody acknowledged.
 *
 * An acknowledgement that says "I have read the policy and procedure manual" and nothing else is
 * weak evidence and, after the first edit, quietly false. The manual is edited here — that is the
 * point of holding it here — so a signature collected in March refers to text that no longer
 * exists by June. An inspector asking which version the staff acknowledged gets no answer, and
 * the pharmacy cannot show that the people working under a policy have read the policy they are
 * working under.
 *
 * So a signature is taken against a revision: a fingerprint of the manual's actual text at the
 * moment it was signed. Two things follow, and both are the reason for doing it. The record says
 * what was agreed to. And the site can tell, without anybody checking, who signed for a manual
 * that has since been rewritten — which is exactly when an acknowledgement needs asking for
 * again.
 *
 * Not every edit deserves a fresh round of signatures. A typo corrected in a heading is not a
 * change of policy, and asking eleven people to re-sign for one is how a control stops being
 * taken seriously. So this reports the position and leaves the judgement to a person.
 */

export type Revision = {
  /** Short, stable, and printable on a form somebody signs. */
  fingerprint: string;
  sections: number;
  words: number;
  /** The most recent edit to any section, as a date. */
  changedOn: string | null;
  /** The same, to the second, for deciding whether a signature came after the last edit. */
  changedAt: string | null;
};

/**
 * A fingerprint of the manual's text.
 *
 * FNV-1a over the title and body of each section in a fixed order. Not a security hash and not
 * pretending to be one: it exists to answer "is this the same manual?", and the thing it guards
 * against is drift, not forgery.
 */
export function fingerprintOf(parts: string[]): string {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // A separator, so moving a sentence from one section into the next changes the answer.
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The revision of a set of sections.
 *
 * Chapters somebody else maintains are included, because they are still part of the document the
 * pharmacy hands a new member of staff and asks them to read. Retired sections are not, since
 * they are no longer in the manual.
 */
export function revisionOf(sections: Section[]): Revision {
  const live = sections
    .filter((s) => !s.retiredOn)
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const words = live.reduce((n, s) => n + (s.body.trim() ? s.body.trim().split(/\s+/).length : 0), 0);
  const changed = live
    .map((s) => (s.updatedAt ?? "").slice(0, 10))
    .filter(Boolean)
    .sort()
    .at(-1);


  const changedAt = live
    .map((s) => s.updatedAt ?? "")
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    fingerprint: fingerprintOf(live.map((s) => `${s.title} ${s.body.trim()}`)),
    sections: live.length,
    words,
    changedOn: changed ?? null,
    changedAt: changedAt ?? null,
  };
}

/** How a revision is written on a record, a certificate, or a paper form. */
export function describeRevision(r: Revision): string {
  return `Revision ${r.fingerprint} — ${r.sections} sections${r.changedOn ? `, last edited ${r.changedOn}` : ""}`;
}

/**
 * Where one person's acknowledgement stands against the manual as it is now.
 *
 * "Signed, but for an older manual" is its own state and has to be shown as its own state. It is
 * not the same as never having signed — the person did what was asked of them — and it is not the
 * same as being up to date, because the document they agreed to is not the one on the shelf.
 */
export type AckState = "none" | "current" | "superseded" | "unknown";

export function ackState(signed: string | null | undefined, current: Revision): AckState {
  if (!signed) return "none";
  // Signed before revisions were recorded. A real acknowledgement of a manual nothing identifies.
  if (signed === "legacy") return "unknown";
  return signed === current.fingerprint ? "current" : "superseded";
}

export const ACK_LABEL: Record<AckState, string> = {
  none: "Not acknowledged",
  current: "Acknowledged, current manual",
  superseded: "Acknowledged an earlier manual",
  unknown: "Acknowledged, version not recorded",
};

/**
 * Whether an acknowledgement with no version recorded is nonetheless provably of this manual.
 *
 * The honest answer to "signed, but of what?" is usually to ask again — but not always, and asking
 * for a signature somebody gave an hour ago is the sort of thing that teaches people to sign
 * without reading. The manual records when each section was last edited. If nothing has been
 * edited since the moment the person signed, the document they were shown is character for
 * character the document on file now. That is not an assumption; it is a fact the system holds.
 *
 * Where the manual *has* been edited since, nothing can be established and it stays unresolved.
 * Backfilling a fingerprint there would be inventing evidence.
 */
export function provablyCurrent(signedAt: string | null | undefined, current: Revision): boolean {
  if (!signedAt || !current.changedAt) return false;
  return current.changedAt <= signedAt;
}
