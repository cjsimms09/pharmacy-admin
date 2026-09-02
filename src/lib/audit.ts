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
}
