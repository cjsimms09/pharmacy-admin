import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { ensureObligations, CLOSURES } from "./obligations";
import { periodsBetween, periodKeyFor, periodLabel, periodEnds, stateOf, type PeriodState } from "./periods";
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
async function startedUsingSite(): Promise<string> {
  const [o] = await db.select({ at: schema.obligations.createdAt }).from(schema.obligations).limit(1);
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
    case "backup_restore_test": {
      const s = await db.query.settings.findFirst({ where: eq(schema.settings.key, "backup_last_run") });
      bump(s?.value ?? null);
      return { counts, missing: "No verified backup has been taken in this period." };
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
      const people = await db.query.people.findMany({ where: eq(schema.people.active, true) });
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
      const people = await db.query.people.findMany({ where: eq(schema.people.active, true) });
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

/** Everything outstanding, worst first. */
export async function openItems(): Promise<OpenItem[]> {
  await ensureObligations();
  const today = todayIso();
  const start = await startedUsingSite();
  const obligations = (await db.query.obligations.findMany()).filter((o) => o.active);
  const completions = await db.query.obligationCompletions.findMany();

  const out: OpenItem[] = [];

  for (const o of obligations) {
    if (o.cadence === "as_needed") continue;
    const periods = periodsBetween(o.cadence, start, today);
    if (periods.length === 0) continue;

    const closure = o.seedKey ? CLOSURES[o.seedKey] : undefined;
    const mine = completions.filter((c) => c.obligationId === o.id);
    const witnessCounts = o.kind === "witnessed" && o.seedKey ? await witnessed(o.seedKey, periods, o.cadence) : null;

    for (const periodKey of periods) {
      const filed = mine.filter((c) => (c.periodKey ?? periodKeyFor(o.cadence, c.completedOn)) === periodKey).length;
      const seen = witnessCounts?.counts.get(periodKey) ?? 0;
      const have = filed + seen;
      const state = stateOf(have, o.expectedPerPeriod, periodKey, today);
      if (state === "satisfied") continue;

      const dueOn = periodEnds(periodKey);
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
        missing: witnessCounts?.missing ?? null,
        href: hrefFor(o.seedKey),
      });
    }
  }

  // Missed periods first and oldest first inside that, because the oldest gap is the one an
  // inspector finds. Then whatever is open now.
  const rank: Record<PeriodState, number> = { missed: 0, partial: 1, open: 2, satisfied: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.dueOn.localeCompare(b.dueOn));
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
export async function attest(
  obligationId: string,
  periodKey: string,
  statement: string,
  user: { id: string; name: string },
): Promise<void> {
  const o = await db.query.obligations.findFirst({ where: eq(schema.obligations.id, obligationId) });
  if (!o) throw new Error("That duty no longer exists.");
  if (!statement.trim()) throw new Error("Nothing was recorded — an attestation with no statement is not evidence.");

  await db.insert(schema.obligationCompletions).values({
    id: newId(),
    obligationId,
    periodKey,
    completedOn: todayIso(),
    completedBy: user.name,
    statement: statement.trim(),
  });
  await db
    .update(schema.obligations)
    .set({ lastCompletedOn: todayIso(), lastCompletedBy: user.name, updatedAt: new Date().toISOString() })
    .where(eq(schema.obligations.id, obligationId));
}

/** The one-line answer: is the pharmacy clean, and if not, by how much. */
export async function complianceSummary() {
  const items = await openItems();
  const missed = items.filter((i) => i.state === "missed");
  const partial = items.filter((i) => i.state === "partial");
  const openNow = items.filter((i) => i.state === "open");
  const quick = items.filter((i) => i.kind === "attest" && (i.minutes ?? 99) <= 10);
  return {
    clean: missed.length === 0 && partial.length === 0,
    missed,
    partial,
    openNow,
    quick,
    all: items,
    minutesOutstanding: items.reduce((n, i) => n + (i.minutes ?? 0), 0),
  };
}
