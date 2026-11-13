import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { todayIso } from "@/lib/dates";
import { routeOf, countable } from "@/lib/page-visits";

/**
 * One visit to an old page, counted. Signed-in only, the path normalised to its route (page-visits.ts), nothing
 * stored but the day, the path and a count. See drizzle/0137_page_visits.sql.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 204 });
  let path = "";
  try {
    const body = (await req.json()) as { path?: unknown };
    path = typeof body.path === "string" ? body.path : "";
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (!countable(path)) return new NextResponse(null, { status: 204 });
  const route = routeOf(path);
  const now = new Date().toISOString();
  await db.run(sql`insert into page_visits (day, path, count, last_at) values (${todayIso()}, ${route}, 1, ${now}) on conflict (day, path) do update set count = count + 1, last_at = ${now}`);
  return new NextResponse(null, { status: 204 });
}
