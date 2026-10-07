import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { onSiteToday } from "./roster";
import { atLocal, todayIso } from "./dates";
import { ensureObligations, CLOSURES, OBLIGATION_SEEDS, RENEWAL_CREDENTIAL } from "./obligations";
import { readRenewal, renewalMissing } from "./renewal-cover";
import { CREDENTIAL_LABEL } from "./labels";
import { periodKeyFor, periodLabel, periodEnds, stateOf, type PeriodState } from "./periods";
import { judgedPeriods } from "./judged";
import type { ObligationKind, ObligationCadence } from "@/db/schema";

/**
 * What is actually outstanding, and what closing it would take.
 *
 * The organising idea is that a compliance screen should not be a list of duties. It should be a
 * list of actions, each with the shortest honest path to done attached — and it should be as
 * short as the software can make it, which means the site checking everything it is able to
 * check for itself before asking the PIC anything at all.
 */

export type ActionKind = ObligationKind;

export type OpenItem = {
  obligationId: string;
  seedKey: string | null;
  title: string;
  detail: string | null;
  citation: string | null;
  kind: ActionKind;
  periodKey: string;
  periodLabel: string;
  dueOn: string;
  state: PeriodState;
  daysLate: number;
  /** How many pieces of evidence a period wants, and how many are in. */
  have: number;
  expected: number;
  /** Roughly how long this takes, so a thirty-second job is distinguishable from a Sunday one. */
  minutes: number | null;
  /** The exact sentence that will be recorded if the PIC attests. */
  statement: string | null;
  /** For witnessed duties: what is still missing, in words. */
  missing: string | null;
  /** Where to go, when going somewhere is the answer. */
  href: string | null;
};

const fill = (template: string, periodKey: string, today: string) =>
  template.replace(/\{period\}/g, periodLabel(periodKey)).replace(/\{date\}/g, today);

/**
 * When to start counting periods from.
 *
 * The earliest thing the pharmacy actually did here. Counting from before the site existed would
 * open with a page of failures for months nobody could have filed anything in, which teaches the
 * PIC to ignore the screen on the first day they see it.
 */
export async function startedUsingSite(): Promise<string> {
  const [o] = await db.select({ at: schema.obligations.createdAt }).from(schema.obligations).orderBy(asc(schema.obligations.createdAt)).limit(1);
  return (o?.at ?? new Date().toISOString()).slice(0, 10);
}

/**
 * Resolves the duties the site can settle without asking.
 *
 * Returns, per period key, how many pieces of evidence exist. Every one of these is a question
 * the PIC would otherwise have been asked about something the software already knew.
 */
