import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { addDays, daysUntil, nextCqiPeriod, todayIso } from "./dates";
import { CREDENTIAL_LABEL } from "./labels";

export type Alert = {
  level: "crit" | "warn" | "info";
  title: string;
  detail: string;
  href: string;
  dueOn?: string;
};

/** Everything the dashboard needs, computed fresh each request (small data set). */
export async function computeAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const today = todayIso();

  // Credential expirations (people and pharmacy-level)
  const creds = await db
    .select({
      id: schema.credentials.id,
      type: schema.credentials.type,
      label: schema.credentials.label,
      expiresOn: schema.credentials.expiresOn,
      personId: schema.credentials.personId,
      firstName: schema.people.firstName,
      lastName: schema.people.lastName,
      active: schema.people.active,
    })
    .from(schema.credentials)
    .leftJoin(schema.people, eq(schema.credentials.personId, schema.people.id))
    .where(isNotNull(schema.credentials.expiresOn));

  for (const c of creds) {
    if (c.personId && c.active === false) continue;
    const d = daysUntil(c.expiresOn);
    if (d === null || d > 90) continue;
    const who = c.personId ? `${c.firstName} ${c.lastName}` : "Pharmacy";
    const what = c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type];
    const href = c.personId ? `/staff/${c.personId}` : "/documents";
    if (d < 0) alerts.push({ level: "crit", title: `${what} expired`, detail: `${who} · expired ${-d} day${-d === 1 ? "" : "s"} ago`, href, dueOn: c.expiresOn! });
    else if (d <= 30) alerts.push({ level: "crit", title: `${what} expires in ${d} day${d === 1 ? "" : "s"}`, detail: who, href, dueOn: c.expiresOn! });
    else alerts.push({ level: "warn", title: `${what} expires in ${d} days`, detail: who, href, dueOn: c.expiresOn! });
  }

  // Vaccinators without a current CPR card or immunization training
  const vaccinators = await db.query.people.findMany({ where: and(eq(schema.people.administersVaccines, true), eq(schema.people.active, true)) });
  for (const p of vaccinators) {
    const pc = creds.filter((c) => c.personId === p.id);
    const cpr = pc.find((c) => c.type === "cpr" && (daysUntil(c.expiresOn) ?? -1) >= 0);
    const imm = pc.find((c) => c.type === "immunization_training");
    if (!cpr) alerts.push({ level: "crit", title: "No current CPR card on file", detail: `${p.firstName} ${p.lastName} administers vaccines (K.S.A. 65-1635a)`, href: `/staff/${p.id}` });
    if (!imm) alerts.push({ level: "warn", title: "No immunization training on file", detail: `${p.firstName} ${p.lastName} administers vaccines`, href: `/staff/${p.id}` });
  }

  // CQI summary due
  const period = nextCqiPeriod(today);
  const existing = await db.query.cqiSummaries.findFirst({ where: eq(schema.cqiSummaries.periodStart, period.periodStart) });
  const d = daysUntil(period.dueOn)!;
  if (!existing || existing.status !== "final") {
    const level = d < 0 ? "crit" : d <= 14 ? "warn" : "info";
    alerts.push({
      level,
      title: existing ? `CQI summary for ${period.label} is still a draft` : `CQI summary for ${period.label} not started`,
      detail: d < 0 ? `Was due ${-d} day${-d === 1 ? "" : "s"} ago (K.A.R. 68-19-1)` : `Due in ${d} day${d === 1 ? "" : "s"} (by the 15th)`,
      href: existing ? `/cqi/summaries/${existing.id}` : `/cqi/summaries/new?period=${period.periodStart}`,
      dueOn: period.dueOn,
    });
  }

  // Incident review clocks: start within 7 days, complete within 30 days of report creation
  const incidents = await db.query.cqiIncidents.findMany();
  for (const i of incidents) {
    const startDue = addDays(i.reportCreatedOn, 7);
    const completeDue = addDays(i.reportCreatedOn, 30);
    if (!i.reviewStartedOn) {
      const dd = daysUntil(startDue)!;
      alerts.push({ level: dd < 0 ? "crit" : "warn", title: `Incident #${i.incidentNumber}: review not started`, detail: dd < 0 ? `7-day window passed ${-dd} day(s) ago` : `Must start within ${dd} day(s)`, href: `/cqi/incidents/${i.id}`, dueOn: startDue });
    }
    if (!i.reviewCompletedOn) {
      const dd = daysUntil(completeDue)!;
      if (dd <= 10) alerts.push({ level: dd < 0 ? "crit" : "warn", title: `Incident #${i.incidentNumber}: review not completed`, detail: dd < 0 ? `30-day window passed ${-dd} day(s) ago` : `Complete within ${dd} day(s)`, href: `/cqi/incidents/${i.id}`, dueOn: completeDue });
    }
  }

  // Controlled substance inventory: Kansas annual, no later than 375 days after the previous one.
  const invs = await db.query.csInventories.findMany({ orderBy: (i, { desc }) => [desc(i.inventoryDate)] });
  const last = invs[0];
  if (!last) {
    alerts.push({ level: "warn", title: "No controlled substance inventory on file", detail: "Record the most recent annual inventory so the 375-day deadline can be tracked (K.A.R. 68-20-16)", href: "/inventory" });
  } else {
    const due = addDays(last.inventoryDate, 375);
    const dd = daysUntil(due)!;
    if (dd < 0) alerts.push({ level: "crit", title: "Controlled substance inventory overdue", detail: `375 days since ${last.inventoryDate} passed ${-dd} day(s) ago`, href: "/inventory", dueOn: due });
    else if (dd <= 60) alerts.push({ level: dd <= 30 ? "crit" : "warn", title: `Annual controlled substance inventory due in ${dd} days`, detail: `Last taken ${last.inventoryDate}; print the C-250 cover sheet from CS inventories`, href: "/inventory", dueOn: due });
  }

  const rank = { crit: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => rank[a.level] - rank[b.level] || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
  return alerts;
}

/** CE status for a person over the current renewal period. Returns null when the person has no license/registration on file. */
export function ceRequirement(role: string): { hours: number; label: string; cycleEnd: (expiresOn: string) => string } | null {
  if (role === "pharmacist") return { hours: 30, label: "30 hours per biennium incl. 1-hour Board course", cycleEnd: (e) => e };
  if (role === "technician") return { hours: 20, label: "20 hours per two-year period (Nov 1 – Oct 31)", cycleEnd: (e) => e };
  return null;
}
