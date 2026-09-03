import "server-only";
import { eq, and } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { getSettings } from "./settings";

/**
 * The technician list, generated and filed rather than asked for.
 *
 * The PIC has to be able to produce a current list of every registered technician on inspection.
 * The site already knows every technician and their registration number, so asking somebody to
 * remember to print one each month is asking them to do work the software could do — and it is
 * the kind of task that gets skipped for eleven months and then reconstructed badly.
 *
 * So a snapshot is taken automatically for each month and kept. It records who was on staff and
 * what their registration said at that moment, which is the thing an inspection actually asks
 * about: not who works here now, but who worked here then.
 */

export type TechnicianRow = {
  name: string;
  role: string;
  registrationNumber: string | null;
  expiresOn: string | null;
  hiredOn: string | null;
  endedOn: string | null;
};

export type TechnicianSnapshot = {
  periodKey: string;
  takenOn: string;
  pharmacyName: string;
  pharmacyRegistration: string | null;
  pic: string | null;
  technicians: TechnicianRow[];
};

/** Who counted as staff during a given month, and what their registration said. */
export async function buildSnapshot(periodKey: string): Promise<TechnicianSnapshot> {
  const [people, creds, s] = await Promise.all([
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName)] }),
    db.query.credentials.findMany(),
    getSettings(),
  ]);

  const monthEnd = `${periodKey}-31`;
  const monthStart = `${periodKey}-01`;

  const technicians = people
    // Anyone employed at any point during the month, whether or not they still are. A list that
    // silently drops last month's leaver is not a record of last month.
    .filter((p) => ["technician", "intern"].includes(p.role))
    .filter((p) => (!p.hiredOn || p.hiredOn <= monthEnd) && (!p.endedOn || p.endedOn >= monthStart))
    .map((p) => {
      const reg = creds
        .filter((c) => c.personId === p.id && (c.type === "technician_registration" || c.type === "intern_registration"))
        .sort((a, b) => (b.expiresOn ?? "").localeCompare(a.expiresOn ?? ""))[0];
      return {
        name: `${p.firstName} ${p.lastName}`,
        role: p.role,
        registrationNumber: reg?.number ?? null,
        expiresOn: reg?.expiresOn ?? null,
        hiredOn: p.hiredOn ?? null,
        endedOn: p.endedOn ?? null,
      };
    });

  const pic = people.find((p) => p.isPic);
  return {
    periodKey,
    takenOn: todayIso(),
    pharmacyName: s.pharmacy_name || "",
    pharmacyRegistration: s.pharmacy_registration_number || null,
    pic: pic ? `${pic.firstName} ${pic.lastName}` : null,
    technicians,
  };
}

/**
 * Files the snapshot for a month, if it has not been filed already.
 *
 * Stored as the completion's own statement rather than as an uploaded file: it is generated from
 * records the site holds, so keeping the data means it can always be re-rendered, and there is no
 * file to lose.
 */
export async function fileSnapshot(periodKey: string, by = "Filed automatically"): Promise<{ filed: boolean; technicians: number }> {
  const obligation = await db.query.obligations.findFirst({ where: eq(schema.obligations.seedKey, "technician_list") });
  if (!obligation) return { filed: false, technicians: 0 };

  const already = await db.query.obligationCompletions.findFirst({
    where: and(eq(schema.obligationCompletions.obligationId, obligation.id), eq(schema.obligationCompletions.periodKey, periodKey)),
  });
  if (already) return { filed: false, technicians: 0 };

  const snap = await buildSnapshot(periodKey);
  await db.insert(schema.obligationCompletions).values({
    id: newId(),
    obligationId: obligation.id,
    periodKey,
    completedOn: todayIso(),
    completedBy: by,
    statement:
      `Technician list for ${periodKey}: ${snap.technicians.length} registered technician${snap.technicians.length === 1 ? "" : "s"} ` +
      `on staff. ${snap.technicians.map((t) => `${t.name}${t.registrationNumber ? ` (${t.registrationNumber})` : " — no registration number recorded"}`).join("; ") || "None."}`,
    notes: JSON.stringify(snap),
  });
  return { filed: true, technicians: snap.technicians.length };
}

/**
 * Catches up every month that has passed without a list.
 *
 * Runs on the background timer. Only whole months are filed — the current one is still changing,
 * and a list dated the third of the month is not a list for that month.
 */
export async function fileDueSnapshots(): Promise<{ filed: string[] }> {
  const obligation = await db.query.obligations.findFirst({ where: eq(schema.obligations.seedKey, "technician_list") });
  if (!obligation) return { filed: [] };

  const start = (obligation.createdAt ?? new Date().toISOString()).slice(0, 7);
  const now = new Date();
  const filed: string[] = [];

  for (let back = 1; back <= 24; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (key < start) break;
    const r = await fileSnapshot(key);
    if (r.filed) filed.push(key);
  }
  return { filed };
}

/** A filed snapshot, for printing. */
export async function snapshotFor(periodKey: string): Promise<TechnicianSnapshot | null> {
  const obligation = await db.query.obligations.findFirst({ where: eq(schema.obligations.seedKey, "technician_list") });
  if (!obligation) return null;
  const row = await db.query.obligationCompletions.findFirst({
    where: and(eq(schema.obligationCompletions.obligationId, obligation.id), eq(schema.obligationCompletions.periodKey, periodKey)),
  });
  if (!row?.notes) return null;
  try {
    return JSON.parse(row.notes) as TechnicianSnapshot;
  } catch {
    return null;
  }
}
