import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Every expectation, judged once and kept, so Today reads a row and not a calendar.
 *
 * expected.ts already knows the cadence of everything the pharmacy waits on and judges each against its own
 * calendar. The old site judged on every open of the page; this writes the judgement when the engine runs and
 * the page reads it. The states are expected.ts's and none of them is "missing".
 */
export async function writeFeedState(now: string, today = now.slice(0, 10)): Promise<{ judged: number; overdue: number; never: number }> {
  const { expectedNow } = await import("../expected-store");
  const { cadenceWords } = await import("../expected");
  const e = await expectedNow({ today });
  let overdue = 0;
  let never = 0;
  for (const j of e.rows) {
    if (j.state === "overdue") overdue++;
    if (j.state === "never_arrived") never++;
    const values = {
      name: j.label,
      state: j.state,
      cadence: cadenceWords(j.using),
      lastDue: j.dueOn,
      nextDue: j.nextDueOn,
      lastArrived: (j as { lastArrivedOn?: string | null }).lastArrivedOn ?? null,
      says: j.says,
      judgedAt: now,
    };
    const held = await db.query.feedState.findFirst({ where: eq(schema.feedState.key, j.key), columns: { key: true } });
    if (held) await db.update(schema.feedState).set(values).where(eq(schema.feedState.key, j.key));
    else await db.insert(schema.feedState).values({ key: j.key, ...values });
  }
  return { judged: e.rows.length, overdue, never };
}
