import "server-only";
import { db, schema } from "@/db";
import { newId } from "./crypto";

export async function audit(e: {
  action: string;
  userId?: string | null;
  userName?: string | null;
  entity?: string;
  entityId?: string;
  details?: string;
}) {
  await db.insert(schema.auditEvents).values({
    id: newId(),
    userId: e.userId ?? null,
    userName: e.userName ?? null,
    action: e.action,
    entity: e.entity ?? null,
    entityId: e.entityId ?? null,
    details: e.details ?? null,
  });

  /*
   * And the held readings are told the tables have moved.
   *
   * `held()` keys every cached reading on a fingerprint of the tables, and the newest audit event is
   * one of its terms — so writing this row is exactly what should make a stale reading recompute.
   * But `fingerprint()` caches itself for two seconds, and an action writes, redirects and
   * re-renders well inside two seconds. The page therefore came back built from the fingerprint
   * taken *before* this insert, found its cached value unchanged, and served it.
   *
   * The owner met it as "im also hitting record on some of them and nothing is happening, they
   * arent going away" — on fifteen presses that had every one been recorded.
   *
   * Here rather than at each call site because every action that changes anything writes an audit
   * row, which makes this the one place the next action somebody adds cannot forget.
   */
  const { forgetFingerprint } = await import("./held");
  forgetFingerprint();
}
