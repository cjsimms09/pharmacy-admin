import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayIso, daysBetween } from "./dates";
import { complianceSummary } from "./compliance-status";
import { staffMatrix } from "./staff-matrix";
import { csInventoryStatus, cqiSnapshot } from "./compliance";
import { registerStatus } from "./business-associates";
import { onSiteToday, rotations } from "./roster";
import { getSettings } from "./settings";
import { periodKeyFor } from "./periods";

/**
 * Could you hand an inspector what they ask for, today?
 *
 * Written against what actually gets asked for on a Kansas Board or DEA visit rather than against
 * the shape of this database. An inspector does not ask "is your obligations table satisfied";
 * they ask to see the registration on the wall, the current technician list, the last controlled
 * substance inventory, the CQI records, the temperature logs, who is licensed, and what training
 * those people have had. Each of those is a question this site can answer or cannot, and saying
 * which is more useful than a score.
 *
 * The verdict is deliberately harsh in one direction: anything that cannot be produced counts as
 * not held. A record that exists but nobody can find during a visit is, on the day, the same as
 * no record — and the whole point of the exercise is to find that out on a quiet afternoon rather
 * than with somebody standing at the counter.
 */

export type CheckState = "ready" | "gap" | "blocking";

export type Check = {
  key: string;
  /** What the inspector asks for, in their words. */
  asks: string;
  /** The rule behind the question. */
  authority: string;
  state: CheckState;
  /** What the site can say about it right now. */
  answer: string;
  /** Where to go and put it right, or to print it. */
  href: string | null;
  printHref?: string | null;
};

export type InspectionReport = {
  takenOn: string;
  pharmacy: { name: string; registration: string | null; dea: string | null; address: string };
  checks: Check[];
  blocking: number;
  gaps: number;
  ready: number;
  verdict: string;
};

