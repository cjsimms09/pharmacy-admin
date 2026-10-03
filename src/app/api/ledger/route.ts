import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { parsePeriod, statementRows, toCsv } from "@/lib/ledger";
import { booksFor } from "@/lib/ledger-store";

export const dynamic = "force-dynamic";

/**
 * The statement as a file a spreadsheet opens.
 *
 * `?period=2026-Q3&basis=cash`. One row per line with its group, cents and note, then a row per
 * month of what was missing, so the file says what the screen says. Behind the login, and logged,
 * like every export.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const p = req.nextUrl.searchParams;
  const period = parsePeriod(p.get("period") ?? "");
  if (!period) return NextResponse.json({ error: "period must be a month (2026-09), a quarter (2026-Q3) or a year (2026)" }, { status: 400 });
  const basis = p.get("basis") === "cash" ? "cash" : "accrual";
  const books = await booksFor(period);
  const pl = basis === "cash" ? books.cash : books.accrual;
  const rows = statementRows(pl).map((r) => ({ period: period.key, basis, group: r.group, line: r.label, dollars: (r.cents / 100).toFixed(2), note: r.note }));
  for (const m of pl.months) for (const s of m.missing) rows.push({ period: m.month, basis, group: "Missing", line: s, dollars: "", note: "" });
  rows.push({ period: period.key, basis, group: "Scripts", line: "Scripts", dollars: String(books.scripts.scripts), note: `${books.scripts.cash} cash` });

  await audit({ action: "ledger.export", userId: user.id, userName: user.name, entity: "period", entityId: period.key, details: `${basis} statement for ${period.label} as CSV` });
  return new NextResponse(toCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="statement-${period.key}-${basis}.csv"`,
      "cache-control": "no-store",
    },
  });
}