async function witnessed(seedKey: string, periods: string[], cadence: ObligationCadence): Promise<{ counts: Map<string, number>; missing: string | null }> {
  const counts = new Map<string, number>(periods.map((p) => [p, 0]));
  const bump = (iso: string | null | undefined) => {
    if (!iso) return;
    const k = periodKeyFor(cadence, iso.slice(0, 10));
    if (k && counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
  };

  switch (seedKey) {
    case "cs_annual_inventory": {
      for (const i of await db.query.csInventories.findMany()) bump(i.inventoryDate);
      return { counts, missing: "No controlled substance inventory has been recorded for this period." };
    }
    case "temperature_logs": {
      const { monthsSatisfied } = await import("./imonnit");
      for (const [p, okMonth] of await monthsSatisfied(periods)) if (okMonth) counts.set(p, 1);
      return {
        counts,
        missing:
          "Readings, an explanation against every out-of-range one, and the month signed off. Open Temperatures.",
      };
    }
    case "technician_list": {
      // Filed by the site itself, so the completion rows are the evidence and there is nothing
      // else to look at. Counted here only so the duty reads as closing itself rather than as
      // something the PIC forgot.
      const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.seedKey, "technician_list") });
      if (o) {
        for (const c of await db.query.obligationCompletions.findMany({ where: eq(schema.obligationCompletions.obligationId, o.id) })) {
          if (c.periodKey && counts.has(c.periodKey)) counts.set(c.periodKey, 1);
        }
      }
      return { counts, missing: "This month's list is filed once the month ends." };
    }
    case "backup_restore_test": {
      // A backup having been taken is not evidence that a backup can be restored, and this
      // obligation asks the second question. The rehearsal answers it: an archive already on
      // disk, opened cold and restored to a scratch database. Each one counts in the quarter it was
      // done on the pharmacy's clock, so a later test cannot take an earlier quarter's cover away.
      const { restoreRehearsalDates } = await import("./backup");
      for (const at of await restoreRehearsalDates()) bump(atLocal(at));
      return { counts, missing: "No backup has been opened and proved to restore in this period." };
    }
    case "fwa_training":
    case "hipaa_training":
    case "osha_bloodborne":
    case "osha_hazcom":
    case "cqi_program_document": {
      const type = {
        fwa_training: "fwa_general_compliance",
        hipaa_training: "hipaa_privacy_security",
        osha_bloodborne: "osha_bloodborne",
        osha_hazcom: "osha_hazard_communication",
        cqi_program_document: "cqi_program_review",
      }[seedKey]!;
      const people = await onSiteToday();
      const trainings = await db.query.trainings.findMany();
      // A period counts only when every active person has it — one person short is the whole
      // duty unmet, because that is how it would be judged.
      for (const p of periods) {
        const done = people.filter((person) =>
          trainings.some((t) => t.personId === person.id && t.type === type && periodKeyFor(cadence, t.completedOn) === p),
        );
        if (people.length > 0 && done.length === people.length) counts.set(p, 1);
      }
      const people2 = people.length;
      const latest = periods[periods.length - 1];
      const doneNow = people.filter((person) =>
        trainings.some((t) => t.personId === person.id && t.type === type && periodKeyFor(cadence, t.completedOn) === latest),
      ).length;
      return {
        counts,
        missing: people2 === 0 ? "No active staff are recorded." : `${people2 - doneNow} of ${people2} staff still to complete it.`,
      };
    }
    case "immunization_protocol_review": {
      const people = await onSiteToday();
      const immunizers = people.filter((p) => p.administersVaccines);
      const creds = await db.query.credentials.findMany();
      for (const p of periods) {
        if (immunizers.length === 0) { counts.set(p, 1); continue; }
        const ok = immunizers.filter((person) =>
          creds.some((c) => c.personId === person.id && c.type === "immunization_protocol" && periodKeyFor(cadence, c.issuedOn ?? "") === p),
        );
        if (ok.length === immunizers.length) counts.set(p, 1);
      }
      return { counts, missing: immunizers.length === 0 ? null : "One or more immunizers has no protocol signed in this period." };
    }
    default:
      return { counts, missing: null };
  }
}

/** A seeded duty nobody has said yes or no to yet. */
export type Unanswered = {
  obligationId: string;
  seedKey: string | null;
  title: string;
  detail: string | null;
  citation: string | null;
  cadence: ObligationCadence;
};

/**
 * The duties that are still questions.
 *
 * These ship switched on because leaving out a rule that does apply is the expensive mistake and
 * leaving in one that does not is a two-second answer. But only if the answer is actually
 * offered — an item that says "confirm whether this applies" with nothing to click is worse than
 * either, because it cannot be cleared and so it trains the PIC to ignore the whole list.
 */