export async function inspectionReport(): Promise<InspectionReport> {
  const today = todayIso();
  const [s, compliance, matrix, cs, cqi, baas, onSite, rota, creds, docs, summaries, sensors, incidents] =
    await Promise.all([
      getSettings(),
      complianceSummary(),
      staffMatrix(),
      csInventoryStatus(),
      cqiSnapshot(),
      registerStatus(),
      onSiteToday(),
      rotations(),
      db.query.credentials.findMany(),
      db.query.documents.findMany(),
      db.query.cqiSummaries.findMany(),
      db.query.tempSensors.findMany(),
      db.query.cqiIncidents.findMany(),
    ]);

  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const pharmacyCred = (type: string) => creds.find((c) => !c.personId && c.type === type);
  const expiryState = (iso: string | null | undefined): CheckState => {
    if (!iso) return "gap";
    const d = daysBetween(today, iso);
    return d < 0 ? "blocking" : d <= 45 ? "gap" : "ready";
  };

  // ── The paper on the wall ────────────────────────────────────────
  const reg = pharmacyCred("pharmacy_registration");
  add({
    key: "pharmacy_registration",
    asks: "Your current pharmacy registration",
    authority: "K.S.A. 65-1643 — a pharmacy must be registered, and the certificate displayed.",
    state: s.pharmacy_registration_number ? expiryState(reg?.expiresOn) : "blocking",
    answer: !s.pharmacy_registration_number
      ? "No pharmacy registration number is recorded in Settings at all."
      : reg?.expiresOn
        ? `Registration ${s.pharmacy_registration_number}, current to ${reg.expiresOn}.`
        : `Registration ${s.pharmacy_registration_number} is recorded, but no expiry date is on file so nothing can tell you when it lapses.`,
    href: "/documents",
  });

  const dea = pharmacyCred("dea_registration");
  add({
    key: "dea_registration",
    asks: "Your DEA registration",
    authority: "21 CFR 1301.11 — every person dispensing controlled substances must be registered.",
    state: s.pharmacy_dea ? expiryState(dea?.expiresOn) : "blocking",
    answer: !s.pharmacy_dea
      ? "No DEA number is recorded in Settings."
      : dea?.expiresOn
        ? `${s.pharmacy_dea}, current to ${dea.expiresOn}.`
        : `${s.pharmacy_dea} is recorded, but with no expiry date on file.`,
    href: "/documents",
  });

  // ── The people ───────────────────────────────────────────────────
  const pic = onSite.find((p) => p.isPic);
  add({
    key: "pic",
    asks: "Who is the pharmacist-in-charge",
    authority: "K.A.R. 68-7-25 — every pharmacy must have one, and the Board told of any change.",
    state: pic ? "ready" : "blocking",
    answer: pic ? `${pic.firstName} ${pic.lastName}.` : "Nobody on file is marked as pharmacist-in-charge.",
    href: "/staff",
  });

  const licenceGaps = matrix.rows.filter((r) => r.cells.license.state === "missing" || r.cells.license.state === "late");
  add({
    key: "licences",
    asks: "The licence or registration of everyone working here",
    authority: "K.S.A. 65-1657 and 65-1663 — pharmacists licensed, technicians registered.",
    state: licenceGaps.length > 0 ? "blocking" : "ready",
    answer:
      licenceGaps.length === 0
        ? `All ${matrix.rows.length} people on site hold a current licence or registration.`
        : `${licenceGaps.length} of ${matrix.rows.length} have no current licence on file: ${licenceGaps.map((r) => r.name).join(", ")}.`,
    href: "/staff",
  });

  add({
    key: "technician_list",
    asks: "Your current list of pharmacy technicians",
    authority: "K.S.A. 65-1663(i) — the list must be maintained at all times and available for inspection.",
    state: "ready",
    answer: "Filed automatically at the end of every month and printable on the Board's own form.",
    href: "/staff/technician-list",
    printHref: "/staff/technician-list",
  });

  const studentsHere = rota.filter((r) => r.presence === "here");
  if (studentsHere.length > 0) {
    const notCleared = studentsHere.filter((r) => !r.ready);
    add({
      key: "rotations",
      asks: "Who these students are and what you hold on them",
      authority: "K.A.R. 68-5-13 — intern registration; the affiliation agreement for the rest.",
      state: notCleared.length > 0 ? "blocking" : "ready",
      answer:
        notCleared.length === 0
          ? `${studentsHere.length} student${studentsHere.length === 1 ? "" : "s"} on site, everything on file.`
          : `${notCleared.length} on site without a complete file: ${notCleared.map((r) => `${r.name} (${r.missing.join(", ")})`).join("; ")}.`,
      href: "/staff/rotations",
    });
  }

  // ── Training ─────────────────────────────────────────────────────
  const trainingGaps = matrix.rows.reduce(
    (n, r) => n + ["hipaa", "fwa", "bbp", "hazcom"].filter((k) => r.cells[k]?.state === "missing" || r.cells[k]?.state === "late").length,
    0,
  );
  add({
    key: "training",
    asks: "Proof your staff are trained — HIPAA, fraud and abuse, bloodborne, hazard communication",
    authority: "45 CFR 164.530(b); 42 CFR 423.504(b)(4)(vi); 29 CFR 1910.1030(g)(2); 29 CFR 1910.1200(h).",
    state: trainingGaps === 0 ? "ready" : trainingGaps > matrix.rows.length ? "blocking" : "gap",
    answer:
      trainingGaps === 0
        ? "Everyone on site is current on all four, each with a signed certificate behind it."
        : `${trainingGaps} training record${trainingGaps === 1 ? " is" : "s are"} missing or lapsed across the people on site.`,
    href: "/compliance/training",
    printHref: "/compliance/training/records",
  });

  // ── Controlled substances ────────────────────────────────────────
  const csDays = cs.dueOn ? daysBetween(today, cs.dueOn) : null;
  add({
    key: "cs_inventory",
    asks: "Your most recent controlled substance inventory",
    authority: "21 CFR 1304.11 — a complete inventory every two years; Kansas expects annual.",
    state: !cs.last ? "blocking" : csDays !== null && csDays < 0 ? "blocking" : "ready",
    answer: cs.last
      ? `Last taken ${cs.last}${csDays !== null && csDays < 0 ? ` — ${-csDays} days past due` : ""}.`
      : "No controlled substance inventory has ever been recorded here.",
    href: "/inventory",
    printHref: "/inventory",
  });

  const ktracs = compliance.all.find((i) => i.seedKey === "ktracs_submission_check" && i.state === "missed");
  add({
    key: "ktracs",
    asks: "That your controlled substance dispensings are reaching K-TRACS",
    authority: "K.S.A. 65-1683 — submission to the prescription monitoring programme.",
    state: ktracs ? "gap" : "ready",
    answer: ktracs
      ? `The submission check for ${ktracs.periodLabel} has not been recorded.`
      : "Checked and recorded for every period that has ended.",
    href: "/compliance",
  });

  // ── CQI ──────────────────────────────────────────────────────────
  const finalSummaries = summaries.filter((x) => x.status === "final").length;
  add({
    key: "cqi",
    asks: "Your continuous quality improvement records",
    authority: "K.A.R. 68-19-1 — a CQI programme, reviews within 7 and 30 days, summaries every two months, kept five years.",
    state: finalSummaries === 0 ? "gap" : cqi.status === "final" ? "ready" : "gap",
    answer:
      finalSummaries === 0
        ? `No summary has been finalised yet. ${incidents.length} incident${incidents.length === 1 ? "" : "s"} logged.`
        : `${finalSummaries} finalised summar${finalSummaries === 1 ? "y" : "ies"} on file. Current period ${cqi.label} is ${cqi.status}.`,
    href: "/cqi",
    printHref: cqi.summaryId ? `/cqi/summaries/${cqi.summaryId}` : "/cqi",
  });

  // ── Storage ──────────────────────────────────────────────────────
  const tracked = sensors.filter((x) => x.tracked);
  const tempItem = compliance.all.find((i) => i.seedKey === "temperature_logs" && (i.state === "missed" || i.state === "partial"));
  add({
    key: "temperatures",
    asks: "Your refrigerator and room temperature logs",
    authority: "CDC Vaccine Storage and Handling Toolkit; USP 1079 for drug storage generally.",
    state: tracked.length === 0 ? "gap" : tempItem ? "gap" : "ready",
    answer:
      tracked.length === 0
        ? "No sensors are being logged, so there are no temperature records to produce."
        : tempItem
          ? `${tracked.length} sensor${tracked.length === 1 ? "" : "s"} logging, but ${tempItem.periodLabel} is not complete — readings, an explanation against every excursion, and the month signed off.`
          : `${tracked.length} sensor${tracked.length === 1 ? "" : "s"} logging, every month complete and signed off.`,
    href: "/temps",
    printHref: "/temps",
  });

  // ── Privacy ──────────────────────────────────────────────────────
  add({
    key: "baa",
    asks: "Your business associate agreements",
    authority: "45 CFR 164.502(e) — an agreement with every vendor that handles protected health information.",
    state: baas.total === 0 ? "gap" : baas.problems > 0 ? "gap" : "ready",
    answer: baas.summary,
    href: "/agreements",
  });

  const npp = docs.find((d) => d.category === "policy" && /privacy practices/i.test(d.title));
  add({
    key: "npp",
    asks: "Your Notice of Privacy Practices",
    authority: "45 CFR 164.520 — the notice must be provided and posted.",
    state: npp ? "ready" : "gap",
    answer: npp ? `On file as "${npp.title}".` : "No Notice of Privacy Practices is filed under Documents.",
    href: "/documents",
  });

  // ── Everything the register says is outstanding ───────────────────
  const missed = compliance.missed.length;
  add({
    key: "register",
    asks: "Anything else on your compliance calendar",
    authority: "The pharmacy's own register of standing duties.",
    state: missed === 0 ? "ready" : missed > 3 ? "blocking" : "gap",
    answer:
      missed === 0
        ? "Every period that has ended is covered."
        : `${missed} period${missed === 1 ? "" : "s"} went by without being covered. Those are what an inspector finds.`,
    href: "/compliance",
    printHref: "/compliance/attestations",
  });

  const blocking = checks.filter((c) => c.state === "blocking").length;
  const gaps = checks.filter((c) => c.state === "gap").length;
  const ready = checks.filter((c) => c.state === "ready").length;

  return {
    takenOn: today,
    pharmacy: {
      name: s.pharmacy_name || "This pharmacy",
      registration: s.pharmacy_registration_number || null,
      dea: s.pharmacy_dea || null,
      address: [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
        .filter(Boolean)
        .join(" · "),
    },
    checks,
    blocking,
    gaps,
    ready,
    verdict:
      blocking > 0
        ? `${blocking} thing${blocking === 1 ? "" : "s"} would be a finding today. Fix those first — everything else is presentation.`
        : gaps > 0
          ? `Nothing here would be a finding, but ${gaps} answer${gaps === 1 ? " is" : "s are"} weaker than it needs to be.`
          : "Everything an inspector routinely asks for can be produced from this site today.",
  };
}

/** Kept for the register print, so the two agree on what a period is. */
export const currentPeriodKey = (cadence: "monthly" | "quarterly" | "annual") => periodKeyFor(cadence, todayIso());
