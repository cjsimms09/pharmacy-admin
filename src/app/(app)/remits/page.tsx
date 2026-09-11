import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { PageHeader, Notice, Card } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { GetRemits } from "@/components/get-remits";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";
import { monthLabel } from "@/lib/deliveries";

export const metadata = { title: "Remittances" };
export const dynamic = "force-dynamic";

/**
 * Getting the 835s in, with as little of the owner's time as it can be done in.
 *
 * The owner: "It would be nice to have a button I can push that pulls up site with 835s in a claude
 * window, just has be login then pulls all the 835s for that month into the folder I have set", and
 * then: "the 835 search needs to know what month of remits we are after and needs to know that you
 * have to download each one individually. design this with least amount of work from me as
 * possible."
 *
 * ── What this page can and cannot do ──
 *
 * It cannot drive his browser. This runs as a server; the portal wants a login and a click per
 * remittance, and no amount of wanting makes a Next.js route able to press a button in Chrome.
 *
 * What it can do is remove every other decision from the job, so the only thing left is the part
 * that genuinely needs him:
 *
 *   it says which month     worked out from what is already in, not asked. He never has to hold a
 *                           date in his head or check what was done last time.
 *   it says where they go   one folder, named on the page, which his browser can be pointed at once
 *                           and then forgotten. Whatever the portal calls the files, they are read
 *                           by their contents.
 *   it reads them           one press, and every 835 in the folder is matched to its claims. Files
 *                           already read are moved aside, so pressing it twice is harmless.
 *
 * The download itself is one login and then a click per remittance — which is the portal's design,
 * not ours, and is the part a person or a browser session has to do.
 */
const PORTAL = "https://providerpay.ah.mckesson.com/providerpay/remittances";

