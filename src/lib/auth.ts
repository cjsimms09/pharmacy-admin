import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq, and, gt, like, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, dbReady, schema } from "@/db";
import { newId, randomToken } from "./crypto";
import { audit } from "./audit";
import { loginAllowed, WINDOW_MINUTES } from "./login-throttle";

const COOKIE = "pa_session";
const SESSION_HOURS = 8;

export type Role = "owner" | "pic" | "staff";
export type CurrentUser = { id: string; name: string; username: string; role: Role; personId: string | null };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  await dbReady;
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
  await dbReady;
  const name = username.trim().toLowerCase();

  /*
   * Guessing has to be expensive, and the audit log already knows how often it has been tried.
   *
   * Counting from the log rather than from memory means the limit survives a restart — otherwise
   * the way past it is to wait for the nightly reboot — and it needs no new table. bcrypt at cost
   * 12 already makes each attempt cost a quarter of a second; this makes the sixth cost fifteen
   * minutes.
   */
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const recent = await db
    .select({ at: schema.auditEvents.at, action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(and(gt(schema.auditEvents.at, since), inArray(schema.auditEvents.action, ["login.failed", "login.success"]), like(schema.auditEvents.details, `username=${name}%`)));
  const verdict = loginAllowed(recent.map((r) => ({ at: r.at, ok: r.action === "login.success" })));
  if (!verdict.allowed) {
    await audit({ action: "login.blocked", details: `username=${name} waitMinutes=${verdict.waitMinutes}` });
    return { ok: false, error: verdict.says };
  }

  const user = await db.query.users.findFirst({ where: eq(schema.users.username, name) });
  const hash = user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok || !user.active) {
    await audit({ action: "login.failed", details: `username=${name}` });
    return { ok: false, error: "Incorrect username or password." };
  }
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  await db.insert(schema.sessions).values({ id: token, userId: user.id, expiresAt: expires.toISOString() });
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    // Local-first deployment is served over plain HTTP on the pharmacy LAN; set COOKIE_SECURE=1 once behind HTTPS.
    secure: process.env.COOKIE_SECURE === "1",
    path: "/",
    expires,
  });
  // The username is in the details so the throttle above can see that this account got in.
  await audit({ action: "login.success", userId: user.id, userName: user.name, details: `username=${name}` });
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
