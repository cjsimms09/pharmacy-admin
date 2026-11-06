import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { setSetting } from "@/lib/settings";
import { currentAppendix } from "@/lib/manual";
import { allSections } from "@/lib/manual-store";
import { todayIso, fmt, fmtLong } from "@/lib/dates";
import { PrintFrame } from "@/components/print";
import { Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manual appendix" };

/**
 * The half of the policy manual this site owns.
 *
 * The manual is a Word document on somebody's desktop; this is a running system. Editing the
 * first from the second is a losing game, and keeping two prose descriptions of the same
 * procedure identical by hand is how they quietly diverge until an inspector reads both.
 *
 * So the split is by ownership. The manual keeps everything a program cannot know — hours,
 * staffing, conduct, benefits, the premises. This site owns the procedures it actually performs
 * and the forms it actually produces, and prints them here as an appendix the manual incorporates
 * by reference. The manual then says "the current version of these is Appendix A, maintained in
 * the Pharmacy Admin desk" and stops trying to describe them.
 *
 * The version at the top is a hash of what is on this page. Record which version went into the
 * filed manual and the site will say, without being asked, when the filed copy has fallen behind —
 * which is the only thing that actually keeps two documents in step. Not discipline. Something
 * that notices.
 */
export default async function ManualAppendixPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string }>;
}) {
  const user = await requireUser();
  const { ok } = await searchParams;
  const a = await currentAppendix();
  const inSite = (await allSections()).some((x) => x.source === "pharmacy");
  const stale = a.filedVersion !== null && a.filedVersion !== a.version;

  async function markFiled() {
    "use server";
    const u = await requireManager();
    const cur = await currentAppendix();
    await setSetting("manual_appendix_filed_version", cur.version);
    await setSetting("manual_appendix_filed_on", todayIso());
    await audit({ action: "manual.appendix.filed", userId: u.id, userName: u.name, details: cur.version });
    revalidatePath("/documents/manual");
    revalidatePath("/inspection");
    redirect("/documents/manual?ok=" + encodeURIComponent(`Recorded as version ${cur.version}, filed today.`));
  }

  return (
    <PrintFrame
      ownDocument
      formTitle={`Appendix A — forms and procedures maintained in the Pharmacy Admin desk (${a.version})`}
      formNumber=""
      revised=""
      backHref="/documents"
    >
      <div className="no-print mb-4 space-y-3">
        {ok && <Notice kind="ok">{ok}</Notice>}
        {inSite && (
          <Notice kind="ok">
            The whole manual now lives in this site, at <Link href="/manual" className="underline">P&amp;P manual</Link>,
            and <Link href="/manual/print" className="underline">prints as one document</Link> with this appendix inside
            it. This page is still here for the appendix on its own — for slotting into a paper manual somebody keeps
            elsewhere. If the manual in the site is the only one you keep, there is nothing on this page you need to do.
          </Notice>
        )}
        {a.filedVersion === null ? (
          <Notice kind="warn">
            The filed manual has never been matched to a version of this appendix. Print this, put it in the manual,
            then press the button below — after that the site will tell you when it has fallen behind.
          </Notice>
        ) : stale ? (
          <Notice kind="crit">
            The manual on file carries version <b>{a.filedVersion}</b>, filed {fmt(a.filedOn)}. This appendix is now
            version <b>{a.version}</b> — something here has changed since. Print it, replace Appendix A in the manual,
            and record it below.
          </Notice>
        ) : (
          <Notice kind="ok">
            The filed manual carries version {a.filedVersion}, which is current. Filed {fmt(a.filedOn)}.
          </Notice>
        )}
        <form action={markFiled}>
          <button className="btn btn-primary">I have put version {a.version} in the manual</button>
        </form>
        <p className="text-xs text-ink-3">
          Put a single line in the body of the manual wherever a procedure below is described:{" "}
          <i>
            &ldquo;The current version of this procedure, and the form it produces, is maintained in the Pharmacy Admin
            desk and reproduced at Appendix A.&rdquo;
          </i>{" "}
          Then delete the description that used to be there. Two descriptions of one procedure is how they diverge.
        </p>
      </div>

      <div className="mb-4">
        <p className="text-lg font-bold">{a.pharmacy}</p>
        <p className="text-xs">
          Appendix A to the Policy and Procedure Manual · version <b>{a.version}</b> · printed {fmtLong(todayIso())} by{" "}
          {user.name}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed">
          This appendix records the procedures {a.pharmacy} performs through its compliance system, and the forms that
          system produces. It is maintained in that system rather than in the body of this manual, so that the manual
          and the practice cannot drift apart. Where the body of the manual refers to one of these procedures, this
          appendix is the current version of it.
        </p>
      </div>

      {/* ── Procedures ── */}
      <div className="mb-1 text-sm font-bold">A.1 — PROCEDURES</div>
      {a.policies.map((p, i) => (
        <div key={p.key} className="print-block mb-3 border border-black">
          <div className="border-b border-black bg-neutral-200 px-2 py-1 text-[11px] font-bold">
            A.1.{i + 1} {p.title}
          </div>
          <div className="px-2 py-1.5">
            {p.text.map((t) => (
              <p key={t} className="mb-1 text-[11px] leading-relaxed">{t}</p>
            ))}
            <p className="mt-1 text-[10px] text-neutral-700">{p.authority}</p>
          </div>
        </div>
      ))}

      {/* ── Forms ── */}
      <div className="mb-1 mt-6 text-sm font-bold">A.2 — FORMS</div>
      <p className="mb-2 text-[10px]">
        Each form below is produced by the compliance system and printed on demand. The system holds the current
        version; no blank copy is reproduced here, because a blank copy in a manual is the version that goes out of
        date first and is the one somebody photocopies.
      </p>
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="border border-black px-2 py-1 text-left">Form</th>
            <th className="border border-black px-2 py-1 text-left">What it is for</th>
            <th className="border border-black px-2 py-1 text-left">When it is produced</th>
          </tr>
        </thead>
        <tbody>
          {a.forms.map((f) => (
            <tr key={f.name} className="print-block">
              <td className="border border-black px-2 py-1 align-top font-medium">
                {f.name}
                <span className="no-print">
                  {" — "}
                  <Link href={f.href} className="underline">open</Link>
                </span>
              </td>
              <td className="border border-black px-2 py-1 align-top">{f.purpose}</td>
              <td className="border border-black px-2 py-1 align-top">{f.cadence}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="print-signature mt-6">
        <p className="text-xs">
          This appendix, version {a.version}, is the current version and forms part of the Policy and Procedure Manual
          of {a.pharmacy}.
        </p>
        <p className="mt-4 text-xs">
          Pharmacist-in-charge: ______________________________ Date: ______________
        </p>
      </div>
    </PrintFrame>
  );
}
