import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq, and, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, schema } from "@/db";
import { newId, randomToken } from "./crypto";
import { audit } from "./audit";

const COOKIE = "pa_session";
const SESSION_HOURS = 8;

export type Role = "owner" | "pic" | "staff";
export type CurrentUser = { id: string; name: string; username: string; role: Role; personId: string | null };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  const nowIso = new Date().toISOString();
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      username: schema.users.username,
      role: schema.users.role,
      personId: schema.users.personId,
      active: schema.users.active,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.id, token), gt(schema.sessions.expiresAt, nowIso)))
    .limit(1);
  const u = rows[0];
  if (!u || !u.active) return null;
  return { id: u.id, name: u.name, username: u.username, role: u.role as Role, personId: u.personId };
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  return u;
}

/** Owner and PIC can manage everything; staff can only view their own record. */
export async function requireManager(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== "owner" && u.role !== "pic") redirect("/");
  return u;
}

export async function login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.username, username.trim().toLowerCase()) });
  const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok || !user.active) {
    await audit({ action: "login.failed", details: `username=${username.trim().toLowerCase()}` });
    return { ok: false, error: "Incorrect username or password." };
  }
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  await db.insert(schema.sessions).values({ id: token, userId: user.id, expiresAt: expires.toISOString() });
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    path: "/",
    expires,
  });
  await audit({ action: "login.success", userId: user.id, userName: user.name });
  return { ok: true };
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, token));
    jar.delete(COOKIE);
  }
}

export async function createUser(input: { name: string; username: string; password: string; role: Role; personId?: string | null }) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  const id = newId();
  await db.insert(schema.users).values({
    id,
    name: input.name,
    username: input.username.trim().toLowerCase(),
    passwordHash,
    role: input.role,
    personId: input.personId ?? null,
  });
  return id;
}
