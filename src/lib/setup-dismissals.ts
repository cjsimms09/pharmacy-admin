import "server-only";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { audit } from "./audit";

/**
 * The setup-list items this pharmacy has said do not apply to it.
 *
 * The owner, 16 September 2026, pasting forty-five of them: "these are all irrelevant, i dont have
 * them or they arent relevant, need system to leave me alone about them".
 *
 * Each item on that list ends "something is wrong until this is done", which is true of a missing
 * order minimum and false of an order minimum for a wholesaler he has never bought from. With no
 * way to say the second, the list could only grow — and the real cost is not the noise but that a
 * list nobody reads takes the items that do stop something down with it.
 *
 * Three rules, all of them the same rule from clause 4:
 *
 *   **Recorded, not hidden.** The page keeps the count and every dismissal is one press from
 *     coming back. A decision that cannot be undone is worse than the nagging it replaced.
 *   **Reasons, not silence.** Optional, because a reason nobody has to give is a reason given
 *     honestly — but kept when given, because "why did we decide this does not apply" is the
 *     question somebody asks in eleven months.
 *   **Keyed by the item, not by a row.** The items are rebuilt from the data every time the page
 *     opens. Keying on the item's own key is what makes an answer survive the next import.
 *
 * What it deliberately does not do is decide anything on his behalf. A dismissed rebate ladder is
 * not a claim that the wholesaler has no ladder, and nothing that prices an order reads this table.
 */

export type Dismissal = { key: string; reason: string; at: string; by: string };

/** Every item set aside, by key. Small, and read on every page load rather than cached. */
export async function dismissals(): Promise<Map<string, Dismissal>> {
  const rows = await db.query.setupDismissals.findMany();
  return new Map(
    rows.map((r) => [r.key, { key: r.key, reason: r.reason ?? "", at: r.dismissedAt, by: r.dismissedBy }]),
  );
}

/**
 * Sets one or more items aside.
 *
 * Takes a list because the shape of the complaint is a list: eleven order minimums, fourteen rebate
 * ladders and eighteen price files, most of them the same three questions asked about the same
 * wholesaler. Making him press "not applicable" forty-five times would be answering the letter of
 * what he asked for and none of it.
 */
export async function dismiss(
  keys: string[],
  reason: string,
  user: { id: string; name: string },
): Promise<{ set: number }> {
  const wanted = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  if (wanted.length === 0) return { set: 0 };

  for (const key of wanted) {
    await db
      .insert(schema.setupDismissals)
      .values({ key, reason: reason.trim() || null, dismissedBy: user.name })
      .onConflictDoUpdate({
        target: schema.setupDismissals.key,
        set: { reason: reason.trim() || null, dismissedBy: user.name },
      });
  }

  await audit({
    action: "setup.dismiss",
    userId: user.id,
    userName: user.name,
    details: `${wanted.length} item${wanted.length === 1 ? "" : "s"} set aside${reason.trim() ? `: ${reason.trim()}` : ""} — ${wanted.join(", ")}`,
  });
  return { set: wanted.length };
}

/** Puts items back on the list. The undo half, without which the above should not exist. */
export async function restore(keys: string[], user: { id: string; name: string }): Promise<{ restored: number }> {
  const wanted = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  if (wanted.length === 0) return { restored: 0 };

  await db.delete(schema.setupDismissals).where(
    wanted.length === 1 ? eq(schema.setupDismissals.key, wanted[0]) : inArray(schema.setupDismissals.key, wanted),
  );
  await audit({
    action: "setup.restore",
    userId: user.id,
    userName: user.name,
    details: `${wanted.length} item${wanted.length === 1 ? "" : "s"} put back — ${wanted.join(", ")}`,
  });
  return { restored: wanted.length };
}