/** The folder his browser downloads into, which is the same one the reader watches. */
function downloadFolder(): string {
  const path = require("node:path") as typeof import("node:path");
  const base = path.dirname(path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
  return path.join(base, "remittances");
}

export default async function RemitsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireManager();
  const { ok, error } = await searchParams;

  const { db, schema } = await import("@/db");
  const { and, gte, lte } = await import("drizzle-orm");
  const today = todayIso();

  /*
   * Which month to ask for, decided rather than asked.
   *
   * The one just finished, unless its remittances are already in — in which case the month running
   * now, which can be topped up as it goes. A page that asks "which month?" has moved the work
   * back onto him, which is the opposite of what this is for.
   */
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const thisMonth = today.slice(0, 7);

  const countFor = async (month: string) => {
    const rows = await db.query.claimPayments.findMany({
      where: and(gte(schema.claimPayments.receivedOn, `${month}-01`), lte(schema.claimPayments.receivedOn, `${month}-31`)),
      columns: { amountCents: true, claimId: true, source: true },
    });
    const fromRemits = rows.filter((r) => r.source !== "mtf");
    return {
      payments: fromRemits.length,
      cents: fromRemits.reduce((n, r) => n + r.amountCents, 0),
      matched: fromRemits.filter((r) => r.claimId).length,
    };
  };
  const last = await countFor(lastMonth);
  const now = await countFor(thisMonth);
  /* The month still to fetch: the finished one if it is empty, otherwise the one in progress. */
  const wanted = last.payments === 0 ? lastMonth : thisMonth;
  const wantedHas = wanted === lastMonth ? last : now;
  const folder = downloadFolder();

  /*
   * Taking the files through the browser, because the folder is on a different machine.
   *
   * The owner: "I just realized I am on a different computer than where the repo is stored.. how
   * do I have dowloads go into site directly??"
   *
   * A watched folder only works on the machine the site runs on, and he is not always at it. This
   * is the route that does not care: the site is a web page, so the files go up it from whatever
   * computer he downloaded them on. Several at once, because the portal makes him download them
   * one at a time and asking him to upload them one at a time as well would be absurd.
   *
   * The same reader either way — a remittance is known by its own segments, so a file that came
   * up the wire and one that appeared in the folder are read identically and neither can be
   * taken twice.
   */
  /*
   * Everything the month needs, in one upload, each file routed by what it actually is.
   *
   * The owner: "the fetch remit button might as well got fetch all payments and the wells fargo
   * report as well... I can teach it how to do each of these the first time but then I would like to
   * just hit the button, it to do everything and we me just upload the things it downloaded. system
   * should allow me to upload all at once."
   *
   * So this takes the whole month's download in one go — 835s, the ProviderPay payment report, the
   * account history, in any mixture and in any order, zipped or not — and asks each file what it is
   * rather than being told. `classify` is the same reader the mailbox uses on an attachment, so a
   * file that arrives by email and the same file dragged in here are treated identically.
   *
   * Anything it cannot place is still filed as a document and named in the result, because a file he
   * uploaded and heard nothing about is the one thing worse than a file he has to upload twice.
   */
  async function uploadThem(fd: FormData) {
    "use server";
    const u = await requireManager();
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) redirect("/remits?error=" + encodeURIComponent("Choose the files first."));

    const { importRemittance } = await import("@/lib/claim-payments");
    const { importPayerPayments } = await import("@/lib/payer-payments-store");
    const { readZip } = await import("@/lib/zip-read");
    const { classify } = await import("@/lib/autoroute");
    const { storeFile } = await import("@/lib/files");
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/crypto");

    const done: string[] = [];
    const problems: string[] = [];
    let remits = 0;
    let remitPayments = 0;
    let remitCents = 0;
    let matched = 0;

    /* A zip is one level of wrapping, not a kind of file. Opened here so each entry is judged alone. */
    const parts: { name: string; buf: Buffer; file: File }[] = [];
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      if (/.zip$/i.test(file.name) || buf.subarray(0, 2).toString("latin1") === "PK") {
        for (const e of readZip(buf)) {
          if (e.data.length === 0 || e.name.endsWith("/")) continue;
          parts.push({ name: e.name.split("/").pop() ?? e.name, buf: e.data, file });
        }
      } else parts.push({ name: file.name, buf, file });
    }

    for (const part of parts) {
      try {
        const text = part.buf.toString("utf8");
        /* A remittance is known by its own claim segments, whatever it is called. */
        if (/CLP/.test(text)) {
          const r = await importRemittance(text, part.name, u);
          remits++;
          remitPayments += r.payments;
          remitCents += r.amountCents;
          matched += r.matched;
          problems.push(...r.problems);
          done.push(`${part.name}: remittance`);
          continue;
        }
        const kind = classify(part.name, part.buf);
        if (kind.kind === "payer_payments") {
          const r = await importPayerPayments(text, { userId: u.id, userName: u.name, fileName: part.name });
          done.push(
            r.ok
              ? `${part.name}: ${r.banked} payment${r.banked === 1 ? "" : "s"} banked${r.alreadyHeld ? `, ${r.alreadyHeld} already held` : ""}`
              : `${part.name}: ${r.why}`,
          );
          continue;
        }
        /*
         * Everything else is kept as a document rather than refused.
         *
         * The ProviderPay account history is the case in point: nothing reads it yet, and it is still
         * the thing that proves the deposits on the bank statement are the payments on the report.
         * Filed, named, and on the month's checklist as done.
         */
        const stored = await storeFile(part.file, { allowReportTypes: true });
        await db.insert(schema.documents).values({
          id: newId(),
          category: "report",
          title: part.name,
          fileName: part.name,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageKey: stored.storageKey,
          effectiveOn: todayIso(),
          uploadedBy: u.id,
        });
        done.push(`${part.name}: filed as a document (${kind.kind === "unrecognised" ? "nothing reads it yet" : kind.kind})`);
      } catch (e) {
        problems.push(`${part.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await audit({ action: "remits.upload", userId: u.id, userName: u.name, details: `${parts.length} files: ${done.join("; ")}` });
    for (const path of ["/remits", "/claims", "/payers/performance", "/money"]) revalidatePath(path);
    redirect(
      "/remits?" +
        new URLSearchParams(
          done.length === 0
            ? { error: `Nothing could be read from ${parts.length} file${parts.length === 1 ? "" : "s"}. ${problems.slice(0, 2).join(" ")}` }
            : {
                ok:
                  (remits > 0
                    ? `${remits} remittance${remits === 1 ? "" : "s"}: ${remitPayments} payment${remitPayments === 1 ? "" : "s"} worth ${formatCents(remitCents)}, ${matched} matched to a claim. `
                    : "") + done.join("; ") + (problems.length ? ` ${problems.slice(0, 2).join(" ")}` : ""),
              },
        ).toString(),
    );
  }
  async function readThem() {
    "use server";
    const u = await requireManager();
    const { sweepRemittances } = await import("@/lib/claim-payments");
    const r = await sweepRemittances(u);
    await audit({ action: "remits.read", userId: u.id, userName: u.name, details: `${r.read} files, ${r.payments} payments, ${r.amountCents}c` });
    for (const p of ["/remits", "/claims", "/payers/performance", "/money"]) revalidatePath(p);
    redirect(
      "/remits?" +
        new URLSearchParams(
          r.files === 0
            ? { error: `Nothing is in ${downloadFolder()} yet. Download the month's remittances into it and press this again.` }
            : {
                ok:
                  `${r.read} remittance${r.read === 1 ? "" : "s"} read from ${r.files} file${r.files === 1 ? "" : "s"}: ` +
                  `${r.payments} payment${r.payments === 1 ? "" : "s"} worth ${formatCents(r.amountCents)}, ` +
                  `${r.matched} matched to a claim and ${r.unmatched} held.` +
                  (r.problems.length ? ` ${r.problems.slice(0, 3).join(" ")}` : ""),
              },
        ).toString(),
    );
  }

  return (
    <>
      <PageHeader
        title="Remittances"
        subtitle="The 835s: what each payer actually decided to pay, claim by claim. The only thing that explains a deposit down to the prescription that earned it."
      />
      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="warn">{error}</Notice>}

      {/*
        Lead with the one thing to do, and the month already decided.

        Not a form asking which month, not a list of every month: the next thing, named, with the
        button beside it.
      */}
      <Card
        tone={wantedHas.payments === 0 ? "warn" : "ok"}
        title={`Get ${monthLabel(wanted)}'s remittances and reports`}
        className="mt-4"
        subtitle="One press, one sign-in, one upload — and the month is in."
      >
        <ol className="ml-4 list-decimal space-y-3 text-sm">
          <li>
            <b>Press this, then paste it into Claude.</b> It copies the request with the month already
            in it. Claude opens the portal in a tab it can actually drive, you sign in there, and the clicking through every remittance is done for you.
            <div className="mt-2">
              <GetRemits portal={PORTAL} month={monthLabel(wanted)} folder={folder} />
            </div>
            <div className="mt-2 text-xs text-ink-3">
              The portal has no bulk download — each remittance is its own click, which is its design and not a setting anybody
              can change here. That is exactly the part worth handing to Claude.
            </div>
          </li>
          <li>
            <b>Download them into this folder</b>, which is where the reader looks:
            <div className="mt-1 overflow-x-auto">
              <code className="inline-block whitespace-nowrap rounded bg-surface-sunk px-2 py-1 text-xs">{folder}</code>
            </div>
            <div className="mt-1 text-xs text-ink-3">
              Set it once as your browser&rsquo;s download folder and this step disappears. The names do not matter — every file
              is read by what is inside it, and a zip is opened rather than refused.
            </div>
            <div className="mt-3 rounded-lg border border-line bg-surface-sunk p-3">
              <div className="text-xs font-semibold">On a different computer?</div>
              <p className="mt-1 text-xs text-ink-3">
                That folder only exists on the machine the site runs on. From anywhere else, send them up here instead — pick
                as many as you like at once, or the zip if the portal gives you one.
              </p>
              <form action={uploadThem} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="file" name="files" multiple className="text-sm" />
                <SubmitButton className="btn" pendingLabel="Reading…">Send them up</SubmitButton>
              </form>
            </div>
          </li>
          <li>
            <b>Press this.</b> Every 835 in the folder is read and matched to its claims; anything already read is skipped, so
            pressing it twice is harmless.
            <form action={readThem} className="mt-2">
              <SubmitButton className="btn btn-primary" pendingLabel="Reading…">Read the folder now</SubmitButton>
            </form>
          </li>
        </ol>
      </Card>

      <Card className="mt-4" title="What is in so far" subtitle="Counted by the day the money was received, which is the month a remittance belongs to.">
        <ul className="rows">
          {[
            { month: lastMonth, got: last },
            { month: thisMonth, got: now },
          ].map(({ month, got }) => (
            <li key={month} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
              <span className="text-sm font-medium">{monthLabel(month)}</span>
              <span className="text-sm">
                {got.payments === 0 ? (
                  <span className="text-ink-3">nothing yet</span>
                ) : (
                  <>
                    <span className="tabular-nums">{formatCents(got.cents)}</span> across {got.payments} payment
                    {got.payments === 1 ? "" : "s"}, {got.matched} matched to a claim
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-3">
          A remittance says what a payer decided, claim by claim — the adjustments, the fees, the recoupments. The ProviderPay
          payment report already ties each deposit to a payment; this is what takes it the rest of the way, down to the
          prescription.
        </p>
      </Card>
    </>
  );
}
