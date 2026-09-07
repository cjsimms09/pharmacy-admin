import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse, after } from "next/server";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { backupStatus } from "@/lib/backup";

export const dynamic = "force-dynamic";

/**
 * Hands over a copy that has already been made.
 *
 * It does not make one. Making it takes a minute or two and a browser shows nothing at all for the
 * whole of it, which is exactly how the first version of this ended up being reported as a button
 * that does nothing. So the making is a press on the page, with an answer; this only serves the
 * finished file, at once.
 *
 * The name is taken from the query and checked against what is actually in the backup folder,
 * because a file name that arrives from outside is not a path anybody should be allowed to
 * assemble — "../../.env" is a file name too.
 */
export async function GET(req: NextRequest) {
  const user = await requireManager();
  const wanted = req.nextUrl.searchParams.get("file") ?? "";
  const status = await backupStatus();
  const dir = path.resolve(status.destination);

  const held = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) =>
    /^pharmacy-copy-for-claude-.*\.zip$/.test(n),
  );
  // The newest, where none was named, so a plain link still does the obvious thing.
  const name = wanted ? held.find((n) => n === wanted) : [...held].sort().pop();
  if (!name) {
    return NextResponse.json(
      {
        error: wanted
          ? `There is no copy called ${wanted} in ${dir}.`
          : `No copy has been made yet. Settings, Backups, "Make a copy for Claude".`,
      },
      { status: 404 },
    );
  }

  const full = path.join(dir, name);
  const data = await fs.readFile(full);

  /*
   * The record of the download is written after it, not before it.
   *
   * Writing it first put a database write in front of ten megabytes of file, on a connection this
   * site serializes — so a copy still being made, or any other write holding the lock, delayed the
   * first byte until the browser gave up and said it could not download. The audit line is worth
   * having and worth nothing at all if it costs the file.
   */
  after(() =>
    audit({
      action: "backup.copy_for_claude_downloaded",
      userId: user.id,
      userName: user.name,
      details: `${name}, ${(data.length / 1_048_576).toFixed(1)} MB`,
    }),
  );

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Length": String(data.length),
      "Cache-Control": "no-store",
    },
  });
}