export async function unansweredObligations(): Promise<Unanswered[]> {
  await ensureObligations();
  const rows = (await db.query.obligations.findMany()).filter((o) => o.active && o.needsConfirmation);
  return rows
    .map((o) => ({ obligationId: o.id, seedKey: o.seedKey, title: o.title, detail: o.detail, citation: o.citation, cadence: o.cadence }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** A duty answered "no". It counts nowhere, and the register lists it with the day and the person so it reads as decided and not as overlooked. */
export type Dismissed = {
  obligationId: string;
  title: string;
  citation: string | null;
  cadence: ObligationCadence;
  decidedOn: string | null;
  decidedBy: string | null;
};

export async function dismissedObligations(): Promise<Dismissed[]> {
  const rows = (await db.query.obligations.findMany()).filter((o) => !o.active);
  return rows
    .map((o) => ({ obligationId: o.id, title: o.title, citation: o.citation, cadence: o.cadence, decidedOn: o.confirmedOn, decidedBy: o.confirmedBy }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Answers one of them.
 *
 * "Yes" counts the duty from the period that holds today rather than from whenever the site was first opened: a duty that has just been
 * confirmed cannot sensibly be counted late for months in which nobody knew it was theirs. "No" records the decision with the day and the
 * person, and stops this duty's own periods being counted anywhere, so the register can show an inspector that it was considered and
 * dismissed on a date rather than simply absent.
 */
export async function answerObligation(
  obligationId: string,
  applies: boolean,
  user: { id: string; name: string },
): Promise<{ title: string; cadence: ObligationCadence }> {
  const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.id, obligationId) });
  if (!o) throw new Error("That duty no longer exists.");
  const today = todayIso();
  await db
    .update(schema.obligations)
    .set({
      needsConfirmation: false,
      active: applies,
      confirmedOn: today,
      confirmedBy: user.name,
      lastNotes: applies
        ? `${user.name} confirmed on ${today} that this applies to this pharmacy.`
        : `${user.name} recorded on ${today} that this does not apply to this pharmacy.`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.obligations.id, obligationId));
  return { title: o.title, cadence: o.cadence };
}

/**
 * When a duty is actually due inside its period.
 *
 * The period end is the fallback and it was being used for everything, which made every annual
 * duty read "due Dec 31" — including the Kansas pharmacy registration, which runs to 30 June, and
 * the DEA registration, which expires on whatever date is printed on the certificate. Both dates
 * are already on file. Showing a date the pharmacist can see is wrong is worse than showing none:
 * it teaches him not to trust the screen.
 *
 * The certificate first, then the rule, then the end of the period. A date read off the
 * pharmacy's own registration beats any general rule about when registrations renew.
 */
function deadlineFor(
  seedKey: string | null,
  periodKey: string,
  pharmacyCredentials: { type: string; expiresOn: string | null; noExpiry: boolean }[],
): string {
  const end = periodEnds(periodKey);
  if (!seedKey) return end;

  const credentialType = RENEWAL_CREDENTIAL[seedKey];
  if (credentialType) {
    // Asked only of a period the certificate on file does not cover, so the latest date on file falls inside it or before it. Inside it,
    // that is the day the renewal is due. Before it, with nothing renewed since, the renewal has been due since that day: a registration
    // that ran out in 2028 does not make a 2029 renewal "due 31 December 2029".
    const runsTo = readRenewal(credentialType, periodKey, pharmacyCredentials).runsTo;
    if (runsTo) return runsTo;
  }

  const seed = OBLIGATION_SEEDS.find((s) => s.key === seedKey);
  if (seed?.fixedDate) {
    return `${periodKey.slice(0, 4)}-${String(seed.fixedDate.month).padStart(2, "0")}-${String(seed.fixedDate.day).padStart(2, "0")}`;
  }
  return end;
}

/**
 * Everything outstanding, worst first.
 *
 * `today` is the pharmacy's own day. Only a test passes another, to put the same rows on a date the clock will not reach for months.
 */
export async function openItems(today: string = todayIso()): Promise<OpenItem[]> {
  await ensureObligations();
  const start = await startedUsingSite();
  const obligations = (await db.query.obligations.findMany()).filter((o) => o.active);
  const completions = await db.query.obligationCompletions.findMany();
  /*
   * The pharmacy's own registrations, so a renewal shows its real date.
   *
   * Null personId means a credential of the pharmacy rather than of a person. These carry the
   * dates printed on the certificates, which is what "when is this due" actually means for a
   * renewal — and which the site was ignoring in favour of the end of the annual period.
   */
  const pharmacyCredentials = (await db.query.credentials.findMany()).filter((c) => !c.personId);

  const out: OpenItem[] = [];

  for (const o of obligations) {
    // Which periods are judged is decided in judged.ts, which the register reads too. A duty still waiting for its yes or no is
    // offered separately, once, and judged for nothing.
    const periods = judgedPeriods(o, start, today);
    if (periods.length === 0) continue;

    const closure = o.seedKey ? CLOSURES[o.seedKey] : undefined;
    const mine = completions.filter((c) => c.obligationId === o.id);
    const witnessCounts = o.kind === "witnessed" && o.seedKey ? await witnessed(o.seedKey, periods, o.cadence) : null;
    const renewalType = o.seedKey ? RENEWAL_CREDENTIAL[o.seedKey] : undefined;

    for (const periodKey of periods) {
      const filed = mine.filter((c) => (c.periodKey ?? periodKeyFor(o.cadence, c.completedOn)) === periodKey).length;
      // A renewal is witnessed by the certificate on file (renewal-cover.ts); every other witnessed duty by its own records.
      const reading = renewalType ? readRenewal(renewalType, periodKey, pharmacyCredentials) : null;
      const seen = reading ? (reading.covered ? 1 : 0) : (witnessCounts?.counts.get(periodKey) ?? 0);
      const have = filed + seen;
      let state = stateOf(have, o.expectedPerPeriod, periodKey, today);
      if (state === "satisfied") continue;

      const dueOn = deadlineFor(o.seedKey, periodKey, pharmacyCredentials);
      // A renewal's own date is the one on the certificate and the year is only where it falls: past that date with nothing renewed it is
      // late, whatever the year still says. Every other duty's date is the end of its period, so this changes nothing for them.
      if (state === "open" && dueOn < today) state = "missed";
      const daysLate = dueOn < today ? Math.round((Date.parse(today) - Date.parse(dueOn)) / 86_400_000) : 0;

      out.push({
        obligationId: o.id,
        seedKey: o.seedKey,
        title: o.title,
        detail: o.detail,
        citation: o.citation,
        kind: o.kind,
        periodKey,
        periodLabel: periodLabel(periodKey),
        dueOn,
        state,
        daysLate,
        have,
        expected: o.expectedPerPeriod,
        minutes: closure?.minutes ?? null,
        statement: o.attestationTemplate ? fill(o.attestationTemplate, periodKey, today) : null,
        missing: witnessCounts?.missing ?? (reading && renewalType ? renewalMissing(CREDENTIAL_LABEL[renewalType], periodKey, reading) : null),
        href: hrefFor(o.seedKey),
      });
    }
  }

  // Missed periods first and oldest first inside that, because the oldest gap is the one an
  // inspector finds. Then whatever is open now.
  const rank: Record<PeriodState, number> = { missed: 0, partial: 1, open: 2, satisfied: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.dueOn.localeCompare(b.dueOn));
}

/**
 * The state of every period still outstanding, keyed "obligationId|periodKey", exactly as the list above decided it. The register reads
 * the cells it shows as still open from here and works none out for itself: a second derivation from the filings alone says "not due yet"
 * about a witnessed period that is part done, and about a renewal this list has already called late.
 */
export function openStates(open: ReadonlyArray<Pick<OpenItem, "obligationId" | "periodKey" | "state">>): Map<string, PeriodState> {
  return new Map(open.map((i) => [`${i.obligationId}|${i.periodKey}`, i.state]));
}

/**
 * The sentence under an item that is open and not yet late, on Today's quiet list. For most duties the date it falls due is the end of the
 * period, so "until the period ends" is true. A renewal falls due on the date the certificate runs to, which comes before its year ends, so
 * the same words would tell him a registration is safe on days it is not; it says what is on file and what to enter instead.
 */
export function comingSentence(i: Pick<OpenItem, "kind" | "periodLabel" | "missing">): string {
  if (i.kind === "renewal" && i.missing) return `${i.periodLabel} — ${i.missing}`;
  return `${i.periodLabel}. Not late, and will not count against you until the period ends.`;
}

function hrefFor(seedKey: string | null): string | null {
  switch (seedKey) {
    case "cs_annual_inventory": return "/inventory";
    case "backup_restore_test": return "/settings/backups";
    case "fwa_training":
    case "hipaa_training":
    case "osha_bloodborne":
    case "osha_hazcom":
    case "cqi_program_document": return "/compliance/training";
    case "immunization_protocol_review": return "/staff";
    case "technician_list": return "/staff/technician-list";
    case "ks_pharmacy_registration":
    case "dea_registration": return "/licenses";
    default: return null;
  }
}

/**
 * Records an attestation.
 *
 * The statement is stored as it was shown, not regenerated later — the record has to be what the
 * PIC actually agreed to, word for word, and a template that changes in a future release must
 * never silently rewrite what someone signed.
 */
/**
 * Records an attestation, signed.
 *
 * It used to store the sentence, the date and the signed-in user's name. That is real evidence and
 * better than a tick in a box, but it was not a signature in the sense the rest of this system
 * means it — no deliberate act, no typed name — which left an attestation weaker than the
 * temperature log sitting beside it. That is the wrong way round: for a duty performed outside
 * this system, the attestation is often the only evidence it was performed at all.
 *
 * So it goes through the same machinery as every other signed record: the box, the typed name, the
 * time, the address, the wording kept word for word. The completion row stays, because the
 * register and the due dates are built on it, and it now points at the signature.
 */
export async function attest(
  obligationId: string,
  periodKey: string,
  statement: string,
  user: { id: string; name: string; role: string },
  signing: { typedName: string; intent: boolean },
): Promise<void> {
  const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.id, obligationId) });
  if (!o) throw new Error("That duty no longer exists.");
  if (!statement.trim()) throw new Error("Nothing was recorded — an attestation with no statement is not evidence.");

  const { signRecord } = await import("./record-signatures");
  const signature = await signRecord(
    {
      kind: "obligation_attestation",
      recordKey: `${obligationId}:${periodKey || todayIso()}`,
      statement: statement.trim(),
      typedName: signing.typedName,
      intent: signing.intent,
      content: statement.trim(),
    },
    user,
  );

  await db.insert(schema.obligationCompletions).values({
    id: newId(),
    obligationId,
    periodKey,
    completedOn: todayIso(),
    completedBy: signature.signedName,
    statement: statement.trim(),
    signatureId: signature.id,
  });
  await db
    .update(schema.obligations)
    .set({ lastCompletedOn: todayIso(), lastCompletedBy: user.name, updatedAt: new Date().toISOString() })
    .where(eq(schema.obligations.id, obligationId));
}

/** What is outstanding. It does not say "clean": that also needs licences and training current, which this does not read. */
export async function complianceSummary(): ReturnType<typeof loadComplianceSummary> {
  const { held } = await import("./held");
  return held("compliance-summary", loadComplianceSummary);
}

async function loadComplianceSummary() {
  const [items, unanswered] = await Promise.all([openItems(), unansweredObligations()]);
  const missed = items.filter((i) => i.state === "missed");
  const partial = items.filter((i) => i.state === "partial");
  const openNow = items.filter((i) => i.state === "open");
  const quick = items.filter((i) => i.kind === "attest" && (i.minutes ?? 99) <= 10);
  return {
    missed,
    partial,
    openNow,
    quick,
    unanswered,
    all: items,
    minutesOutstanding: items.reduce((n, i) => n + (i.minutes ?? 0), 0),
  };
}
