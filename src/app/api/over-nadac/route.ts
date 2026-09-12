import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { toCsv } from "@/lib/ledger";
import { overNadacRows } from "@/lib/over-nadac";
import { overNadacNow } from "@/lib/over-nadac-store";

export const dynamic = "force-dynamic";

/** The over-NADAC list as a file for the buying group: `?days=7`. Behind the login, and logged. */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const days = [7, 28, 90].find((d) => String(d) === req.nextUrl.searchParams.get("days")) ?? 7;
  const o = await overNadacNow(days);
  const rows = overNadacRows(o);
  await audit({ action: "over_nadac.export", userId: user.id, userName: user.name, entity: "window", entityId: `${o.from}..${o.to}`, details: `${rows.length} NDCs over NADAC, ${days} days, as CSV` });
  const body = rows.length ? toCsv(rows) : `"Nothing bought over NADAC","${o.from} to ${o.to}"\r\n`;
  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="over-nadac-${o.from}-to-${o.to}.csv"`,
      "cache-control": "no-store",
    },
  });
}
